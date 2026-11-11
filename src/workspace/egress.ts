// Egress Proxy: the only way out of the Workspace VM.
// See docs/architecture/STAGE2_AGENT_WORKSPACE.md ("네트워크").
//
// Decisions are made per domain, on the host. HTTPS is tunnelled (CONNECT) and never
// opened. "localhost" reaching the proxy means the user's Mac (the VM's own localhost
// never comes here); it needs approval per port. Other local names and non-public
// addresses are refused whatever the rules say.
import { lookup as dnsLookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { NidusError } from '../errors.js';
import { publicIPv4 } from '../vault/network-policy.js';

/** The user's answer to "may the workspace reach this domain?" */
export type EgressAnswer = 'once' | 'always' | 'deny';

export interface EgressRequest {
  /** internet: a public domain. mac: a service listening on the user's Mac (localhost). */
  target: 'internet' | 'mac';
  host: string;
  port: number;
}

export interface EgressEvent {
  at: string;
  host: string;
  port: number;
  outcome: 'allowed' | 'denied' | 'blocked' | 'failed';
  /** Why: rule, session, approval, local name, private address, and so on. */
  reason: string;
}

const hostPattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const localNames = /(^|\.)(local|internal|lan|home\.arpa|localdomain)$/;

/** localhost or 127.0.0.0/8: from the proxy's side this is the user's Mac. */
export function isMacLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) === 4 && host.startsWith('127.'));
}

/** Lower-cased host without a trailing dot, or null when it is not a plain DNS name or IPv4 address. */
export function normalizeHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(host) === 4) return host;
  return hostPattern.test(host) ? host : null;
}

/** "example.com" matches that host only; "*.example.com" matches its subdomains only. */
export function ruleMatches(rule: string, host: string): boolean {
  return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : rule === host;
}

function validPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

function validRule(rule: unknown): rule is string {
  return typeof rule === 'string' && normalizeHost(rule.startsWith('*.') ? rule.slice(2) : rule) !== null && rule === rule.toLowerCase();
}

/** Allow and deny lists kept in the vault's .nidus/network.json. */
export class EgressRules {
  private constructor(private readonly path: string | null, readonly allow: string[], readonly deny: string[], readonly macPorts: number[]) {}

  static empty(): EgressRules {
    return new EgressRules(null, [], [], []);
  }

  static async load(path: string): Promise<EgressRules> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new EgressRules(path, [], [], []);
      throw new NidusError('storage', 'Could not read .nidus/network.json.');
    }
    try {
      const raw = JSON.parse(text) as { version?: unknown; allow?: unknown; deny?: unknown; macPorts?: unknown };
      const allow = raw.allow ?? [];
      const deny = raw.deny ?? [];
      const macPorts = raw.macPorts ?? [];
      if (raw.version !== 1 || !Array.isArray(allow) || !Array.isArray(deny) || ![...allow, ...deny].every(validRule)) throw new Error();
      if (!Array.isArray(macPorts) || !macPorts.every(validPort)) throw new Error();
      return new EgressRules(path, [...allow], [...deny], [...macPorts]);
    } catch {
      throw new NidusError('invalid_request', 'Invalid .nidus/network.json: expected { "version": 1, "allow": [domains], "deny": [domains], "macPorts": [ports] }.');
    }
  }

  verdict(host: string): 'allow' | 'deny' | 'unknown' {
    // Deny wins, so a broad allow rule can still carve out exceptions.
    if (this.deny.some(rule => ruleMatches(rule, host))) return 'deny';
    return this.allow.some(rule => ruleMatches(rule, host)) ? 'allow' : 'unknown';
  }

  macPortAllowed(port: number): boolean {
    return this.macPorts.includes(port);
  }

  async addAllow(host: string): Promise<void> {
    if (this.allow.includes(host)) return;
    this.allow.push(host);
    await this.save();
  }

  async addMacPort(port: number): Promise<void> {
    if (this.macPorts.includes(port)) return;
    this.macPorts.push(port);
    await this.save();
  }

  private async save(): Promise<void> {
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const body = { version: 1, allow: this.allow, deny: this.deny, ...(this.macPorts.length ? { macPorts: this.macPorts } : {}) };
      await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`);
      await rename(temporary, this.path);
    } catch {
      throw new NidusError('storage', 'Could not save .nidus/network.json.');
    }
  }
}

export interface EgressOptions {
  rules: EgressRules;
  /** Asks the user. Rejecting or timing out counts as "deny". */
  approve: (request: EgressRequest, signal: AbortSignal) => Promise<EgressAnswer>;
  approvalTimeoutMs?: number;
  /** Mac ports the workspace may never reach, such as Nidus's own services. The proxy's port is always included. */
  reservedMacPorts?: number[];
  onEvent?: (event: EgressEvent) => void;
  /** Test seams. */
  lookup?: typeof dnsLookup;
  connect?: (address: string, port: number) => Socket;
  now?: () => Date;
}

type Verdict = { allowed: true; reason: string } | { allowed: false; outcome: 'denied' | 'blocked'; reason: string };

export class EgressProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private readonly sessionAllowed = new Set<string>();
  private readonly sessionDenied = new Set<string>();
  private readonly pending = new Map<string, Promise<EgressAnswer>>();
  private readonly closing = new AbortController();
  private allowAll = false;
  private ownPort = 0;

  constructor(private readonly options: EgressOptions) {
    this.server = createServer((request, response) => { void this.forwardHttp(request, response); });
    this.server.on('connect', (request, socket, head) => { void this.tunnel(request, socket, head); });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Listens on a loopback TCP port (0 picks one) or a Unix socket path. Returns the bound port, or 0 for a socket path. */
  listen(target: number | string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      const ready = () => {
        const address = this.server.address();
        this.ownPort = address && typeof address === 'object' ? address.port : 0;
        resolve(this.ownPort);
      };
      if (typeof target === 'number') this.server.listen(target, '127.0.0.1', ready);
      else this.server.listen(target, ready);
    });
  }

  async close(): Promise<void> {
    this.closing.abort();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** "Allow every domain for this task." Local names and private addresses stay blocked. */
  setAllowAll(enabled: boolean): void {
    this.allowAll = enabled;
  }

  /** Forgets per-task answers; called when a task ends. */
  resetSession(): void {
    this.sessionAllowed.clear();
    this.sessionDenied.clear();
    this.allowAll = false;
  }

  private emit(host: string, port: number, outcome: EgressEvent['outcome'], reason: string): void {
    this.options.onEvent?.({ at: (this.options.now ?? (() => new Date()))().toISOString(), host, port, outcome, reason });
  }

  /** Rule and approval check for a host. Does not touch the network. */
  async authorize(host: string, port: number): Promise<Verdict> {
    if (isMacLoopback(host)) return this.authorizeMac(port);
    if (localNames.test(host)) return { allowed: false, outcome: 'blocked', reason: 'local name' };
    if (isIP(host) === 4 && !publicIPv4(host)) return { allowed: false, outcome: 'blocked', reason: 'private address' };

    const rule = this.options.rules.verdict(host);
    if (rule === 'deny') return { allowed: false, outcome: 'denied', reason: 'deny rule' };
    if (rule === 'allow') return { allowed: true, reason: 'allow rule' };
    if (this.sessionAllowed.has(host)) return { allowed: true, reason: 'allowed for this task' };
    if (this.allowAll) return { allowed: true, reason: 'all domains allowed for this task' };
    if (this.sessionDenied.has(host)) return { allowed: false, outcome: 'denied', reason: 'denied for this task' };
    return this.decide(host, { target: 'internet', host, port });
  }

  /**
   * The user's Mac, one port at a time: its services are unrelated to each other
   * (a dev server, a database, another app's local API). "All domains" does not cover it.
   */
  private async authorizeMac(port: number): Promise<Verdict> {
    if (port === this.ownPort || this.options.reservedMacPorts?.includes(port)) return { allowed: false, outcome: 'blocked', reason: 'reserved Nidus port' };
    const key = `mac:${port}`;
    if (this.options.rules.macPortAllowed(port)) return { allowed: true, reason: 'Mac port allow rule' };
    if (this.sessionAllowed.has(key)) return { allowed: true, reason: 'Mac port allowed for this task' };
    if (this.sessionDenied.has(key)) return { allowed: false, outcome: 'denied', reason: 'Mac port denied for this task' };
    return this.decide(key, { target: 'mac', host: 'localhost', port });
  }

  private async decide(key: string, request: EgressRequest): Promise<Verdict> {
    // Many connections to a new site arrive at once; they share one question.
    let question = this.pending.get(key);
    if (!question) {
      question = this.ask(key, request).finally(() => this.pending.delete(key));
      this.pending.set(key, question);
    }
    const answer = await question;
    if (answer === 'deny') return { allowed: false, outcome: 'denied', reason: 'user denied' };
    return { allowed: true, reason: answer === 'always' ? 'user allowed for this vault' : 'user allowed for this task' };
  }

  private async ask(key: string, request: EgressRequest): Promise<EgressAnswer> {
    const timeout = AbortSignal.timeout(this.options.approvalTimeoutMs ?? 120_000);
    const signal = AbortSignal.any([timeout, this.closing.signal]);
    let answer: EgressAnswer = 'deny';
    try {
      answer = await Promise.race([
        this.options.approve(request, signal),
        new Promise<EgressAnswer>(resolve => signal.addEventListener('abort', () => resolve('deny'), { once: true })),
      ]);
    } catch {
      answer = 'deny';
    }
    if (answer === 'always') {
      // If the rule cannot be saved the answer still holds for this task.
      const save = request.target === 'mac' ? this.options.rules.addMacPort(request.port) : this.options.rules.addAllow(request.host);
      await save.catch(() => {});
      this.sessionAllowed.add(key);
    } else if (answer === 'once') {
      this.sessionAllowed.add(key);
    } else {
      answer = 'deny';
      // A timeout is not a decision: ask again next time instead of remembering a refusal.
      if (!signal.aborted) this.sessionDenied.add(key);
    }
    return answer;
  }

  /** Resolves on the host and returns one public IPv4 address; refuses if any answer is not public. */
  private async resolve(host: string): Promise<string | null> {
    // The Mac's own services; never looked up, so a name cannot be pointed elsewhere.
    if (isMacLoopback(host)) return '127.0.0.1';
    if (isIP(host) === 4) return host;
    try {
      const addresses = (await (this.options.lookup ?? dnsLookup)(host, { all: true, verbatim: true })).filter(entry => entry.family === 4);
      if (!addresses.length || addresses.some(entry => !publicIPv4(entry.address))) return null;
      return addresses[0]!.address;
    } catch {
      return null;
    }
  }

  /** Full check: target syntax, rules and approval, then DNS. */
  private async admit(rawHost: string, port: number): Promise<{ host: string; address: string } | { status: number; message: string }> {
    const host = normalizeHost(rawHost);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { status: 400, message: 'Invalid target.' };

    const verdict = await this.authorize(host, port);
    if (!verdict.allowed) {
      this.emit(host, port, verdict.outcome, verdict.reason);
      return { status: 403, message: `Blocked by Nidus (${verdict.reason}).` };
    }
    const address = await this.resolve(host);
    if (!address) {
      this.emit(host, port, 'blocked', 'name did not resolve to a public address');
      return { status: 502, message: 'Blocked by Nidus (name did not resolve to a public address).' };
    }
    this.emit(host, port, 'allowed', verdict.reason);
    return { host, address };
  }

  private upstream(address: string, port: number): Socket {
    return (this.options.connect ?? ((host, targetPort) => netConnect({ host, port: targetPort })))(address, port);
  }

  private async tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => {});
    const refuse = (status: number, message: string) => {
      client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Bad Gateway'}\r\nX-Nidus-Egress: ${message}\r\nConnection: close\r\n\r\n`);
    };
    const target = /^([^:\s]+):(\d{1,5})$/.exec(request.url ?? '');
    if (!target) { refuse(400, 'Invalid target.'); return; }
    const port = Number(target[2]);
    const admitted = await this.admit(target[1]!, port);
    if ('status' in admitted) { refuse(admitted.status, admitted.message); return; }
    if (client.destroyed) return;

    const server = this.upstream(admitted.address, port);
    this.sockets.add(server);
    server.on('close', () => { this.sockets.delete(server); client.destroy(); });
    client.on('close', () => server.destroy());
    server.once('error', () => {
      this.emit(admitted.host, port, 'failed', 'connection failed');
      if (!client.destroyed) refuse(502, 'Connection failed.');
    });
    server.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) server.write(head);
      server.pipe(client);
      client.pipe(server);
    });
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number, message: string) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-nidus-egress': message, connection: 'close' });
      response.end(`${message}\n`);
    };
    let url: URL;
    try {
      url = new URL(request.url ?? '');
      if (url.protocol !== 'http:') throw new Error();
    } catch {
      refuse(400, 'Only absolute http:// requests and CONNECT tunnels are supported.');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const admitted = await this.admit(url.hostname, port);
    if ('status' in admitted) { refuse(admitted.status, admitted.message); return; }

    // Hop-by-hop headers describe the client-to-proxy leg only.
    const headers = { ...request.headers };
    for (const name of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) delete headers[name];
    const outgoing = httpRequest({
      host: admitted.address, port, method: request.method, path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host },
      // No agent: with one, Node ignores createConnection and would dial the address itself.
      createConnection: () => this.upstream(admitted.address, port),
    }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    outgoing.on('error', () => {
      this.emit(admitted.host, port, 'failed', 'connection failed');
      if (!response.headersSent) refuse(502, 'Connection failed.');
      else response.destroy();
    });
    request.pipe(outgoing);
  }
}
