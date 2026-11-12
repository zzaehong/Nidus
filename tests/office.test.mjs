import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office, MAX_ATTEMPTS } from '../dist/office/office.js';
import { BoardStore } from '../dist/office/board.js';
import { parsePlan } from '../dist/office/plan.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null };
const plan = (extra = {}) => JSON.stringify({
  summary: '맥미니 가격 조사 보고서', roadmap: ['조사', '정리'],
  teams: [{ id: 'research', name: '조사팀', focus: '웹 조사' }, { id: 'docs', name: '문서팀', focus: '정리' }],
  tasks: [
    { id: 't1', team: 'research', title: '가격 조사', goal: '가격 수집', acceptance: ['3곳 이상'], verification: '출처 확인', dependsOn: [] },
    { id: 't2', team: 'docs', title: '보고서 작성', goal: '정리', acceptance: ['prices.md 존재'], verification: 'cat', dependsOn: ['t1'] },
  ],
  questions: ['어느 나라 가격인가요?'], ...extra,
});

/** Answers by role and by what is asked; records every request. */
function gateway(script) {
  const calls = [];
  return {
    calls,
    async send(target, request) {
      calls.push({ target, request: structuredClone(request) });
      const last = request.messages.at(-1).content[0].text;
      const text = script(target.role, last, calls);
      return { response: { provider: 'test', model: `${target.role}-model`, content: [{ type: 'text', text }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
    },
  };
}

async function office(t, script, work) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-office-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [], works = [];
  const g = gateway(script);
  const o = new Office({
    gateway: g, store: new BoardStore(dir), repository: async () => 'README.md', retryWaits: [],
    work: async (task, instruction, difficulty, signal, revision) => { works.push({ task: task.id, instruction, difficulty, revision }); return work ? work(task, works) : { outcome: { status: 'finished', summary: 'done' }, evidence: 'diff' }; },
    onEvent: e => events.push(e),
  });
  return { o, g, events, works, dir };
}

test('Main plans and asks; answers revise the plan; nothing runs before approval', async t => {
  const { o, g, works } = await office(t, (role, last) => role === 'main' ? (last.includes('answered') ? plan({ questions: [] }) : plan()) : '');
  let project = await o.plan('맥미니 가격을 조사해 줘', new AbortController().signal);
  assert.equal(project.status, 'waiting_user');
  assert.deepEqual(project.questions, [{ id: 'q1', text: '어느 나라 가격인가요?' }]);
  assert.equal(project.tasks.length, 2);
  assert.equal(g.calls[0].target.role, 'main');
  assert.match(g.calls[0].request.messages[0].content[0].text, /README\.md/, 'Main sees the repository');
  assert.equal(works.length, 0);
  project = await o.reply({ q1: '한국' }, '쿠팡도 포함', new AbortController().signal);
  assert.equal(project.status, 'waiting_user');
  assert.deepEqual(project.questions, []);
  const revision = g.calls[1].request.messages.at(-1).content[0].text;
  assert.match(revision, /A: 한국/);
  assert.match(revision, /쿠팡도 포함/);
  assert.equal(g.calls[1].request.messages.length, 3, 'the planning conversation continues');
});

test('approved: tasks run in order; the Manager briefs, reviews, asks for a revision, then accepts; Main reports', async t => {
  let reviews = 0;
  const { o, g, events, works, dir } = await office(t, (role, last) => {
    if (role === 'main') return last.includes('All tasks have ended') ? '보고: 끝났습니다' : plan({ questions: [] });
    if (last.includes("Write the Worker's instructions")) return '```json\n{"difficulty": "simple", "instructions": "조사하라"}\n```';
    reviews++;
    return reviews === 1 ? '{"verdict":"revise","feedback":"출처 부족","summary":"부족"}' : '{"verdict":"accept","feedback":"","summary":"완료","verification":"확인함"}';
  });
  await o.plan('조사', new AbortController().signal);
  const project = await o.execute(new AbortController().signal);
  assert.equal(project.status, 'done');
  assert.equal(project.report, '보고: 끝났습니다');
  assert.deepEqual(project.tasks.map(t => [t.id, t.status, t.attempts]), [['t1', 'done', 2], ['t2', 'done', 1]]);
  assert.deepEqual(works.map(w => [w.task, w.difficulty, w.revision]), [['t1', 'simple', false], ['t1', 'simple', true], ['t2', 'simple', false]]);
  assert.match(works[1].instruction, /출처 부족/, 'the revision carries the feedback');
  assert.deepEqual(g.calls.filter(c => c.target.role === 'manager').map(c => c.target.taskId), ['t1', 't1', 't1', 't2', 't2']);
  assert.ok(events.some(e => e.type === 'message' && e.title.includes('수정 요청')));
  assert.equal((await readdir(dir)).length, 1, 'the board is saved');
  assert.equal((await new BoardStore(dir).latest()).status, 'done');
});

test('a task that keeps failing review is blocked and what depends on it is skipped', async t => {
  const { o, works } = await office(t, (role, last) => {
    if (role === 'main') return last.includes('All tasks have ended') ? '보고' : plan({ questions: [] });
    if (last.includes("Write the Worker's instructions")) return '{"difficulty":"normal","instructions":"x"}';
    return '{"verdict":"revise","feedback":"아직","summary":"미완"}';
  });
  await o.plan('x', new AbortController().signal);
  const project = await o.execute(new AbortController().signal);
  assert.equal(works.length, MAX_ATTEMPTS);
  assert.deepEqual(project.tasks.map(t => t.status), ['blocked', 'skipped']);
  assert.equal(project.status, 'done');
});

test('a malformed answer is asked for once more; twice fails the plan', async t => {
  let n = 0;
  const repaired = await office(t, role => (role === 'main' && n++ === 0 ? '계획은 이렇습니다' : plan()));
  assert.equal((await repaired.o.plan('x', new AbortController().signal)).status, 'waiting_user');
  const broken = await office(t, () => 'no json at all');
  const project = await broken.o.plan('x', new AbortController().signal);
  assert.equal(project.status, 'failed');
  assert.match(project.error, /Main의 답을 읽지 못했습니다/);
});

test('stopping during execution leaves the project stopped and resumable', async t => {
  const controller = new AbortController();
  const { o } = await office(t, (role, last) => role === 'main' ? plan({ questions: [] }) : last.includes("Write the Worker's") ? '{"difficulty":"simple","instructions":"x"}' : '{"verdict":"accept","summary":"ok"}',
    () => { controller.abort(); return { outcome: { status: 'stopped', reason: 'user', detail: 'stop' }, evidence: '' }; });
  await o.plan('x', new AbortController().signal);
  const project = await o.execute(controller.signal);
  assert.equal(project.status, 'stopped');
  assert.equal(project.tasks[0].status, 'in_progress');
  const resumed = await o.execute(new AbortController().signal);
  assert.equal(resumed.status, 'done', 'execute again picks up');
});

test('plans are checked: teams, ids, dependencies and cycles', () => {
  const base = JSON.parse(plan());
  const bad = (change, pattern) => assert.throws(() => parsePlan(JSON.stringify(change(structuredClone(base)))), pattern);
  bad(p => { p.tasks[0].team = 'ghost'; return p; }, /unknown team/);
  bad(p => { p.tasks[1].dependsOn = ['t9']; return p; }, /unknown dependency/);
  bad(p => { p.tasks[0].dependsOn = ['t2']; return p; }, /cycle/);
  bad(p => { p.tasks[1].id = 't1'; return p; }, /duplicate/);
  bad(p => { p.tasks[0].acceptance = []; return p; }, /acceptance/);
  bad(p => { p.teams = []; return p; }, /team/);
  assert.equal(parsePlan('Here you go:\n' + plan() + '\nThanks').tasks.length, 2, 'JSON inside prose is found');
});
