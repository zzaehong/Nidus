import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextTools, gitSource, TEXT_TOOLS } from '../dist/office/text-work.js';
import { workerSystem } from '../dist/office/roles.js';
import { WorkerRun } from '../dist/workspace/worker.js';

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-text-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  git('init', '-q');
  await mkdir(join(dir, 'notes'));
  await writeFile(join(dir, 'README.md'), '# 프로젝트\n소개 문서\n');
  await writeFile(join(dir, 'notes', '회의.md'), '회의록\n결정: 맥미니 구매\n');
  await writeFile(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  git('add', '-A'); git('commit', '-qm', 'init');
  // Not committed: a text task sees the committed state only, like a VM workspace.
  await writeFile(join(dir, 'draft.md'), 'uncommitted');
  await writeFile(join(dir, 'README.md'), 'changed but not committed');
  return dir;
}
const call = (name, input) => ({ type: 'tool_call', id: name, name, input });

test('text task tools read the committed repository only, and refuse paths outside it', async t => {
  const tools = new TextTools(gitSource(await repo(t)));
  assert.deepEqual(tools.specs.map(s => s.name), TEXT_TOOLS.map(s => s.name));
  assert.ok(!tools.specs.some(s => ['shell', 'write_file', 'browser_open', 'web_search'].includes(s.name)), 'no VM tools in a text task');
  const list = await tools.run(call('list_files', {}));
  assert.equal(list.content, 'README.md\nlogo.bin\nnotes/회의.md');
  assert.equal((await tools.run(call('list_files', { path: 'notes' }))).content, 'notes/회의.md');
  const readme = await tools.run(call('read_file', { path: '/workspace/README.md' }));
  assert.match(readme.content, /# 프로젝트/);
  assert.doesNotMatch(readme.content, /not committed/);
  assert.match((await tools.run(call('read_file', { path: 'README.md', offset: 6 }))).content, /characters 6-/);
  assert.equal((await tools.run(call('read_file', { path: 'draft.md' }))).isError, true);
  assert.match((await tools.run(call('read_file', { path: 'logo.bin' }))).content, /binary/);
  for (const path of ['../etc/passwd', '/etc/passwd', '--output=x', 'notes/../../x']) {
    const r = await tools.run(call('read_file', { path }));
    assert.equal(r.isError, true, path);
    assert.match(r.content, /inside the repository/, path);
  }
  const found = await tools.run(call('search_files', { pattern: '맥미니' }));
  assert.equal(found.content.trim(), 'notes/회의.md:2:결정: 맥미니 구매');
  assert.equal((await tools.run(call('search_files', { pattern: 'zzz-none' }))).content, 'No matches.');
  assert.equal((await tools.run(call('shell', { command: 'ls' }))).isError, true);
});

test('the deliverable is written in parts or given with finish', async () => {
  const tools = new TextTools({ list: async () => [], read: async () => null, search: async () => '' });
  await tools.run(call('write_deliverable', { content: '# 제목\n' }));
  await tools.run(call('write_deliverable', { content: '본문', append: true }));
  assert.equal(tools.deliverable, '# 제목\n본문');
  const done = await tools.run(call('finish', { summary: '끝' }));
  assert.equal(done.finish, '끝');
  assert.equal(tools.deliverable, '# 제목\n본문', 'finish without a deliverable keeps the written one');
  await tools.run(call('finish', { summary: '끝', deliverable: '새 본문' }));
  assert.equal(tools.deliverable, '새 본문');
  assert.equal((await tools.run(call('write_deliverable', { content: 'x'.repeat(60_001) }))).isError, true);
});

test('a text task Worker runs with the text prompt and tools', async () => {
  const requests = [];
  const usage = { inputTokens: 1, outputTokens: 1 };
  const gateway = { async send(target, request) {
    requests.push({ target, request });
    const content = requests.length === 1
      ? [{ type: 'tool_call', id: 'c1', name: 'finish', input: { summary: '요약', deliverable: '결과물' } }]
      : [{ type: 'text', text: 'x' }];
    return { response: { provider: 'p', model: 'm', content, stopReason: 'tool_use', usage }, costUSD: null, warnings: [] };
  } };
  const tools = new TextTools({ list: async () => [], read: async () => null, search: async () => '' });
  const run = new WorkerRun(gateway, tools, { task: 'p-1', difficulty: 'simple', system: workerSystem('text', 'p-1') });
  const outcome = await run.run('정리하라', new AbortController().signal);
  assert.deepEqual(outcome, { status: 'finished', summary: '요약' });
  assert.equal(tools.deliverable, '결과물');
  assert.match(requests[0].request.system, /This is a text task/);
  assert.deepEqual(requests[0].request.tools.map(t => t.name), TEXT_TOOLS.map(t => t.name));
  assert.deepEqual(requests[0].target, { role: 'worker', difficulty: 'simple', taskId: 'p-1' });
});
