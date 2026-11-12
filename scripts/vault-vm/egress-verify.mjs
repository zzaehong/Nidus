// Real-VM check of stage 2b: the guest reaches the network only through the host Egress Proxy.
// Usage: node scripts/vault-vm/egress-verify.mjs <vm-assets-dir> <evidence.json>
// Approvals are answered by a fixed test policy below, not by a person.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppleOfflineBackend } from '../../dist/vault/apple-backend.js';
import { EgressProxy, EgressRules } from '../../dist/workspace/egress.js';

const [assets, output] = process.argv.slice(2);
if (!assets || !output) { console.error('usage: egress-verify.mjs <vm-assets-dir> <evidence.json>'); process.exit(2); }

const mac = createServer((_, res) => res.end('hello from the mac'));
mac.listen(0, '127.0.0.1'); await once(mac, 'listening');
const macPort = mac.address().port;

const allowed = new Set(['example.com', 'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', 'speed.cloudflare.com']);
const asked = [];
const events = [];
const proxy = new EgressProxy({
  rules: EgressRules.empty(),
  approve: async request => {
    const label = request.target === 'mac' ? `mac:${request.port}` : request.host;
    asked.push(label);
    return (request.target === 'mac' ? request.port === macPort : allowed.has(request.host)) ? 'once' : 'deny';
  },
  onEvent: event => events.push(`${event.outcome} ${event.host}:${event.port} (${event.reason})`),
});

const evidence = { at: new Date().toISOString(), scope: 'real Apple Virtualization VM; approvals answered by a fixed test policy', checks: [] };
const backend = new AppleOfflineBackend(assets, proxy);
const run = async (name, command, expect) => {
  const before = { asked: asked.length, events: events.length };
  const started = Date.now();
  let result;
  try { result = await backend.execute(randomUUID(), command, 110, { profile: 'shell' }); }
  catch (error) { result = { error: String(error.code ?? error.message) }; }
  const check = {
    name, command,
    stdout: (result.stdout ?? '').trim().slice(0, 600), stderr: (result.stderr ?? '').trim().slice(0, 400),
    exitCode: result.exitCode, cleanup: result.cleanupConfirmed, error: result.error,
    asked: asked.slice(before.asked), proxy: events.slice(before.events), ms: Date.now() - started,
  };
  check.pass = !result.error && expect(check);
  evidence.checks.push(check);
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${name} (${check.ms} ms)`);
  if (!check.pass) console.log(JSON.stringify(check, null, 1));
};

try {
  await backend.start();
  evidence.egressConnected = backend.egressConnected;
  await run('proxy settings in the shell', 'echo "$HTTPS_PROXY|$NO_PROXY"', c => c.stdout === 'http://127.0.0.1:3128|localhost,127.0.0.1,::1,.localhost');
  await run('public HTTPS after approval', "curl -sS -o /dev/null -w '%{http_code}' https://example.com/", c => c.stdout === '200' && c.asked.includes('example.com'));
  await run('same domain again is not asked', "curl -sS -o /dev/null -w '%{http_code}' https://example.com/", c => c.stdout === '200' && c.asked.length === 0);
  // curl reports a refused CONNECT as exit 7 or 56 depending on version; the 403 is what matters.
  await run('refused domain', "curl -sS -o /dev/null https://www.wikipedia.org/; echo \"exit=$?\"", c => /exit=(7|56)/.test(c.stdout) && /403/.test(c.stderr) && c.asked.includes('www.wikipedia.org'));
  await run('private address is blocked without asking', "curl -sS -m 10 -o /dev/null https://192.168.1.1/; echo \"exit=$?\"", c => /exit=(7|56)/.test(c.stdout) && /403/.test(c.stderr) && c.asked.length === 0 && c.proxy.some(line => line.startsWith('blocked 192.168.1.1')));
  await run('VM localhost stays inside the VM', "python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & for ((i=0; i<50; i++)); do curl -s -o /dev/null http://localhost:8765/ && break; sleep 0.2; done; curl -sS http://localhost:8765/ | head -c 400; kill %1",
    c => /Directory listing/.test(c.stdout) && c.proxy.length === 0);
  await run('Mac service through host.nidus after approval', `curl -sS http://host.nidus:${macPort}/`, c => c.stdout === 'hello from the mac' && c.asked.includes(`mac:${macPort}`));
  await run('pip download from PyPI', 'pip download --no-deps -q -d /tmp/p six==1.16.0 && ls /tmp/p', c => /six-1\.16\.0/.test(c.stdout));
  await run('npm registry', 'npm view left-pad version', c => /^\d+\.\d+\.\d+$/.test(c.stdout));
  await run('large download, 20 MB', "curl -sS -o /dev/null -w '%{size_download} %{speed_download}' 'https://speed.cloudflare.com/__down?bytes=20000000'",
    c => { const [size, speed] = c.stdout.split(' ').map(Number); c.mbPerSecond = Math.round(speed / 1e5) / 10; return size === 20000000; });
} catch (error) {
  evidence.fatal = String(error.code ?? error.message);
  console.log('FATAL', evidence.fatal);
} finally {
  try { await backend.stop(); evidence.stopped = 'STOP_CONFIRMED'; } catch (error) { evidence.stopped = String(error.code ?? error.message); }
  await proxy.close(); mac.close();
}
evidence.pass = !evidence.fatal && evidence.checks.length > 0 && evidence.checks.every(check => check.pass);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(evidence.pass ? 'ALL PASS' : 'NOT ALL PASS', '| stop:', evidence.stopped);
process.exit(evidence.pass ? 0 : 1);
