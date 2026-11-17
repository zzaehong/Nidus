import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Office } from '../dist/office/office.js';
import { BoardStore } from '../dist/office/board.js';
import { DeskStore } from '../dist/office/desk.js';
import { Library } from '../dist/office/library.js';
import { parseReview } from '../dist/office/plan.js';
import { checkDecision, decisionText } from '../dist/office/meeting.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const plan = JSON.stringify({ summary: '노트북 고르기', roadmap: [], teams: [{ id: 'research', name: '조사', focus: 'f' }], tasks: [
  { id: 't1', team: 'research', title: '후보 비교', where: 'text', goal: '후보 셋 비교', acceptance: ['셋 이상'] },
  { id: 't2', team: 'research', title: '사양 정리', where: 'text', goal: '사양표', acceptance: ['표'] },
], questions: [] });
const agenda = { title: '예산을 넘는 모델을 넣을까요?', background: '조건에 맞는 셋 중 하나가 예산보다 30만 원 비쌉니다.', reasoning: '성능 차이가 큽니다.', options: [{ label: '넣는다', impact: '예산 초과' }, { label: '뺀다', impact: '후보가 둘' }], recommendation: '넣되 표시한다' };

async function setup(t, reviews) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-meeting-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const events = [], works = [];
  const gateway = { async send(target, request) {
    const last = request.messages.at(-1).content[0].text;
    let text;
    if (target.role === 'main') text = last.includes('All tasks have ended') ? '보고' : plan;
    else if (last.includes("Write the Worker's instructions")) text = '{"difficulty":"normal","instructions":"하라"}';
    else text = reviews(last);
    return { response: { provider: 'p', model: `${target.role}-m`, content: [{ type: 'text', text }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const desk = new DeskStore(join(dir, '.nidus', 'local', 'desk'));
  const library = new Library(dir);
  const store = new BoardStore(join(dir, '.nidus', 'local', 'board'));
  const make = () => new Office({ gateway, store, desk, retryWaits: [], repository: async () => '',
    work: async (task, instruction, difficulty, signal, revision) => { works.push({ task: task.id, instruction, revision }); return { outcome: { status: 'finished', summary: 's' }, evidence: 'e', output: '결과' }; },
    onEvent: e => events.push(e) });
  return { dir, events, works, desk, library, store, make };
}
/** Resolves when the project has an open agenda. */
const agendaOpen = (o) => new Promise(resolve => { const tick = () => { const a = o.project?.agendas?.find(x => !x.decision); a && o.project.tasks.find(x => x.id === a.taskId)?.status === 'waiting_user' ? resolve(a) : setTimeout(tick, 5); }; tick(); });

test('a Manager puts a decision to the user; the Task waits while the others go on; the choice reaches the Worker without using up a try', async t => {
  let asked = false;
  const { events, works, make } = await setup(t, last => {
    if (last.includes('후보 비교') && !asked) { asked = true; return JSON.stringify({ verdict: 'escalate', agenda }); }
    return '{"verdict":"accept","summary":"ok"}';
  });
  const o = make();
  await o.plan('노트북 골라 줘', new AbortController().signal);
  const running = o.execute(new AbortController().signal);
  const open = await agendaOpen(o);
  assert.equal(open.id, 'a1');
  assert.equal(open.from, 'manager');
  assert.deepEqual(open.options.map(x => x.label), ['넣는다', '뺀다']);
  assert.equal(o.project.tasks[0].status, 'waiting_user');
  assert.ok(events.some(e => e.title === 'Meeting Room · 예산을 넘는 모델을 넣을까요?' && /추천: 넣되 표시한다/.test(e.text)));
  // t2 does not depend on t1: it is done while t1 waits.
  await new Promise(resolve => { const tick = () => o.project.tasks[1].status === 'done' ? resolve() : setTimeout(tick, 5); tick(); });
  await assert.rejects(o.decide('a1', { kind: 'option', option: 5 }), /고른 선택지가 없습니다/);
  await o.decide('a1', { kind: 'option', option: 0, note: '표에 예산 초과라고 써 줘' });
  await assert.rejects(o.decide('a1', { kind: 'reject' }), /이미 결정한/);
  const done = await running;
  assert.equal(done.status, 'done');
  const t1 = done.tasks[0];
  assert.equal(t1.status, 'done');
  assert.equal(t1.attempts, 1, 'the decision did not use up a try');
  assert.deepEqual(t1.reviews.map(r => r.verdict), ['escalate', 'decided', 'accept']);
  const after = works.filter(w => w.task === 't1');
  assert.equal(after.length, 2);
  assert.equal(after[1].revision, true);
  assert.match(after[1].instruction, /The user chose: 넣는다 \(예산 초과\)\. The user adds: 표에 예산 초과라고 써 줘/);
  assert.equal(done.agendas[0].applied, true);
});

test('"not this": the Task is blocked with the reason and what depends on it is skipped; a kept decision goes into the Library and the Desk', async t => {
  const { dir, desk, make } = await setup(t, last => last.includes('후보 비교') ? JSON.stringify({ verdict: 'escalate', agenda }) : '{"verdict":"accept","summary":"ok"}');
  const o = make();
  o.deps.library = new Library(dir);
  await o.plan('노트북 골라 줘', new AbortController().signal);
  o.project.tasks[1].dependsOn = ['t1'];
  const running = o.execute(new AbortController().signal);
  await agendaOpen(o);
  await o.decide('a1', { kind: 'reject', note: '이번엔 안 산다', remember: true });
  const done = await running;
  assert.deepEqual(done.tasks.map(x => x.status), ['blocked', 'skipped']);
  assert.match(done.tasks[0].result.summary, /사용자가 진행하지 않기로 했습니다: 예산을 넘는 모델을 넣을까요\? \(이번엔 안 산다\)/);
  assert.deepEqual(await readdir(join(dir, 'Nidus', 'Decisions')), ['예산을 넘는 모델을 넣을까요.md']);
  assert.match(await readFile(join(dir, 'Nidus', 'Decisions', '예산을 넘는 모델을 넣을까요.md'), 'utf8'), /decided-by: user[\s\S]*결정: 하지 않음\n사용자: 이번엔 안 산다[\s\S]*- 넣는다 — 예산 초과/);
  const d = await desk.load(done.id, 't1');
  assert.ok(d.checkpoints.some(c => c.kind === 'note' && /Meeting Room "예산을 넘는 모델을 넣을까요\?": The user decided not to do this/.test(c.text)));
});

test('an open question survives a restart: the Task picks it up without a new brief, and goes on once the user decides', async t => {
  let asked = 0;
  const { works, make, store } = await setup(t, last => last.includes('후보 비교') && !asked++ ? JSON.stringify({ verdict: 'escalate', agenda }) : '{"verdict":"accept","summary":"ok"}');
  const first = make();
  await first.plan('노트북 골라 줘', new AbortController().signal);
  const stop = new AbortController();
  const running = first.execute(stop.signal);
  await agendaOpen(first);
  stop.abort();
  const stopped = await running;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.tasks[0].status, 'waiting_user', 'the question stays open');
  // The app restarts: a new Office reads the board.
  const second = make();
  second.project = await store.latest();
  const before = works.filter(w => w.task === 't1').length;
  const resumed = second.execute(new AbortController().signal);
  const open = await agendaOpen(second);
  assert.equal(open.id, 'a1', 'the same question, not a new one');
  await second.decide('a1', { kind: 'instruct', note: '두 가지 모두 표로 보여 줘' });
  const done = await resumed;
  assert.equal(done.tasks[0].status, 'done');
  const resumedWork = works.filter(w => w.task === 't1').slice(before);
  assert.equal(resumedWork.length, 1, 'no work before the decision; one run after it');
  assert.match(resumedWork[0].instruction, /instructs: 두 가지 모두 표로 보여 줘/);
  assert.equal(resumedWork[0].revision, true);
  assert.equal(done.agendas.length, 1);
});

test('agendas and decisions are checked', () => {
  assert.throws(() => parseReview(JSON.stringify({ verdict: 'escalate', agenda: { title: 'x', options: ['하나'] } })), /at least two options/);
  assert.throws(() => parseReview(JSON.stringify({ verdict: 'escalate' })), /agenda.title/);
  const r = parseReview(JSON.stringify({ verdict: 'escalate', agenda: { ...agenda, options: ['A', { label: 'B', impact: 'b' }] } }));
  assert.deepEqual(r.agenda.options, [{ label: 'A', impact: '' }, { label: 'B', impact: 'b' }]);
  assert.equal(r.summary, agenda.title);
  const a = { ...agenda, id: 'a1', from: 'manager', taskId: 't1', at: '' };
  assert.throws(() => checkDecision(a, { kind: 'instruct', note: ' ' }), /지시를 적어/);
  assert.throws(() => checkDecision(a, { kind: 'maybe' }), /종류/);
  assert.equal(checkDecision(a, { kind: 'option', option: 1 }).remember, false);
  assert.equal(decisionText({ ...a, decision: checkDecision(a, { kind: 'option', option: 1 }) }), 'The user chose: 뺀다 (후보가 둘).');
});
