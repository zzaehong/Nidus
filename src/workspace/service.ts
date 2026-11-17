// Workspace Service: the resident engine process behind the app's Work tab, for one Vault.
// It owns the workspace VM, its browser, the Egress Proxy and the Worker, and talks to the app
// over stdin/stdout, one JSON object per line:
//   app -> service   {"id": 1, "cmd": "run", "instruction": "...", "difficulty": "normal"}
//   service -> app   {"reply": 1, "ok": true, "result": {...}}   or   {"event": "frame", ...}
// Usage: node dist/workspace/service.js
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rmdir, writeFile, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { WorkerRun, type WorkerEvent, type WorkerOutcome, type WorkerToolSet } from './worker.js';
import { Office, type OfficeEvent } from '../office/office.js';
import { concludeBrief } from '../office/plan.js';
import { BoardStore, placeOf, workerFor, type BoardTask, type Project } from '../office/board.js';
import { HomeStore, identity } from '../office/home.js';
import { DeskStore, deskHasContext, recoveryBrief, renderDesk, withDesk } from '../office/desk.js';
import { MAX_ATTEMPTS } from '../office/office.js';
import { Library, libraryFolder, libraryRules, setLibraryRules, withLibrary } from '../office/library.js';
import { CardStore, Curator, CurationStore, describeCuration } from '../office/curate.js';
import { Dream, describeDream } from '../office/dream.js';
import { ChatStore, MainChat } from '../office/chat.js';
import { describeStaff } from '../office/home.js';
import { TextTools, gitSource } from '../office/text-work.js';
import { workerSystem } from '../office/roles.js';
import { workerBrief } from '../office/plan.js';
import { snapshot, receive, approve, discard, pending, combine, fetchWork, snapshotAt, type Review } from './sync.js';
import { TaskWorkspaces } from './workspaces.js';
import { approvalGate, vmTurns } from './turns.js';
import { ActivityLog, describeModels, describeUsage, elapsed, renderMainDesk } from '../office/progress.js';
import { loadTable } from '../gateway/assignment.js';

type VMState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
interface Saved {
  vaultId: string;
  /** The work under review: a single run's workspace, or a project's name for its combined result. */
  task?: string;
  base?: string;
  /** A project's VM Tasks: each its own workspace in the VM, the commit it started from, and its work kept so far. */
  tasks?: Record<string, { ws: string; start: string; head?: string }>;
}

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
let office: Office | undefined;
let home: HomeStore | undefined;
let desks: DeskStore | undefined;
let library: Library | undefined;
let chat: MainChat | undefined;
let dream: Dream | undefined;
let dreaming: AbortController | undefined;
let curator: Curator | undefined;
let curating: AbortController | undefined;
let chatting: AbortController | undefined;
/** Per board task: its Worker conversation, its commits (vm), its text tools (text), the last outcome. */
interface TaskRun { run: WorkerRun; textTools?: TextTools; last?: WorkerOutcome; trail: string[]; /** vm: [before, after] commits of each attempt. */ ranges: [string, string][] }
const taskRuns = new Map<string, TaskRun>();
/** "Allow every site" as the user set it; it holds for the task about to run or running. */
let allowAll = false;
const approvals = new Map<string, (answer: EgressAnswer) => void>();
const gate = approvalGate(() => approvals.size);
/** What happened lately, for Main: it must be able to say where the work stands and why. Kept on disk once a Vault is open. */
let activity = new ActivityLog();
/** Something happened: noted for Main, and Main's Desk is brought up to date soon after. */
function note(text: string) { activity.add(text); deskSoon(); }
/** Per board task, when its Worker last did something: a model answer's wait is the time since. */
const lastStep = new Map<string, number>();
/** VM Tasks side by side: each in its own workspace, VM calls and browser actions in turn. */
const spaces = new TaskWorkspaces({ vm: () => { if (!backend || vm !== 'running') throw new Error('VM이 실행 중이 아닙니다'); return backend; }, browser: () => ensureBrowser(), waitForApprovals: gate.wait });
/** Making a Task's workspace (and the project's base) one Task at a time. */
const setupLine = vmTurns();
let vmStarting: Promise<void> | undefined;
const services = new Map<string, string>(); // name -> VM session id
const ENVIRONMENT = '00000000-0000-4000-8000-00000000e2e0';

/**
 * While work runs, the Mac must not fall asleep on its own: timers, the VM and network calls
 * stop during sleep and a task left alone would never finish. caffeinate -i keeps the system
 * awake (the display may still sleep) and exits with this process. Closing the lid still sleeps.
 */
let awake: ChildProcess | undefined;
function keepAwake(on: boolean) {
  if (on && !awake && process.platform === 'darwin') {
    awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    awake.on('error', () => { awake = undefined; });
    awake.on('exit', () => { awake = undefined; });
  } else if (!on && awake) {
    awake.kill();
    awake = undefined;
  }
}

function status(detail?: string) {
  keepAwake(!!running);
  if (detail) note(`상태: ${detail}`);
  event('status', { vm, detail, task: saved?.task ?? null, running: !!running, awake: !!awake, browser: !!browser, control: browser?.control ?? 'ai', allowAll });
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
    // The user may be away for a while; the task waits for them rather than failing.
    approvalTimeoutMs: 30 * 60_000,
    approve: (request, signal) => new Promise(resolve => {
      const id = randomUUID();
      approvals.set(id, resolve);
      signal.addEventListener('abort', () => { if (approvals.delete(id)) { event('approvalDone', { id }); resolve('deny'); gate.settled(); } }, { once: true });
      note(`네트워크 승인 대기: ${request.target === 'mac' ? `Mac 포트 ${request.port}` : request.site} (사용자가 답할 때까지 Worker가 멈춤)`);
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
  home = new HomeStore(join(paths.nidus, 'office', 'staff.json'), join(paths.local, 'home'));
  desks = new DeskStore(join(paths.local, 'desk'));
  library = new Library(paths.root, await libraryFolder(join(paths.nidus, 'office', 'library.json')));
  office = new Office({ gateway, store: new BoardStore(join(paths.local, 'board')), home, desk: desks, library, repository: repositoryOverview, work, onEvent: officeEvent });
  dream = new Dream({ gateway, library, stateFile: join(paths.local, 'dream.json') });
  const libraryConfig = join(paths.nidus, 'office', 'library.json');
  curator = new Curator({ gateway, library, store: new CurationStore(join(paths.local, 'curation.json')), rules: () => libraryRules(libraryConfig), cards: new CardStore(join(paths.local, 'note-cards.json')),
    onChange: curation => event('curation', { curation, running: !!curating }), onProgress: progress => event('curation', { curation: curator!.current, running: true, progress }) });
  await curator.load();
  activity = await ActivityLog.open(join(paths.local, 'main-desk', 'activity.jsonl'));
  note('Vault를 열었습니다 (앱 시작)');
  chat = new MainChat({
    gateway, store: new ChatStore(join(paths.local, 'main-chat.json')),
    context: chatContext,
    blocked: () => running ? '다른 작업이 진행 중입니다' : review ? '검토를 기다리는 결과가 있습니다. 승인하거나 버린 뒤 다시 말씀해 주세요' : office?.project && !['done', 'failed'].includes(office.project.status) ? '열려 있는 프로젝트가 있습니다. 끝내거나 닫은 뒤 다시 말씀해 주세요' : null,
    start: async instruction => { taskRuns.clear(); planning(signal => office!.plan(instruction, signal)); },
    tidy: () => { tidyLibrary(); },
    connect: () => { suggestLinks(); },
    onChange: messages => event('chat', { messages: messages.slice(-100) }),
  });
  const last = await new BoardStore(join(paths.local, 'board')).latest();
  if (last && !['done', 'failed'].includes(last.status) && !last.closed) {
    // A project cut off by a quit can continue from where it was.
    if (last.status === 'planning') Object.assign(last, { status: 'failed', error: '계획을 세우는 중에 앱이 종료되었습니다. 다시 지시해 주세요.' });
    else if (['running', 'reviewing'].includes(last.status)) last.status = last.tasks.some(t => t.status !== 'pending') ? 'stopped' : 'waiting_user';
    office.project = last;
  }
  status();
  publishProject();
  if (review) event('review', { review });
  await chat.load();
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
    spaces.reset();
    if (saved?.task && !saved.tasks && !await backend.selectWorkspace(saved.task)) {
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
  services.clear();
  spaces.reset();
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
  if (fresh || !saved?.task || saved.tasks) {
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
  worker ??= new WorkerRun(gateway!, new WorkerTools(workerRuntime(backendNow)), { task, difficulty, onEvent: (e: WorkerEvent) => event('worker', { task, ...clipEvent(e) }) });
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
  if (!saved?.task || !saved.base) return null;
  if (saved.tasks) return collectProject();
  if (!backend) return null;
  const result = await backend.exportWorkspace(saved.task, saved.base);
  review = result.bundle ? await receive(paths!.root, saved.task, saved.base, result.bundle) : null;
  event('review', { review });
  if (!review) log('바뀐 파일이 없습니다');
  return review;
}

/**
 * A project's result: the work of its finished VM Tasks combined into one commit on the Vault's
 * hidden ref (no working tree, nothing of the user's touched), then shown for review like a single
 * workspace's work. A conflict between Tasks is said, with the files; each Task's work stays on
 * its own hidden ref.
 */
async function collectProject() {
  const project = office?.project;
  const tasks = saved!.tasks!;
  const done = new Set(project?.tasks.filter(t => t.status === 'done').map(t => t.id) ?? Object.keys(tasks));
  const order = project?.tasks.map(t => t.id) ?? Object.keys(tasks);
  const heads = order.filter(id => done.has(id) && tasks[id]?.head).map(id => tasks[id]!.head!);
  review = null;
  if (heads.length) {
    try {
      await combine(paths!.root, saved!.task!, saved!.base!, heads);
      review = await pending(paths!.root, saved!.task!, saved!.base!);
    } catch (error: any) {
      const refs = order.filter(id => tasks[id]?.head).map(id => `refs/nidus/incoming/${tasks[id]!.ws}`).join(', ');
      log(`VM Task들의 결과를 합치지 못했습니다: ${error.message}`);
      void chat?.note(`VM Task들의 결과가 서로 부딪혀 하나로 합치지 못했습니다 (${String(error.message ?? error).replace(/^workspace_merge_conflict: /, '충돌한 파일: ')}). 각 Task의 결과는 Vault의 숨은 ref에 남아 있습니다: ${refs}`, true).catch(() => {});
    }
  }
  event('review', { review });
  if (!review && !heads.length) log('바뀐 파일이 없습니다');
  return review;
}

async function removeWorkspace() {
  // Background services belong to the task's workspace.
  for (const id of services.values()) await backend?.stopService(id).catch(() => {});
  services.clear();
  if (saved?.tasks) {
    for (const entry of Object.values(saved.tasks)) {
      if (backend && vm === 'running') await spaces.remove(entry.ws).catch(() => {});
      await discard(paths!.root, entry.ws).catch(() => {});
    }
  } else if (saved?.task && backend) await backend.removeWorkspace(saved.task).catch(() => {});
  saved = { vaultId: saved!.vaultId };
  worker = undefined;
  await save();
}

// --- AI Office: Main, Managers, Workers -----------------------------------------------

/** The project for the app, without Main's raw planning conversation. */
function publishProject() {
  deskSoon();
  const project = office?.project;
  event('project', { project: project ? { ...project, conversation: undefined } : null });
}

function officeEvent(e: OfficeEvent) {
  if (e.type === 'project') { publishProject(); return; }
  if (e.type === 'retry') { note(`${e.from} 모델 호출 재시도 ${e.attempt}회째: ${e.error}`); event('office', { from: e.from, title: `모델 호출 재시도 (${e.attempt}회째)`, text: e.error, isError: true }); return; }
  note(`${e.taskId ? `${e.taskId} ` : ''}${e.from}: ${e.title}${e.model ? ` (${e.model})` : ''} — ${e.text.slice(0, 160)}`);
  event('office', { from: e.from, taskId: e.taskId, title: e.title, text: e.text, model: e.model, difficulty: e.difficulty });

}

/** What Main sees of the Vault: tracked files and the README. */
async function repositoryOverview(): Promise<string> {
  const files = (await git('ls-files').catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean);
  const readme = await git('show', 'HEAD:README.md').then(r => r.stdout.slice(0, 3000), () => '');
  return `${files.length} tracked files${files.length > 200 ? ' (first 200)' : ''}:\n${files.slice(0, 200).join('\n') || '(none)'}${readme ? `\n\nREADME.md:\n${readme}` : ''}`;
}

function workerRuntime(backendNow: AppleOfflineBackend) {
  return {
    shell: async (command: string, seconds: number, signal?: AbortSignal) => {
      const id = randomUUID();
      const cancel = () => { try { backendNow.cancel(id); } catch {} };
      signal?.addEventListener('abort', cancel, { once: true });
      try { return await backendNow.execute(id, command, seconds, { profile: 'shell' }); }
      finally { signal?.removeEventListener('abort', cancel); }
    },
    browser: ensureBrowser,
    startService: async (name: string, command: string) => {
      if (services.has(name)) await backendNow.stopService(services.get(name)!).catch(() => {});
      const id = randomUUID();
      await backendNow.startService(id, command);
      services.set(name, id);
    },
    stopService: async (name: string) => {
      const id = services.get(name);
      if (!id) return false;
      services.delete(name);
      await backendNow.stopService(id);
      return true;
    },
    services: () => [...services.keys()].filter(name => backendNow.runningServices.includes(services.get(name)!)),
    waitForApprovals: gate.wait,
  };
}

/** A shell command in the workspace whose output the service needs (not a Worker action). */

/** Office -> Worker: runs or continues a board task where it runs, returns evidence. */
async function work(task: BoardTask, instruction: string, difficulty: Difficulty, signal: AbortSignal, revision: boolean) {
  if (placeOf(task) === 'text') return textWork(task, instruction, difficulty, signal, revision);
  // VM Tasks go on side by side, each in its own workspace (see workspaces.ts).
  return vmWork(task, instruction, difficulty, signal, revision);
}

/**
 * The task's Worker conversation: new, or the same one for a revision; restarted after a failure.
 * A new conversation for a task that already has a Desk (the app was restarted, the project was
 * stopped, the last attempt broke off) begins with context recovery.
 */
async function taskConversation(task: BoardTask, instruction: string, revision: boolean, make: (previous: TaskRun | undefined) => TaskRun, earlyNote: (next: TaskRun) => string): Promise<{ entry: TaskRun; instruction: string }> {
  const project = office!.project!;
  let entry = taskRuns.get(task.id);
  const continued = !!entry && revision && entry.last?.status === 'finished';
  if (!continued) {
    const before = entry?.last;
    const next = make(entry);
    if (entry) { entry.run = next.run; entry.textTools = next.textTools; }
    else { entry = next; taskRuns.set(task.id, entry); }
    const desk = await desks!.load(project.id, task.id).catch(() => null);
    const parts: string[] = [];
    // A revision in a new conversation needs the brief again; a first attempt already is the brief.
    if (revision || before) parts.push(workerBrief(project, task));
    if (deskHasContext(desk)) parts.push(recoveryBrief(project, task, desk, MAX_ATTEMPTS));
    if (before && before.status !== 'finished') parts.push(`A previous attempt ended early (${before.status === 'stopped' ? before.detail : before.error}).`);
    if (revision || before || deskHasContext(desk)) parts.push(earlyNote(entry));
    if (parts.length) instruction = [...parts, instruction].join('\n\n');
  }
  entry!.trail.push(`--- attempt ${task.attempts} ---`);
  return { entry: entry!, instruction };
}

/** The Worker's Desk for a task: its tool, its text for summaries, and where summaries are kept. */
function deskFor(task: BoardTask) {
  const project = office!.project!.id, employee = workerFor(office!.project!, task)?.id ?? null;
  return {
    wrap: (tools: WorkerToolSet) => withDesk(withLibrary(tools, library!), async patch => {
      const desk = await desks!.update(project, task.id, employee, patch);
      event('worker', { boardTask: task.id, who: workerFor(office!.project!, task)?.name, type: 'desk', progress: desk.progress, next: desk.next });
      return desk;
    }),
    options: {
      desk: async () => { const desk = await desks!.load(project, task.id); return deskHasContext(desk) ? renderDesk(desk) : undefined; },
      onSummary: async (summary: string) => { await desks!.checkpoint(project, task.id, employee, 'summary', summary); },
    },
    evidence: async () => { const desk = await desks!.load(project, task.id).catch(() => null); return deskHasContext(desk) ? `\n\nThe Worker's Desk notes:\n${renderDesk({ ...desk, checkpoints: [] })}` : ''; },
  };
}

/** Who the task's Worker is (Home), for the top of its system prompt. */
function whoWorks(task: BoardTask): string | undefined {
  const project = office!.project!;
  const worker = workerFor(project, task);
  return worker ? identity(worker, project.teams.find(t => t.id === task.team)) : undefined;
}

function workerEvents(task: BoardTask, trail: string[]) {
  return (e: WorkerEvent) => {
    if (e.type === 'tool_call') trail.push(`${e.name} ${JSON.stringify(e.input).slice(0, 160)}`);
    if (e.type === 'tool_result' && e.isError && trail.length) trail[trail.length - 1] += ' -> error';
    const now = Date.now(), since = lastStep.get(task.id);
    lastStep.set(task.id, now);
    const line = e.type === 'model' ? `모델 답 ${e.provider}:${e.model}${since ? ` (${elapsed(now - since)} 걸림)` : ''}, 입력 ${e.inputTokens} 토큰`
      : e.type === 'tool_call' ? `도구 ${e.name} ${JSON.stringify(e.input).slice(0, 120)}`
      : e.type === 'tool_result' ? (e.isError || e.ms > 30_000 ? `도구 ${e.name} ${e.isError ? '실패' : '완료'} (${elapsed(e.ms)})${e.isError ? `: ${e.content.slice(0, 120)}` : ''}` : null)
      : e.type === 'retry' ? `모델 호출 실패, ${e.waitMs ? `${elapsed(e.waitMs)} 뒤 재시도` : '다른 후보로'}: ${e.error}`
      : e.type === 'compacted' ? `대화 압축 (${e.how})`
      : e.type === 'finished' ? `Worker 끝냄: ${e.summary.slice(0, 160)}`
      : e.type === 'stopped' ? `Worker 멈춤: ${e.detail}`
      : e.type === 'failed' ? `Worker 실패: ${e.error}` : null;
    if (line) note(`${task.id} Worker ${line}`);
    event('worker', { task: placeOf(task) === 'text' ? undefined : saved?.task, boardTask: task.id, who: workerFor(office!.project!, task)?.name, where: placeOf(task), ...clipEvent(e) });
  };
}

async function textWork(task: BoardTask, instruction: string, difficulty: Difficulty, signal: AbortSignal, revision: boolean) {
  const desk = deskFor(task);
  const projectId = office!.project!.id;
  const draft = taskRuns.has(task.id) ? undefined : await desks!.loadDraft(projectId, task.id);
  const made = await taskConversation(task, instruction, revision, previous => {
    const trail = previous?.trail ?? [];
    const tools = new TextTools(gitSource(paths!.root), text => { void desks!.saveDraft(projectId, task.id, text).catch(() => {}); });
    // A new conversation keeps what the last one wrote, so "continue" has something to build on.
    tools.deliverable = previous?.textTools?.deliverable ?? draft ?? task.output;
    return { run: new WorkerRun(gateway!, desk.wrap(tools), { task: office!.project!.id, difficulty, system: workerSystem('text', office!.project!.id, whoWorks(task), true, true), onEvent: workerEvents(task, trail), ...desk.options }), textTools: tools, trail, ranges: [] };
  }, next => next.textTools?.deliverable ? `The deliverable written so far (kept; replace or append to it):\n${next.textTools.deliverable.slice(0, 20000)}` : 'Nothing was delivered yet.');
  const { entry } = made;
  const outcome = await entry.run.run(made.instruction, signal);
  entry.last = outcome;
  if (signal.aborted) return { outcome, evidence: '' };
  const output = entry.textTools!.deliverable ?? (outcome.status === 'finished' ? outcome.summary : '');
  const shown = output.length > 15000 ? `${output.slice(0, 15000)}\n… (${output.length - 15000} more characters)` : output;
  return { outcome, output, evidence: `This was a text task (no VM): nothing in the repository changed; the deliverable is the result.\n\nTool calls (latest last):\n${entry.trail.slice(-40).join('\n') || '(none)'}\n\nDeliverable:\n${shown || '(none)'}${await desk.evidence()}` };
}

async function vmWork(task: BoardTask, instruction: string, difficulty: Difficulty, signal: AbortSignal, revision: boolean) {
  let place: { ws: string; start: string };
  try { place = await taskWorkspace(task, signal); }
  catch (error: any) {
    if (signal.aborted) throw error;
    // For example the work of the Tasks it builds on cannot be combined: its Manager sees why.
    const message = `작업 공간을 준비하지 못했습니다: ${String(error?.message ?? error)}`;
    log(`${task.id}: ${message}`);
    return { outcome: { status: 'failed' as const, error: message }, evidence: message };
  }
  const { ws } = place;
  const sh = (command: string) => spaces.exec(ws, command).then(r => r.stdout);
  const desk = deskFor(task);
  const made = await taskConversation(task, instruction, revision, previous => {
    const trail = previous?.trail ?? [];
    return { run: new WorkerRun(gateway!, desk.wrap(new WorkerTools(spaces.runtime(ws))), { task: ws, difficulty, system: workerSystem('vm', ws, whoWorks(task), true, true), onEvent: workerEvents(task, trail), ...desk.options }), trail, ranges: previous?.ranges ?? [] };
  }, () => 'Check the workspace for what was already done and continue.');
  const { entry } = made;
  const before = (await sh('git rev-parse HEAD')).trim();
  const outcome = await entry.run.run(made.instruction, signal);
  entry.last = outcome;
  // Changes left uncommitted belong to this task: commit them, so every attempt's changes are its own commits.
  await sh(`git add -A && (git diff --cached --quiet || git commit -q -m "nidus: ${task.id} 작업 저장")`).catch(() => '');
  const after = (await sh('git rev-parse HEAD')).trim();
  if (after !== before) entry.ranges.push([before, after]);
  // The work so far goes to the Vault's hidden ref: Tasks that build on it start from it, and the project's result combines it.
  await keepWork(task.id).catch(error => log(`${task.id}: 결과를 Vault로 가져오지 못했습니다: ${error.message}`));
  if (signal.aborted) return { outcome, evidence: '' };
  const trail = entry.trail.slice(-40).join('\n');
  return { outcome, evidence: `Tool calls (latest last):\n${trail}\n\n${await taskChanges(ws, entry.ranges)}${await desk.evidence()}` };
}

/** What a task changed: its own commits, in its own workspace. */
async function taskChanges(ws: string, ranges: [string, string][]): Promise<string> {
  if (!ranges.length) return 'Commits made for this task: none (nothing changed in /workspace).';
  const latest = ranges.at(-1)!;
  const lines = [
    'echo "Commits made for this task:"',
    ...ranges.map(([a, b]) => `git log --oneline ${a}..${b}`),
    'echo; echo "Changed files:"',
    ...ranges.map(([a, b]) => `git diff --stat ${a} ${b}`),
    `echo; echo "Diff of the latest attempt:"; git diff ${latest[0]} ${latest[1]} | head -c 12000`,
    ...(ranges.length > 1 ? [`echo; echo "Diff of earlier attempts (start):"`, ...ranges.slice(0, -1).map(([a, b]) => `git diff ${a} ${b} | head -c 3000`)] : []),
  ];
  return spaces.exec(ws, lines.join('; ')).then(r => r.stdout, e => `(could not read changes: ${e.message})`);
}

/** The VM, started once however many Tasks need it at the same moment. */
async function vmReady() {
  if (vm === 'running' && backend) return;
  if (!vmStarting) log('VM이 필요한 Task라 VM을 켭니다');
  vmStarting ??= start().finally(() => { vmStarting = undefined; });
  await vmStarting;
  if ((vm as VMState) !== 'running' || !backend) throw new Error('VM을 시작하지 못했습니다');
}

/**
 * The project's name and base for its VM work: the Vault's committed state when its first VM Task
 * begins. A different (earlier) project's workspaces are removed first.
 */
async function projectBase(): Promise<{ name: string; base: string }> {
  const project = office!.project!;
  if (!(project.workspace && project.workspace === saved?.task && saved.tasks && saved.base)) {
    if (saved?.task) await removeWorkspace();
    const { base } = await snapshot(paths!.root);
    const name = taskName();
    saved = { vaultId: saved!.vaultId, task: name, base, tasks: {} };
    await save();
    proxy!.resetSession();
    proxy!.setAllowAll(allowAll);
    project.workspace = name;
    // VM conversations belonged to the old workspaces; text ones carry on.
    for (const [id, run] of taskRuns) if (!run.textTools) taskRuns.delete(id);
    log(`프로젝트 ${name}: Vault의 커밋 ${base.slice(0, 8)}에서 시작합니다. VM Task마다 작업 공간을 따로 둡니다.`);
  }
  return { name: saved!.task!, base: saved!.base! };
}

/**
 * A VM Task's own workspace, made when it first runs: from the project's base, or from the
 * combined work of the VM Tasks it depends on. After a VM restart it comes back from its own work
 * kept so far. One Task at a time, so two never make the project's base twice.
 */
function taskWorkspace(task: BoardTask, signal: AbortSignal): Promise<{ ws: string; start: string }> {
  return setupLine.take(task.id, signal, async () => {
    await vmReady();
    const { name, base } = await projectBase();
    const tasks = saved!.tasks!;
    const known = tasks[task.id];
    if (known && await spaces.inVm(known.ws, signal, async () => true).catch(() => false)) return known;
    const ws = known?.ws ?? `${name}-${task.id}`;
    let start = known?.start ?? base;
    if (!known) {
      const heads = task.dependsOn.map(d => tasks[d]?.head).filter((h): h is string => !!h);
      if (heads.length) start = await combine(paths!.root, ws, base, heads);
    }
    const from = known?.head ?? start;
    await spaces.import(ws, await snapshotAt(paths!.root, from), signal);
    const entry = { ws, start, ...(known?.head ? { head: known.head } : {}) };
    tasks[task.id] = entry;
    await save();
    log(`${task.id}: 작업 공간 ${ws}${from === base ? '' : known?.head ? ' (지난 작업에서 이어감)' : ` (선행 Task의 결과 ${from.slice(0, 8)}에서 시작)`}`);
    return entry;
  });
}

/** A VM Task's work from its workspace into the Vault's hidden ref for it. */
async function keepWork(taskId: string) {
  const entry = saved?.tasks?.[taskId];
  if (!entry) return;
  const result = await spaces.export(entry.ws, entry.start);
  if (!result.bundle) return;
  entry.head = await fetchWork(paths!.root, entry.ws, entry.start, result.bundle);
  await save();
}

/** Runs the project's tasks; a workspace's changes go to review at the end. VM only if a task needs it. */
async function executeProject() {
  if (!office?.project) throw new Error('계획이 없습니다');
  if (running) throw new Error('이미 작업이 진행 중입니다');
  const project = office.project;
  const needsVm = project.tasks.some(t => placeOf(t) === 'vm' && !['done', 'blocked', 'skipped'].includes(t.status));
  if (review && needsVm) throw new Error('검토를 기다리는 결과가 있습니다. 승인하거나 버린 뒤 시작하세요');
  running = new AbortController();
  status('프로젝트 진행 중');
  const controller = running;
  void office.execute(controller.signal).then(async () => {
    running = undefined;
    status(office!.project?.status === 'done' ? '프로젝트 완료' : '프로젝트 중지');
    // The work was asked for in the conversation: Main answers there, from the results and the Library record. The report itself stays in this tab.
    if (project.status === 'done' && chat) {
      const report = project.report ?? '';
      const root = paths!.root;
      const inVault = async (relative: string) => {
        const target = resolve(root, relative);
        if (!target.startsWith(root + '/')) return false;
        return stat(target).then(s => s.isFile(), () => false);
      };
      void chat.conclude(concludeBrief(project), report, AbortSignal.timeout(10 * 60_000), project.knowledge ?? [], inVault).catch(() => chat!.note(report, false).catch(() => {}));
    }
    // A project that did not reach its report still gets a word in the conversation.
    if (project.status === 'failed') void chat?.note(`프로젝트를 끝내지 못했습니다: ${project.error ?? '원인을 알 수 없습니다'}. 작업 탭에서 다시 시작하거나 닫을 수 있습니다.`, true).catch(() => {});
    else if (project.status === 'stopped') void chat?.note('프로젝트를 중지했습니다. 작업 탭에서 이어서 하거나 닫을 수 있습니다.').catch(() => {});
    if (project.workspace && project.workspace === saved?.task) await collect().catch(error => log(`결과를 가져오지 못했습니다: ${error.message}`));
    // Enough new lessons and decisions since the last time: tidy them now, while nothing reads them.
    if (project.status === 'done' && !dreaming && await dream!.due().catch(() => false)) { try { tidyLibrary(); } catch {} }
  });
  return {};
}

/**
 * A Dream Sequence: the Library's lessons and decisions are merged and put away in the background;
 * the report comes into the chat with Main. Not while a project is working (it reads those notes).
 */
function tidyLibrary() {
  if (dreaming) throw new Error('Library를 이미 정리하는 중입니다');
  if (running) throw new Error('작업이 진행 중입니다. 끝난 뒤 정리합니다');
  const controller = dreaming = new AbortController();
  event('dream', { running: true });
  void dream!.run(controller.signal).then(
    report => { log(`Library 정리: 합침 ${report.merged.length}건, 보관 ${report.retired.length}건, 확인 필요 ${report.conflicts.length}건`); return chat!.note(describeDream(report)); },
    error => chat!.note(controller.signal.aborted ? 'Library 정리를 멈췄습니다. 바뀐 것은 없습니다.' : `Library를 정리하지 못했습니다: ${String(error?.message ?? error)}`, true),
  ).finally(() => { dreaming = undefined; event('dream', { running: false }); });
  return {};
}

/**
 * The Library Manager looks over the user's notes and suggests links and moves, in the background.
 * Nothing in the Vault changes here; the user picks what to apply (applyCuration).
 */
function suggestLinks() {
  if (curating) throw new Error('이미 노트를 살펴보는 중입니다');
  const controller = curating = new AbortController();
  event('curation', { curation: curator!.current, running: true });
  void curator!.suggest(controller.signal).then(
    curation => chat!.note(describeCuration(curation)),
    error => chat!.note(controller.signal.aborted ? '노트 살펴보기를 멈췄습니다.' : `제안을 만들지 못했습니다: ${String(error?.message ?? error)}`, true),
  ).finally(() => { curating = undefined; event('curation', { curation: curator!.current, running: false }); });
  return {};
}

/**
 * Main's Desk: the whole picture of the work and of Nidus, from the facts (boards, the call log,
 * the activity log), never from a model. Main reads it with every message, and it is kept in
 * .nidus/local/main-desk/desk.md so a restart or another Main model starts from the same page.
 */
async function mainDesk(): Promise<string> {
  const now = new Date();
  const project = office?.project ?? null;
  const limited = await gateway!.rateLimited().catch(() => [] as string[]);
  const models = await loadTable(paths!.modelsFile).then(table => describeModels(table, gateway!.health(), now, limited), () => '');
  const history = await new BoardStore(join(paths!.local, 'board')).recent(9).catch(() => []);
  const usage = (() => { try { return describeUsage(gateway!.usageSummary()); } catch { return ''; } })();
  const state = [
    `Running: ${running ? 'yes' : 'no'}. VM: ${vm}${vmHolderNote()}.`,
    approvals.size ? `${approvals.size} network approval(s) wait for the user in the Work tab; the Worker is paused until then.` : '',
    browser?.control === 'user' ? 'The user has taken over the browser; the Worker waits for it back.' : '',
    review ? "A result is waiting for the user's review in the Work tab." : '',
    dreaming ? 'The Library is being tidied (Dream Sequence).' : '',
    curating ? "The user's notes are being looked over for links and moves." : '',
    ...(project?.agendas ?? []).filter(a => !a.decision).map(a => `Meeting Room: "${a.title}" waits for the user's decision${a.taskId ? ` (task ${a.taskId} is paused until then)` : ''}, raised by the ${a.from} ${elapsed(now.getTime() - Date.parse(a.at))} ago.`),
    project?.status === 'done' && !project.closed && project.report ? `The last project ended; its final report: ${project.report.slice(0, 800)}` : '',
  ].filter(Boolean).join('\n');
  return renderMainDesk({ now, state, project, activity, models, history, usage });
}

let deskTimer: ReturnType<typeof setTimeout> | undefined;
/** Writes Main's Desk a moment after things change (many events come in bursts). */
function deskSoon() {
  if (!paths || deskTimer) return;
  deskTimer = setTimeout(() => {
    deskTimer = undefined;
    void mainDesk().then(async text => {
      const file = join(paths!.local, 'main-desk', 'desk.md'), pending = `${file}.${randomUUID()}.pending`;
      await mkdir(join(paths!.local, 'main-desk'), { recursive: true });
      await writeFile(pending, text);
      await rename(pending, file);
    }).catch(() => {});
  }, 3000);
}

/** What Main is told with each chat message: its Desk, the staff, what the Library holds. */
async function chatContext(): Promise<string> {
  const desk = await mainDesk();
  const staff = await home!.staff().then(describeStaff, () => '');
  const learned = await library!.digest(2500).catch(() => '');
  return [desk, staff ? `Standing teams:\n${staff}` : '', learned ? `In the Library (the team's notes):\n${learned}` : ''].filter(Boolean).join('\n\n');
}

const vmHolderNote = () => spaces.holder ? `, used by ${spaces.holder}` : '';

/** Planning runs in the background; the app follows it through project events. */
function planning(step: (signal: AbortSignal) => Promise<Project>) {
  if (running) throw new Error('이미 작업이 진행 중입니다');
  running = new AbortController();
  status('Main이 계획 중');
  const controller = running;
  void step(controller.signal).finally(() => { running = undefined; status(); });
  return {};
}

// --- commands -----------------------------------------------------------------------

const commands: Record<string, (m: any) => Promise<unknown>> = {
  open: m => open(String(m.vault ?? '')),
  gitInit: () => gitInit(),
  start: () => start(),
  stop: () => stop(),
  run: m => run(String(m.instruction ?? ''), m.difficulty as Difficulty, !!m.fresh),
  cancel: async () => { running?.abort(); return {}; },
  plan: async m => {
    const instruction = String(m.instruction ?? '').trim();
    if (!instruction) throw new Error('지시가 비어 있습니다');
    if (review) throw new Error('검토를 기다리는 결과가 있습니다. 승인하거나 버린 뒤 새로 지시하세요');
    taskRuns.clear();
    return planning(signal => office!.plan(instruction, signal));
  },
  planReply: async m => planning(signal => office!.reply(m.answers ?? {}, String(m.note ?? ''), signal)),
  approvePlan: () => executeProject(),
  /** The user's decision on a Meeting Room agenda; the Task waiting for it goes on. */
  decide: async m => {
    if (!office?.project) throw new Error('열린 프로젝트가 없습니다');
    await office.decide(String(m.agenda ?? ''), { kind: m.kind, option: m.option, note: m.note, remember: m.remember });
    return {};
  },
  chat: async m => {
    chatting = new AbortController();
    const answer = await chat!.send(String(m.text ?? ''), chatting.signal);
    return { project: answer.project ?? null };
  },
  cancelChat: async () => { chatting?.abort(); return {}; },
  clearChat: async () => { await chat!.clear(); return {}; },
  dream: async () => tidyLibrary(),
  cancelDream: async () => { dreaming?.abort(); return {}; },
  curate: async () => suggestLinks(),
  cancelCurate: async () => { curating?.abort(); return {}; },
  applyCuration: async m => {
    const done = await curator!.apply(Array.isArray(m.ids) ? m.ids.map(String) : []);
    const applied = done.suggestions.filter(s => s.status === 'applied').length, failed = done.suggestions.filter(s => s.status === 'failed').length;
    log(`문서 연결 제안 적용: ${applied}건${failed ? `, 실패 ${failed}건` : ''}`);
    return {};
  },
  discardCuration: async () => { await curator!.discard(); return {}; },
  librarySearch: async m => ({ hits: await library!.search(String(m.query ?? ''), 30) }),
  libraryRules: async () => ({ rules: await libraryRules(join(paths!.nidus, 'office', 'library.json')) }),
  setLibraryRules: async m => ({ rules: await setLibraryRules(join(paths!.nidus, 'office', 'library.json'), String(m.rules ?? '')) }),
  staff: async () => ({ ...await home!.staff(), states: await home!.states() }),
  addGroup: async m => home!.addGroup({ name: m.name, focus: m.focus }),
  hire: async m => home!.hire({ group: m.group, name: m.name, role: m.role }),
  editEmployee: async m => home!.editEmployee(m.employee, { name: m.name, role: m.role }),
  editGroup: async m => home!.editGroup(m.group, { name: m.name, focus: m.focus }),
  /** The Desks of the open project (or the last one): what each Worker knows of its Task. */
  desks: async () => {
    const project = office?.project ?? await new BoardStore(join(paths!.local, 'board')).latest();
    if (!project) return { project: null, desks: [] };
    const list = [];
    for (const t of project.tasks) {
      const desk = await desks!.load(project.id, t.id).catch(() => null);
      const worker = workerFor(project, t);
      list.push({ task: t.id, title: t.title, status: t.status, employee: worker?.id ?? null, employeeName: worker?.name ?? null,
        desk: desk ? { progress: desk.progress, findings: desk.findings, next: desk.next, references: desk.references, updatedAt: desk.updatedAt, checkpoints: desk.checkpoints.slice(-3) } : null });
    }
    return { project: { id: project.id, instruction: project.instruction, status: project.status }, desks: list };
  },
  mainDesk: async () => ({ text: await mainDesk() }),
  setPrinciples: async m => home!.setPrinciples(String(m.employee ?? ''), Array.isArray(m.principles) ? m.principles : []),
  closeProject: async () => {
    if (running) throw new Error('진행 중에는 닫을 수 없습니다. 먼저 중지하세요');
    if (office?.project) { office.project.closed = true; await new BoardStore(join(paths!.local, 'board')).save(office.project); office.project = null; }
    publishProject();
    return {};
  },
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
    if (resolve && ['once', 'always', 'deny'].includes(m.answer)) { note(`네트워크 승인 답: ${m.answer}`); approvals.delete(String(m.approval)); resolve(m.answer); event('approvalDone', { id: m.approval }); gate.settled(); }
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
