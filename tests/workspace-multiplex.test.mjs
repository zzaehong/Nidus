import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskWorkspaces } from '../dist/workspace/workspaces.js';

/** A VM like the real one: one session at a time, and a session works in the workspace current when it starts. */
function fakeVm() {
  const log = [];
  let current = null, busy = false;
  const workspaces = new Set();
  const vm = {
    log, runningServices: [],
    async selectWorkspace(ws) { log.push(`select ${ws}`); if (!workspaces.has(ws)) return false; current = ws; return true; },
    async importWorkspace(ws) { workspaces.add(ws); current = ws; log.push(`import ${ws}`); return 'c'.repeat(40); },
    async exportWorkspace(ws) { log.push(`export ${ws}`); return { head: 'd'.repeat(40), bundle: null }; },
    async removeWorkspace(ws) { workspaces.delete(ws); log.push(`remove ${ws}`); },
    async execute(id, command, seconds) {
      if (busy) throw new Error('vm_execution_active');
      busy = true;
      const where = current;
      await new Promise(r => setTimeout(r, 5));
      busy = false;
      log.push(`run ${where}: ${command}`);
      return { exitCode: 0, stdout: `${where}\n`, stderr: '', reason: 'completed' };
    },
    cancel() {},
    async startService(id) { this.runningServices.push(id); log.push(`service ${current}`); },
    async stopService(id) { this.runningServices = this.runningServices.filter(x => x !== id); },
  };
  return vm;
}

function fakeBrowser() {
  let tabs = [{ id: 'T0', url: 'about:blank', title: '', active: true }], n = 0;
  const actions = [];
  return {
    actions,
    get activeTab() { return tabs.find(t => t.active)?.id; },
    listTabs: () => tabs,
    async act(action) {
      if (action.op === 'newTab') { tabs.forEach(t => t.active = false); tabs.push({ id: `T${++n}`, url: action.url, title: '', active: true }); }
      else if (action.op === 'switchTab') tabs.forEach(t => t.active = t.id === action.tabId);
      else actions.push(`${this.activeTab} ${action.op} ${action.url ?? ''}`.trim());
      await new Promise(r => setTimeout(r, 2));
      return { url: action.url ?? '' };
    },
  };
}

test('two Tasks run their Shell commands side by side, each always in its own workspace, never two sessions at once', async () => {
  const vm = fakeVm();
  const spaces = new TaskWorkspaces({ vm: () => vm, browser: async () => fakeBrowser() });
  await spaces.import('p-a', Buffer.from('x'));
  await spaces.import('p-b', Buffer.from('x'));
  const a = spaces.runtime('p-a'), b = spaces.runtime('p-b');
  const results = await Promise.all([a.shell('ls 1', 10), b.shell('ls 2', 10), a.shell('ls 3', 10), b.shell('ls 4', 10)]);
  assert.deepEqual(results.map(r => r.stdout.trim()), ['p-a', 'p-b', 'p-a', 'p-b'], 'each command saw its own workspace');
  assert.deepEqual(vm.log.filter(l => l.startsWith('run')).sort(), ['run p-a: ls 1', 'run p-a: ls 3', 'run p-b: ls 2', 'run p-b: ls 4']);
  // The workspace is selected only when another one was current.
  const afterImport = vm.log.slice(2);
  assert.ok(afterImport.every((line, i) => !line.startsWith('run') || afterImport.slice(0, i).reverse().find(l => l.startsWith('select') || l.startsWith('import'))?.endsWith(line.split(' ')[1].replace(':', ''))), afterImport.join(' | '));
  // A service binds its own workspace.
  await b.startService('dev', 'npm run dev');
  assert.equal(vm.log.at(-1), 'service p-b');
  assert.deepEqual(b.services(), ['dev']);
  assert.deepEqual(a.services(), [], 'services are per workspace');
  // After a VM restart nothing is assumed current.
  spaces.reset();
  await a.shell('pwd', 10);
  assert.deepEqual(vm.log.slice(-2), ['select p-a', 'run p-a: pwd']);
  await assert.rejects(spaces.runtime('p-missing').shell('ls', 10), /VM에 없습니다/);
});

test('each Task browses in a tab of its own; a tab it opens becomes its tab', async () => {
  const browser = fakeBrowser();
  const spaces = new TaskWorkspaces({ vm: () => fakeVm(), browser: async () => browser });
  const a = await spaces.runtime('p-a').browser(), b = await spaces.runtime('p-b').browser();
  await Promise.all([a.act({ op: 'navigate', url: 'https://a.example' }), b.act({ op: 'navigate', url: 'https://b.example' })]);
  await a.act({ op: 'observe' });
  assert.deepEqual(browser.actions, ['T1 navigate https://a.example', 'T2 navigate https://b.example', 'T1 observe']);
  await b.act({ op: 'newTab', url: 'https://b2.example' });
  await a.act({ op: 'observe' });
  await b.act({ op: 'observe' });
  assert.deepEqual(browser.actions.slice(-2), ['T1 observe', 'T3 observe']);
});
