// Workspace Service: the resident engine process behind the app's Work tab, for one Vault.
// It owns the workspace VM, its browser, the Egress Proxy and the Worker, and talks to the app
// over stdin/stdout, one JSON object per line:
//   app -> service   {"id": 1, "cmd": "run", "instruction": "...", "difficulty": "normal"}
//   service -> app   {"reply": 1, "ok": true, "result": {...}}   or   {"event": "frame", ...}
// Usage: node dist/workspace/service.js
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rmdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppleOfflineBackend } from '../vault/apple-backend.js';
import { CacheDiskStore, type CacheAttachment } from '../vault/cache-disk.js';
import { KeychainStore } from '../credentials.js';
import { ModelGateway } from '../gateway/gateway.js';
import { difficulties, type Difficulty } from '../gateway/assignment.js';
import { openVault, type VaultPaths } from '../gateway/vault.js';
import { EgressProxy, EgressRules, type EgressAnswer } from './egress.js';
import { CDPClient } from './cdp.js';
import { WorkspaceBrowser } from './browser.js';
import { WorkerTools } from './tools.js';
import { WorkerRun, type WorkerEvent } from './worker.js';
import { snapshot, receive, approve, discard, pending, type Review } from './sync.js';

type VMState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
interface Saved { vaultId: string; task?: string; base?: string }

const out = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (name: string, data: object = {}) => out({ event: name, ...data });
const log = (text: string) => event('log', { at: new Date().toISOString(), text });

let paths: VaultPaths | undefined;
let saved: Saved | undefined;
let gateway: ModelGateway | undefined;
let rules: EgressRules | undefined;
let proxy: EgressProxy | undefined;
let backend: AppleOfflineBackend | undefined;
let disks: CacheDiskStore | undefined;
let disk: CacheAttachment | undefined;
let browser: WorkspaceBrowser | undefined;
let browserOpening: Promise<WorkspaceBrowser> | undefined;
let vm: VMState = 'stopped';
let worker: WorkerRun | undefined;
let running: AbortController | undefined;
let review: Review | null = null;
/** "Allow every site" as the user set it; it holds for the task about to run or running. */
let allowAll = false;
const approvals = new Map<string, (answer: EgressAnswer) => void>();
const ENVIRONMENT = '00000000-0000-4000-8000-00000000e2e0';

function status(detail?: string) {
  event('status', { vm, detail, task: saved?.task ?? null, running: !!running, browser: !!browser, control: browser?.control ?? 'ai', allowAll });
}

const stateFile = () => join(paths!.local, 'workspace.json');
async function save() { await writeFile(stateFile(), JSON.stringify(saved, null, 2) + '\n'); }

// --- opening a Vault ------------------------------------------------------------

async function open(vault: string) {
  if (paths) throw new Error('이 서비스는 이미 Vault를 열었습니다');
  paths = await openVault(vault);
  try { saved = JSON.parse(await readFile(stateFile(), 'utf8')); } catch { saved = undefined; }
  if (!saved?.vaultId || !/^[0-9a-f-]{36}$/.test(saved.vaultId)) { saved = { vaultId: randomUUID() }; await save(); }
  gateway = new ModelGateway(paths, { credentials: new KeychainStore() });
  rules = await EgressRules.load(paths.networkFile);
  proxy = new EgressProxy({
    rules,
    approve: (request, signal) => new Promise(resolve => {
      const id = randomUUID();
      approvals.set(id, resolve);
      signal.addEventListener('abort', () => { if (approvals.delete(id)) { event('approvalDone', { id }); resolve('deny'); } }, { once: true });
      event('approval', { id, ...request });
    }),
    onEvent: e => event('network', e),
  });
  // The VM disk (512 MiB: package cache, browser profile, workspaces) stays out of the Vault folder.
  const directory = join(homedir(), 'Library', 'Application Support', 'Nidus', 'workspaces', saved.vaultId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  disks = new CacheDiskStore(join(directory, 'disks'));
  if (saved.task && saved.base) review = await pending(paths.root, saved.task, saved.base).catch(() => null);
  status();
  if (review) event('review', { review });
  return { vault: paths.root, task: saved.task ?? null, git: await gitState() };
}

const git = (...args: string[]) => promisify(execFile)('git', ['-C', paths!.root, '-c', 'core.hooksPath=/dev/null', ...args], { maxBuffer: 16 * 1024 * 1024 });

/** Work needs the Vault to be a Git repository with at least one commit. */
async function gitState(): Promise<'ready' | 'no-repository' | 'no-commits'> {
  try {
    const { stdout } = await git('rev-parse', '--show-toplevel');
    if (!stdout.trim()) return 'no-repository';
  } catch { return 'no-repository'; }
  try { await git('rev-parse', '--verify', 'HEAD^{commit}'); return 'ready'; } catch { return 'no-commits'; }
}

/** Only on the user's request: makes the Vault a Git repository and commits what is there (ignored files excepted). */
async function gitInit() {
  const state = await gitState();
  if (state === 'ready') return { git: state };
  if (state === 'no-repository') await git('init', '--quiet');
  await git('add', '--all');
  await git('-c', 'user.name=Nidus', '-c', 'user.email=nidus@nidus.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Nidus: 처음 커밋 (작업 공간 시작점)');
  log('Vault를 Git 저장소로 만들고 현재 파일을 첫 커밋으로 남겼습니다');
  return { git: await gitState() };
}

// --- VM and browser ---------------------------------------------------------------

/** A run that died (crash, force quit) leaves the disk marked as owned; reclaim it when no VM uses it. */
async function reclaimDisk(directory: string) {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'command=']);
  if (stdout.split('\n').some(line => line.includes('nidus-vault-vm') && line.includes(directory))) throw new Error('이 Vault의 VM이 다른 곳에서 실행 중입니다');
  await rmdir(join(directory, 'owner')).catch(() => {});
}

async function start() {
  if (vm === 'running' || vm === 'starting') return;
  if (!paths) throw new Error('Vault를 먼저 열어야 합니다');
  vm = 'starting'; status('VM을 시작합니다');
  try {
    const diskDir = join(homedir(), 'Library', 'Application Support', 'Nidus', 'workspaces', saved!.vaultId, 'disks', `${saved!.vaultId}-${ENVIRONMENT}`);
    await reclaimDisk(diskDir);
    disk = await disks!.acquire(saved!.vaultId, ENVIRONMENT).catch(async error => {
      if (!/cache_dirty/.test(String(error.message))) throw error;
      // Not cleanly stopped last time: the file system may be inconsistent, so it starts over.
      log('지난번 VM이 정상 종료되지 않아 작업 디스크를 새로 만듭니다(브라우저 로그인과 VM 안 작업 공간 초기화).');
      await disks!.clear(saved!.vaultId, ENVIRONMENT);
      return disks!.acquire(saved!.vaultId, ENVIRONMENT);
    });
    backend = new AppleOfflineBackend(undefined, proxy);
    backend.onFailure(() => { if (vm === 'running') { vm = 'failed'; browser = undefined; status('VM 연결이 끊겼습니다'); } });
    await backend.start(disk);
    if (saved?.task && !await backend.selectWorkspace(saved.task)) {
      log(`작업 공간 ${saved.task}이(가) VM 디스크에 없습니다. 새 작업으로 시작해야 합니다.`);
      if (!review) { saved = { vaultId: saved.vaultId }; await save(); }
    }
    vm = 'running'; status('VM 준비 완료');
    await ensureBrowser();
  } catch (error) {
    vm = 'failed'; status(`VM 시작 실패: ${String((error as Error).message ?? error)}`);
    throw error;
  }
}

function ensureBrowser(): Promise<WorkspaceBrowser> {
  if (browser) return Promise.resolve(browser);
  if (!backend || vm !== 'running') return Promise.reject(new Error('VM이 실행 중이 아닙니다'));
  browserOpening ??= (async () => {
    const opened = new WorkspaceBrowser(new CDPClient(await backend!.openBrowser(86400)), { maxFps: 15 });
    opened.on('frame', frame => {
      // A slow app gets fewer frames, never a growing backlog.
      if (!process.stdout.writableNeedDrain) out({ event: 'frame', data: frame.data, width: frame.width, height: frame.height });
    });
    opened.on('control', change => { event('control', change); status(); });
    opened.on('tabs', tabs => event('tabs', { tabs }));
    opened.on('closed', () => { if (browser === opened) { browser = undefined; status('브라우저가 닫혔습니다'); } });
    await opened.start();
    browser = opened;
    event('tabs', { tabs: opened.listTabs() });
    status();
    return opened;
  })().finally(() => { browserOpening = undefined; });
  return browserOpening;
}

async function stop() {
  if (vm === 'stopped' || !backend) return;
  running?.abort();
  vm = 'stopping'; status('VM을 종료합니다');
  try { await browser?.close(); await backend.closeBrowser(); } catch {}
  browser = undefined;
  try {
    await backend.stop();
    if (disk) await disks!.release(disk.diskId, backend.cacheClean);
    vm = 'stopped'; status('VM 종료 확인');
  } catch (error) {
    vm = 'failed'; status(`VM 종료를 확인하지 못했습니다: ${(error as Error).message}`);
  } finally { disk = undefined; backend = undefined; }
}

// --- tasks ------------------------------------------------------------------------

function taskName() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `t-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function run(instruction: string, difficulty: Difficulty, fresh: boolean) {
  if (vm !== 'running' || !backend) throw new Error('VM을 먼저 시작해야 합니다');
  if (running) throw new Error('이미 작업이 진행 중입니다');
  if (!instruction.trim()) throw new Error('지시가 비어 있습니다');
  if (!difficulties.includes(difficulty)) throw new Error('난이도가 올바르지 않습니다');
  if (review) throw new Error('검토를 기다리는 결과가 있습니다. 승인하거나 버린 뒤 새 작업을 시작하세요');
  if (fresh || !saved?.task) {
    if (saved?.task) await removeWorkspace();
    const snap = await snapshot(paths!.root);
    const task = taskName();
    await backend.importWorkspace(task, snap.bundle);
    saved = { vaultId: saved!.vaultId, task, base: snap.base };
    await save();
    worker = undefined;
    // A new task forgets per-task approvals, but keeps the switch the user just set for it.
    proxy!.resetSession();
    proxy!.setAllowAll(allowAll);
    log(`새 작업 ${task}: Vault의 커밋 ${snap.base.slice(0, 8)}을(를) VM으로 가져왔습니다`);
  }
  const task = saved!.task!;
  const backendNow = backend;
  worker ??= new WorkerRun(gateway!, new WorkerTools({
    shell: async (command, seconds, signal) => {
      const id = randomUUID();
      const cancel = () => { try { backendNow.cancel(id); } catch {} };
      signal?.addEventListener('abort', cancel, { once: true });
      try { return await backendNow.execute(id, command, seconds, { profile: 'shell' }); }
      finally { signal?.removeEventListener('abort', cancel); }
    },
    browser: ensureBrowser,
  }), { task, difficulty, onEvent: (e: WorkerEvent) => event('worker', { task, ...clipEvent(e) }) });
  running = new AbortController();
  status('작업 중');
  const controller = running;
  void worker.run(instruction, controller.signal).then(async outcome => {
    running = undefined;
    status(outcome.status === 'finished' ? '작업 완료' : outcome.status === 'stopped' ? '작업 중지' : '작업 실패');
    await collect().catch(error => log(`결과를 가져오지 못했습니다: ${error.message}`));
  });
  return { task };
}

/** Events for the app: tool outputs and page texts can be long; the model got them in full. */
function clipEvent(e: WorkerEvent): WorkerEvent {
  if (e.type === 'tool_result' && e.content.length > 4000) return { ...e, content: `${e.content.slice(0, 4000)}\n… (${e.content.length - 4000}자 생략)` };
  return e;
}

/** Brings the task's work back for review (it is not a branch until the user approves). */
async function collect() {
  if (!saved?.task || !saved.base || !backend) return null;
  const result = await backend.exportWorkspace(saved.task, saved.base);
  review = result.bundle ? await receive(paths!.root, saved.task, saved.base, result.bundle) : null;
  event('review', { review });
  if (!review) log('바뀐 파일이 없습니다');
  return review;
}

async function removeWorkspace() {
  if (saved?.task && backend) await backend.removeWorkspace(saved.task).catch(() => {});
  saved = { vaultId: saved!.vaultId };
  worker = undefined;
  await save();
}

// --- commands -----------------------------------------------------------------------

const commands: Record<string, (m: any) => Promise<unknown>> = {
  open: m => open(String(m.vault ?? '')),
  gitInit: () => gitInit(),
  start: () => start(),
  stop: () => stop(),
  run: m => run(String(m.instruction ?? ''), m.difficulty as Difficulty, !!m.fresh),
  cancel: async () => { running?.abort(); return {}; },
  collect: () => collect(),
  approve: async m => {
    if (!review || !saved?.task) throw new Error('승인할 결과가 없습니다');
    const branch = await approve(paths!.root, saved.task, String(m.head ?? ''));
    review = null; event('review', { review: null });
    await removeWorkspace(); status();
    log(`브랜치 ${branch}을(를) 만들었습니다. 병합은 직접 하시면 됩니다.`);
    return { branch };
  },
  discard: async () => {
    if (saved?.task) await discard(paths!.root, saved.task);
    review = null; event('review', { review: null });
    await removeWorkspace(); status();
    return {};
  },
  takeOver: async () => { (await ensureBrowser()).takeOver('사용자 개입'); return {}; },
  handBack: async () => { browser?.handBack(); return {}; },
  input: async m => { await (await ensureBrowser()).input(m.input); return {}; },
  answer: async m => {
    const resolve = approvals.get(String(m.approval));
    if (resolve && ['once', 'always', 'deny'].includes(m.answer)) { approvals.delete(String(m.approval)); resolve(m.answer); event('approvalDone', { id: m.approval }); }
    return {};
  },
  allowAll: async m => { allowAll = !!m.enabled; proxy?.setAllowAll(allowAll); event('allowAll', { enabled: allowAll }); return {}; },
};

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  for (const resolve of approvals.values()) resolve('deny');
  await stop().catch(() => {});
  await proxy?.close().catch(() => {});
  gateway?.close();
  process.exit(0);
}

// Commands run concurrently (browser input while a task runs), but none before the Vault is open.
let opening: Promise<unknown> = Promise.resolve();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  const handler = commands[message?.cmd];
  if (!handler) { out({ reply: message?.id ?? null, ok: false, error: `알 수 없는 명령: ${message?.cmd}` }); return; }
  const result = message.cmd === 'open' ? (opening = handler(message)) : opening.catch(() => {}).then(() => handler(message));
  result.then(
    result => out({ reply: message.id ?? null, ok: true, result: result ?? {} }),
    error => out({ reply: message.id ?? null, ok: false, error: String(error?.message ?? error) }),
  );
});
// The app went away (quit, crash): stop the VM properly.
input.on('close', () => void quit());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void quit());
process.stdout.on('error', () => void quit());
event('ready', { version: 1 });
