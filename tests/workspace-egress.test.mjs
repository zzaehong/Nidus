import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createTcpServer, connect } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EgressProxy, EgressRules, normalizeHost, ruleMatches } from '../dist/workspace/egress.js';

// Every "public" name resolves to a documentation address and every upstream
// connection is redirected to a local server, so nothing leaves the machine.
async function setup(t, options = {}) {
  const echo = createTcpServer(socket => { socket.on('data', data => socket.write(`echo:${data}`)); socket.on('error', () => {}); });
  const web = createHttpServer((req, res) => { res.setHeader('x-seen-host', req.headers.host); res.end(`${req.method} ${req.url} ${req.headers['proxy-connection'] ?? 'no-proxy-header'}`); });
  echo.listen(0, '127.0.0.1'); web.listen(0, '127.0.0.1');
  await Promise.all([once(echo, 'listening'), once(web, 'listening')]);

  const asked = [];
  const events = [];
  const connected = [];
  const proxy = new EgressProxy({
    rules: options.rules ?? EgressRules.empty(),
    approve: async (request, signal) => { asked.push(request.host); return options.answer ? options.answer(request, signal) : 'once'; },
    approvalTimeoutMs: options.approvalTimeoutMs,
    onEvent: event => events.push(`${event.host} ${event.outcome} ${event.reason}`),
    lookup: async host => options.lookup ? options.lookup(host) : [{ address: '93.184.216.34', family: 4 }],
    connect: (address, port) => { connected.push(`${address}:${port}`); return connect({ host: '127.0.0.1', port: port === 80 ? web.address().port : echo.address().port }); },
  });
  const port = await proxy.listen(0);
  t.after(async () => { await proxy.close(); echo.close(); web.closeAllConnections(); web.close(); });
  return { proxy, port, asked, events, connected };
}

// Opens a CONNECT tunnel and returns the status line plus, on success, an echo round trip.
function tunnel(port, target, payload = 'ping') {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let buffer = '';
    let established = false;
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', data => {
      buffer += data;
      if (!established && buffer.includes('\r\n\r\n')) {
        const head = buffer.slice(0, buffer.indexOf('\r\n\r\n'));
        const status = Number(head.split(' ')[1]);
        if (status !== 200) { socket.destroy(); resolve({ status, head }); return; }
        established = true; buffer = ''; socket.write(payload);
      } else if (established && buffer.startsWith('echo:')) { socket.destroy(); resolve({ status: 200, body: buffer }); }
    });
    socket.on('close', () => resolve({ status: 0, head: buffer }));
  });
}

function get(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host, ...headers } }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('host and rule matching', () => {
  assert.equal(normalizeHost('GitHub.com.'), 'github.com');
  assert.equal(normalizeHost('93.184.216.34'), '93.184.216.34');
  for (const bad of ['', 'a b', '[::1]', 'exa_mple.com', '-a.com', 'a..b', 'http://x']) assert.equal(normalizeHost(bad), null, bad);
  assert.equal(ruleMatches('example.com', 'example.com'), true);
  assert.equal(ruleMatches('example.com', 'api.example.com'), false);
  assert.equal(ruleMatches('*.example.com', 'api.example.com'), true);
  assert.equal(ruleMatches('*.example.com', 'example.com'), false);
  assert.equal(ruleMatches('*.example.com', 'badexample.com'), false);
});

test('a new domain is asked once for concurrent connections, then allowed for the task', async t => {
  const { port, asked, events, connected } = await setup(t);
  const results = await Promise.all([tunnel(port, 'example.com:443'), tunnel(port, 'example.com:443'), tunnel(port, 'example.com:8443', 'pong')]);
  assert.deepEqual(results.map(r => r.body), ['echo:ping', 'echo:ping', 'echo:pong']);
  assert.deepEqual(asked, ['example.com']);
  assert.equal((await tunnel(port, 'EXAMPLE.com:443')).status, 200);
  assert.deepEqual(asked, ['example.com'], 'no second question');
  assert.ok(connected.every(target => target.startsWith('93.184.216.34:')), 'connects to the address the host resolved');
  assert.ok(events.includes('example.com allowed user allowed for this task'));
  assert.ok(events.includes('example.com allowed allowed for this task'));
});

test('"always" is saved to network.json and honoured by the next proxy without asking', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-egress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'network.json');

  const first = await setup(t, { rules: await EgressRules.load(path), answer: async () => 'always' });
  assert.equal((await tunnel(first.port, 'registry.npmjs.org:443')).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, allow: ['registry.npmjs.org'], deny: [] });

  const second = await setup(t, { rules: await EgressRules.load(path), answer: async () => 'deny' });
  assert.equal((await tunnel(second.port, 'registry.npmjs.org:443')).status, 200);
  assert.deepEqual(second.asked, []);
  assert.ok(second.events.includes('registry.npmjs.org allowed allow rule'));
});

test('denials: user refusal is remembered for the task, deny rules beat allow rules, bad rule files are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-egress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'network.json');
  await writeFile(path, JSON.stringify({ version: 1, allow: ['*.example.com'], deny: ['tracker.example.com'] }));

  const { proxy, port, asked, events } = await setup(t, { rules: await EgressRules.load(path), answer: async () => 'deny' });
  assert.equal((await tunnel(port, 'api.example.com:443')).status, 200);
  const ruled = await tunnel(port, 'tracker.example.com:443');
  assert.equal(ruled.status, 403);
  assert.match(ruled.head, /X-Nidus-Egress: Blocked by Nidus \(deny rule\)/);

  assert.equal((await tunnel(port, 'other.org:443')).status, 403);
  assert.equal((await tunnel(port, 'other.org:443')).status, 403);
  assert.deepEqual(asked, ['other.org'], 'a refusal is not asked again in the same task');
  assert.ok(events.includes('other.org denied denied for this task'));

  proxy.resetSession();
  await tunnel(port, 'other.org:443');
  assert.deepEqual(asked, ['other.org', 'other.org'], 'a new task asks again');

  for (const bad of ['{"version":2}', '{"version":1,"allow":["Bad Host"]}', '{"version":1,"allow":"x"}', 'nope']) {
    await writeFile(path, bad);
    await assert.rejects(EgressRules.load(path), { code: 'invalid_request' }, bad);
  }
});

test('local names and non-public addresses are blocked without asking, even with all domains allowed', async t => {
  const { proxy, port, asked, events } = await setup(t, { lookup: async host => host === 'rebind.example.com'
    ? [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.10', family: 4 }]
    : host === 'v6only.example.com' ? [{ address: '2001:db8::1', family: 6 }] : [{ address: '93.184.216.34', family: 4 }] });
  proxy.setAllowAll(true);

  for (const target of ['localhost:80', 'mac.local:22', 'db.internal:5432', '127.0.0.1:8080', '192.168.1.1:443', '10.0.0.5:443', '169.254.169.254:80'])
    assert.equal((await tunnel(port, target)).status, 403, target);
  assert.equal((await tunnel(port, 'rebind.example.com:443')).status, 502, 'a name that also resolves to a private address');
  assert.equal((await tunnel(port, 'v6only.example.com:443')).status, 502);
  assert.equal((await tunnel(port, 'bad_host:443')).status, 400);
  assert.equal((await tunnel(port, 'example.com:99999')).status, 400);

  assert.equal((await tunnel(port, 'anything.example.org:443')).status, 200, 'all-domains mode still reaches public sites');
  assert.deepEqual(asked, []);
  assert.ok(events.includes('localhost blocked local name'));
  assert.ok(events.includes('192.168.1.1 blocked private address'));
  assert.ok(events.includes('rebind.example.com blocked name did not resolve to a public address'));
});

test('an unanswered approval times out as a refusal but is asked again next time', async t => {
  let answer = () => new Promise(() => {});
  const { port, asked } = await setup(t, { approvalTimeoutMs: 50, answer: (request, signal) => answer(request, signal) });
  assert.equal((await tunnel(port, 'slow.example.com:443')).status, 403);
  answer = async () => 'once';
  assert.equal((await tunnel(port, 'slow.example.com:443')).status, 200);
  assert.deepEqual(asked, ['slow.example.com', 'slow.example.com']);
});

test('plain HTTP is forwarded with the original Host and without proxy headers; other forms are refused', async t => {
  const { port, asked } = await setup(t);
  const ok = await get(port, 'http://example.com/path?q=1', { 'proxy-connection': 'keep-alive' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'GET /path?q=1 no-proxy-header');
  assert.equal(ok.headers['x-seen-host'], 'example.com');
  assert.deepEqual(asked, ['example.com']);

  const local = await get(port, 'http://localhost/admin');
  assert.equal(local.status, 403);
  assert.match(local.headers['x-nidus-egress'], /local name/);
  const relative = await new Promise(resolve => { const req = httpRequest({ host: '127.0.0.1', port, path: '/relative' }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
  assert.equal(relative, 400);
});
