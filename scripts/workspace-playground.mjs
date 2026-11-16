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
import { readFile, writeFile, mkdir, realpath, chmod, rm, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppleOfflineBackend } from '../dist/vault/apple-backend.js';
import { CacheDiskStore } from '../dist/vault/cache-disk.js';
import { EgressProxy, EgressRules } from '../dist/workspace/egress.js';
import { CDPClient } from '../dist/workspace/cdp.js';
import { WorkspaceBrowser } from '../dist/workspace/browser.js';
import { snapshot, receive, approve, discard } from '../dist/workspace/sync.js';
import { homedir } from 'node:os';

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
    log(`승인 요청: ${request.target === 'mac' ? `Mac 포트 ${request.port}` : `${request.site} (${request.host})`}`);
  }),
  onEvent: e => send('network', e),
});

// --- VM and browser ------------------------------------------------------------
const disks = new CacheDiskStore(join(await realpath(state), 'disks'));
// Fixed ids: the same disk (and browser profile) is used on every run.
const vaultId = '00000000-0000-4000-8000-00000000a11c', environmentId = '00000000-0000-4000-8000-0000000b0a7d';
let backend, disk, browser, ready = false, workspace;
const workspaceFile = join(state, 'workspace.json');
const runFile = join(state, 'run.json');
const diskDir = join(await realpath(state), 'disks', `${vaultId}-${environmentId}`);

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
/** A previous run that died (terminal closed, crash) leaves the disk marked as owned.
 *  Reclaim it only when that run's process is gone and no VM is using the disk file. */
async function reclaimStaleDisk() {
  let previous;
  try { previous = JSON.parse(await readFile(runFile, 'utf8')); } catch { previous = undefined; }
  if (previous?.pid && previous.pid !== process.pid && alive(previous.pid)) throw new Error(`다른 테스트 페이지가 실행 중입니다 (PID ${previous.pid}). 그 터미널에서 Ctrl+C로 끝내 주세요.`);
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'command=']);
  if (stdout.split('\n').some(line => line.includes('nidus-vault-vm') && line.includes(diskDir))) throw new Error('이전 VM이 아직 이 디스크를 쓰고 있습니다. 잠시 뒤 다시 실행해 주세요.');
  try { await rmdir(join(diskDir, 'owner')); log('지난 실행이 디스크를 반납하지 못하고 끝났습니다. 소유 표시를 정리했습니다.'); } catch {}
}

async function start() {
  log('VM을 시작합니다…');
  await reclaimStaleDisk();
  await writeFile(runFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  disk = await disks.acquire(vaultId, environmentId).catch(async error => {
    if (/cache_dirty/.test(error.message)) {
      // Not cleanly unmounted: the file system may be inconsistent, so start over.
      log('지난 실행이 정상 종료되지 않아 디스크를 새로 만듭니다(브라우저 로그인 상태 초기화).');
      await disks.clear(vaultId, environmentId);
      return disks.acquire(vaultId, environmentId);
    }
    throw error;
  });
  backend = new AppleOfflineBackend(join(root, 'dist/vm-assets'), proxy);
  await backend.start(disk);
  try {
    workspace = JSON.parse(await readFile(workspaceFile, 'utf8'));
    if (await backend.selectWorkspace(workspace.task)) log(`작업 공간 ${workspace.task}을(를) 다시 연결했습니다 (${workspace.vault})`);
    else { log('지난 작업 공간이 디스크에 없어 연결하지 않았습니다.'); workspace = undefined; await rm(workspaceFile, { force: true }); }
  } catch { workspace = undefined; }
  send('workspace', workspace ?? null);
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
  if (stopping) { console.log('정리 중입니다. 잠시 기다려 주세요(VM 종료 확인 중).'); return; }
  stopping = true;
  log('정리하는 중…');
  try { await browser?.close(); await backend?.closeBrowser(); } catch (error) { console.error('browser cleanup:', error.message); }
  try { await backend?.stop(); if (disk) await disks.release(disk.diskId, backend.cacheClean); console.log('VM 종료 확인 (STOP_CONFIRMED)'); }
  catch (error) { console.error('VM 종료 확인 실패:', error.message); }
  await proxy.close();
  try { if (JSON.parse(await readFile(runFile, 'utf8')).pid === process.pid) await rm(runFile, { force: true }); } catch {}
  process.exit(0);
}
// Closing the terminal window (SIGHUP) also stops the VM and returns the disk.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

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
  // --- workspace (2d) ---
  async workspaceImport(m) {
    const vault = String(m.vault ?? '').trim().replace(/^~(?=$|\/)/, homedir());
    if (!vault.startsWith('/')) throw new Error('Vault 경로는 절대 경로로 입력해 주세요');
    const snap = await snapshot(vault);
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    const task = `task-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    await backend.importWorkspace(task, snap.bundle);
    workspace = { vault, task, base: snap.base };
    await writeFile(workspaceFile, JSON.stringify(workspace));
    log(`Vault를 VM으로 가져왔습니다: ${task} (기준 커밋 ${snap.base.slice(0, 8)}, ${snap.bundle.length} bytes)`);
    send('workspace', workspace);
    return workspace;
  },
  async workspaceExport() {
    if (!workspace) throw new Error('가져온 작업 공간이 없습니다');
    const out = await backend.exportWorkspace(workspace.task, workspace.base);
    if (!out.bundle) return { empty: true };
    const review = await receive(workspace.vault, workspace.task, workspace.base, out.bundle);
    log(`결과를 가져왔습니다: 커밋 ${review.commits.length}개, 파일 ${review.files.length}개 (아직 브랜치 아님)`);
    return review;
  },
  async workspaceApprove(m) {
    const branch = await approve(workspace.vault, workspace.task, String(m.head));
    log(`승인: Vault에 브랜치 ${branch}을(를) 만들었습니다. 병합은 직접 하시면 됩니다.`);
    return { branch };
  },
  async workspaceDiscard() {
    await discard(workspace.vault, workspace.task);
    log('가져온 결과를 버렸습니다 (VM 안의 작업 공간은 그대로).');
    return {};
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
    res.write(`event: workspace\ndata: ${JSON.stringify(workspace ?? null)}\n\n`);
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

start().catch(async error => {
  log(`시작 실패: ${error.message}`);
  await stop();
});
