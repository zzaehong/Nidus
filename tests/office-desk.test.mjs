import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskStore, DESK_TOOL, withDesk, renderDesk, recoveryBrief, deskHasContext } from '../dist/office/desk.js';
import { workerSystem } from '../dist/office/roles.js';
import { WorkerRun, resetCooling } from '../dist/workspace/worker.js';

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-desk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, desks: new DeskStore(dir) };
}
const call = input => ({ type: 'tool_call', id: 'd', name: 'desk_update', input });

test('a Desk keeps progress, findings and the next action; earlier states go into a bounded history', async t => {
  const { desks } = await store(t);
  assert.equal(await desks.load('p-1', 't1'), null);
  await desks.update('p-1', 't1', 'writer', { progress: '초안 1장', next: '2장 쓰기', references: ['notes/a.md'] });
  let desk = await desks.update('p-1', 't1', 'writer', { findings: '독자는 초보자', references: ['notes/a.md', 'notes/b.md'] });
  assert.deepEqual([desk.progress, desk.findings, desk.next, desk.references], ['초안 1장', '독자는 초보자', '2장 쓰기', ['notes/a.md', 'notes/b.md']]);
  assert.equal(desk.checkpoints.length, 1, 'the state before the second update');
  await desks.checkpoint('p-1', 't1', 'writer', 'summary', '세션 요약');
  for (let i = 0; i < 15; i++) desk = await desks.update('p-1', 't1', 'writer', { progress: `단계 ${i}` });
  assert.equal(desk.checkpoints.length, 10);
  assert.ok(desk.checkpoints.some(c => c.kind === 'summary'), 'the session summary outlives the notes');
  assert.match(renderDesk(desk), /Progress: 단계 14\nFindings: 독자는 초보자\nNext action: 2장 쓰기\nReferences: notes\/a.md, notes\/b.md\nSummary of the earlier session[^\n]*\n세션 요약/);
  desk = await desks.checkpoint('p-1', 't1', 'writer', 'final', '통과');
  assert.equal(desk.status, 'closed');
  assert.equal(await desks.load('../x', 't1'), null, 'ids are file names, nothing else');
  assert.equal(deskHasContext(null), false);
});

test('a damaged Desk file falls back to the save before it', async t => {
  const { dir, desks } = await store(t);
  await desks.update('p-1', 't1', null, { progress: '하나' });
  await desks.update('p-1', 't1', null, { progress: '둘' });
  await writeFile(join(dir, 'p-1', 't1.json'), '{"broken');
  assert.equal((await desks.load('p-1', 't1')).progress, '하나');
});

test('the desk_update tool sits beside the Worker\'s tools, before finish, and saves through the store', async t => {
  const { desks } = await store(t);
  const inner = { specs: [{ name: 'read_file' }, { name: 'finish' }], async run(c) { return { content: `inner ${c.name}`, isError: false }; } };
  const tools = withDesk(inner, patch => desks.update('p-1', 't1', 'writer', patch));
  assert.deepEqual(tools.specs.map(s => s.name), ['read_file', 'desk_update', 'finish']);
  assert.equal((await tools.run({ type: 'tool_call', id: 'x', name: 'read_file', input: {} })).content, 'inner read_file');
  assert.match((await tools.run(call({ progress: '절반', next_action: '검증' }))).content, /^Desk updated/);
  assert.equal((await tools.run(call({}))).isError, true);
  const desk = await desks.load('p-1', 't1');
  assert.deepEqual([desk.progress, desk.next, desk.employee], ['절반', '검증', 'writer']);
  assert.match(workerSystem('text', 'p', undefined, true), /- desk_update: /);
  assert.match(workerSystem('vm', 't', undefined, true), /You have a Desk/);
  assert.doesNotMatch(workerSystem('vm', 't'), /desk_update/, 'a Worker without a Desk is not told of one');
  assert.equal(DESK_TOOL.name, 'desk_update');
});

test('recovery tells the Worker where the Task Board and its Desk stand, and which one wins', async t => {
  const { desks } = await store(t);
  const desk = await desks.update('p-1', 't1', 'writer', { progress: '1장 완료', next: '2장' });
  const task = { id: 't1', title: '글쓰기', attempts: 2, reviews: [{ verdict: 'revise', feedback: '예시를 더', at: '' }] };
  const text = recoveryBrief({ id: 'p-1' }, task, desk, 3);
  assert.match(text, /^\[Context recovery/);
  assert.match(text, /Task Board \(source of truth\): task t1 "글쓰기" of project p-1; attempt 2 of 3\./);
  assert.match(text, /1\. revise: 예시를 더/);
  assert.match(text, /Progress: 1장 완료\nFindings: \(nothing noted\)\nNext action: 2장/);
  assert.match(text, /trust those and correct the Desk/);
});

test('after a summary the Worker gets its Desk back, and the summary is kept as a checkpoint', async t => {
  resetCooling();
  const { desks } = await store(t);
  const usage = { inputTokens: 1, outputTokens: 1 };
  let step = 0; const firsts = [];
  const gateway = { async send(target, request) {
    if (request.system.startsWith('You compact')) return { response: { provider: 'p', model: 's', content: [{ type: 'text', text: '요약문' }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
    firsts.push(request.messages[0].content[0].text ?? '');
    step++;
    const content = step === 1 ? [{ type: 'tool_call', id: 'd1', name: 'desk_update', input: { progress: '파일 목록 확인', next_action: '하나씩 읽기' } }]
      : step < 12 ? [{ type: 'tool_call', id: `c${step}`, name: 'read_file', input: { path: `f${step}` } }] : [{ type: 'text', text: '끝' }];
    return { response: { provider: 'p', model: 'm', content, stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const inner = { specs: [], async run() { return { content: 'z'.repeat(9000), isError: false }; } };
  const tools = withDesk(inner, patch => desks.update('p-1', 't1', 'writer', patch));
  const run = new WorkerRun(gateway, tools, { task: 'p-1', difficulty: 'simple', compact: { summarizeAboveChars: 25_000, clearAboveChars: 1_000_000 },
    desk: async () => renderDesk(await desks.load('p-1', 't1')), onSummary: s => desks.checkpoint('p-1', 't1', 'writer', 'summary', s) });
  await run.run('지시', new AbortController().signal);
  const after = firsts.find(f => f.startsWith('[Summary of the work so far'));
  assert.match(after, /Your Desk \(your own notes, kept outside this conversation\):\nProgress: 파일 목록 확인\nFindings: \(nothing noted\)\nNext action: 하나씩 읽기/);
  assert.ok((await desks.load('p-1', 't1')).checkpoints.some(c => c.kind === 'summary' && c.text === '요약문'));
});

test('a text deliverable in progress is kept as a draft beside the Desk', async t => {
  const { desks } = await store(t);
  const { TextTools } = await import('../dist/office/text-work.js');
  const saves = [];
  const tools = new TextTools({ list: async () => [], read: async () => null, search: async () => '' }, text => saves.push(desks.saveDraft('p-1', 't1', text)));
  await tools.run({ type: 'tool_call', id: 'a', name: 'write_deliverable', input: { content: '1단락\n' } });
  await tools.run({ type: 'tool_call', id: 'b', name: 'write_deliverable', input: { content: '2단락\n', append: true } });
  await Promise.all(saves);
  assert.equal(await desks.loadDraft('p-1', 't1'), '1단락\n2단락\n');
  assert.equal(await desks.loadDraft('p-1', 'none'), undefined);
});
