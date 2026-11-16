// Chrome DevTools Protocol client over one byte stream (Chromium's --remote-debugging-pipe
// framing: JSON messages separated by NUL). In the workspace the stream is the "browser"
// service of the egress link, bridged in the guest to Chromium's pipe.
//
// Everything that arrives here comes from inside the VM and is treated as untrusted:
// message size is bounded and malformed input closes the link.
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

export const MAX_MESSAGE = 16 * 1024 * 1024;

export class CDPError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

export interface CDPEvent { method: string; params: any; sessionId?: string }

export class CDPClient extends EventEmitter {
  private sequence = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closedReason: string | undefined;

  constructor(private readonly link: Duplex, private readonly timeoutMs = 30_000) {
    super();
    link.on('data', (chunk: Buffer) => this.receive(chunk));
    link.on('error', () => this.close('link error'));
    link.on('close', () => this.close('link closed'));
    link.on('end', () => this.close('link ended'));
  }

  get closed(): boolean { return this.closedReason !== undefined; }

  call<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closedReason) return Promise.reject(new CDPError('browser_closed', this.closedReason));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CDPError('browser_cdp_timeout', method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.link.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  close(reason = 'closed'): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CDPError('browser_closed', reason)); }
    this.pending.clear();
    this.link.destroy();
    this.emit('close', reason);
  }

  private receive(chunk: Buffer): void {
    if (this.closedReason) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let message: any;
      try { message = JSON.parse(raw.toString('utf8')); } catch { this.close('protocol error'); return; }
      if (!message || typeof message !== 'object') { this.close('protocol error'); return; }
      if (typeof message.id === 'number') {
        const p = this.pending.get(message.id);
        if (!p) continue;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new CDPError('browser_cdp_error', String(message.error.message ?? 'error')));
        else p.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        this.emit('event', { method: message.method, params: message.params ?? {}, sessionId: message.sessionId } satisfies CDPEvent);
      }
    }
    if (this.buffer.length > MAX_MESSAGE) this.close('message too large');
  }
}
