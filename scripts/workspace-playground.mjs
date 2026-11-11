// Hands-on test page for the stage-2 workspace, until the app's Work tab exists (2f).
// Boots the real VM, opens its browser and serves a control page on this Mac:
// live screen, take over / hand back, mouse and keyboard, network approvals,
// AI actions sent by hand, and Shell commands in the VM.
//
// Usage: npm run build && node scripts/workspace-playground.mjs [port]
// Then open the printed URL. Ctrl+C stops the VM.
//
// The page listens on 127.0.0.1 only and requires the random token in its URL. Its port is
// reserved in the Egress Proxy, so nothing inside the VM can reach it through host.nidus.
// State kept between runs (dist/playground): approved sites ("always") and the browser profile disk.
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, realpath, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppleOfflineBackend } from '../dist/vault/apple-backend.js';
import { CacheDiskStore } from '../dist/vault/cache-disk.js';
import { EgressProxy, EgressRules } from '../dist/workspace/egress.js';
import { CDPClient } from '../dist/workspace/cdp.js';
import { WorkspaceBrowser } from '../dist/workspace/browser.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const state = join(root, 'dist/playground');
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const port = Number(process.argv[2] ?? 4791);
const token = randomBytes(16).toString('hex');
const page = await readFile(fileURLToPath(new URL('./workspace-playground.html', import.meta.url)), 'utf8');

// --- events to the page (Server-Sent Events) ---------------------------------
const clients = new Set();
const send = (type, data) => { const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(line); };
const log = (text) => { console.log(text); send('log', { at: new Date().toLocaleTimeString('ko-KR'), text }); };

// --- network approvals answered on the page -----------------------------------
const approvals = new Map();
const rules = await EgressRules.load(join(state, 'network.json'));
const proxy = new EgressProxy({
  rules,
  reservedMacPorts: [port],
  approve: (request, signal) => new Promise(resolve => {
    const id = randomUUID();
    approvals.set(id, resolve);
    signal.addEventListener('abort', () => { approvals.delete(id); send('approval-done', { id }); resolve('deny'); }, { once: true });
    send('approval', { id, ...request });
    log(`승인 요청: ${request.target === 'mac' ? `Mac 포트 ${request.port}` : request.host}`);
  }),
  onEvent: e => send('network', e),
});

// --- VM and browser ------------------------------------------------------------
const disks = new CacheDiskStore(join(await realpath(state), 'disks'));
// Fixed ids: the same disk (and browser profile) is used on every run.
const vaultId = '00000000-0000-4000-8000-00000000a11c', environmentId = '00000000-0000-4000-8000-0000000b0a7d';
let backend, disk, browser, ready = false;

async function start() {
  log('VM을 시작합니다…');
  disk = await disks.acquire(vaultId, environmentId).catch(async error => {
    if (/cache_dirty/.test(error.message)) {
      log('지난 실행이 정상 종료되지 않아 디스크가 dirty 상태입니다. 새 디스크로 시작합니다(브라우저 프로필 초기화).');
      await disks.clear(vaultId, environmentId).catch(() => {});
      return disks.acquire(vaultId, environmentId);
    }
    throw error;
  });
  backend = new AppleOfflineBackend(join(root, 'dist/vm-assets'), proxy);
  await backend.start(disk);
  log('VM 준비. 브라우저를 엽니다…');
  await openBrowser();
}

async function openBrowser() {
  browser = new WorkspaceBrowser(new CDPClient(await backend.openBrowser(86400)), { maxFps: 15 });
  browser.on('frame', f => send('frame', { data: f.data, width: f.width, height: f.height }));
  browser.on('control', c => { send('control', c); log(`제어권: ${c.control === 'user' ? '사용자' : 'AI'}${c.reason ? ` (${c.reason})` : ''}`); });
  browser.on('tabs', tabs => send('tabs', tabs));
  browser.on('closed', reason => { ready = false; send('status', { ready, text: `브라우저 종료: ${reason}` }); });
  await browser.start();
  ready = true;
  send('status', { ready, text: '실행 중' });
  send('tabs', browser.listTabs());
  send('control', { control: browser.control, reason: browser.reason });
  log('브라우저 준비 완료');
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log('정리하는 중…');
  try { await browser?.close(); await backend?.closeBrowser(); } catch (error) { console.error('browser cleanup:', error.message); }
  try { await backend?.stop(); if (disk) await disks.release(disk.diskId, backend.cacheClean); console.log('VM 종료 확인 (STOP_CONFIRMED)'); }
  catch (error) { console.error('VM 종료 확인 실패:', error.message); }
  await proxy.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// --- control page ---------------------------------------------------------------
const body = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 1_000_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
});

const routes = {
  async input(m) { await browser.input(m); return {}; },
  async takeOver() { browser.takeOver('사용자 개입'); return {}; },
  async handBack() { browser.handBack(); return {}; },
  async act(m) { return browser.act(m); },
  async answer(m) {
    const resolve = approvals.get(m.id);
    if (resolve && ['once', 'always', 'deny'].includes(m.answer)) { approvals.delete(m.id); resolve(m.answer); send('approval-done', { id: m.id }); }
    return {};
  },
  async allowAll(m) { proxy.setAllowAll(!!m.enabled); log(`모두 허용: ${m.enabled ? '켬' : '끔'}`); return {}; },
  async shell(m) {
    if (typeof m.command !== 'string' || !m.command.trim()) throw new Error('명령이 비어 있습니다');
    log(`Shell: ${m.command}`);
    return backend.execute(randomUUID(), m.command, Math.min(120, Math.max(1, Number(m.seconds) || 60)), { profile: 'shell' });
  },
  async restartBrowser() { await browser.close(); await backend.closeBrowser(); await openBrowser(); return {}; },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.searchParams.get('token') !== token && req.headers['x-token'] !== token) { res.writeHead(403).end('token required'); return; }
  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page.replace('__TOKEN__', token)); return; }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    res.write(`event: status\ndata: ${JSON.stringify({ ready, text: ready ? '실행 중' : '시작 중…' })}\n\n`);
    if (browser && ready) { res.write(`event: tabs\ndata: ${JSON.stringify(browser.listTabs())}\n\n`); res.write(`event: control\ndata: ${JSON.stringify({ control: browser.control, reason: browser.reason })}\n\n`); }
    return;
  }
  const route = req.method === 'POST' && routes[url.pathname.slice(1)];
  if (!route) { res.writeHead(404).end(); return; }
  try {
    if (!ready && !['answer', 'allowAll'].includes(url.pathname.slice(1))) throw new Error('아직 준비되지 않았습니다');
    const result = await route(await body(req));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? {}));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`\n테스트 페이지: http://127.0.0.1:${port}/?token=${token}\n(종료: Ctrl+C)\n`));

start().catch(error => { log(`시작 실패: ${error.message}`); console.error(error); });
