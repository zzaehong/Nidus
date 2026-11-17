import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office } from '../dist/office/office.js';
import { BoardStore } from '../dist/office/board.js';
import { parseLead, MAX_FOLLOW_UPS } from '../dist/office/lead.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const plan = JSON.stringify({ summary: '맥미니 가격 비교표', roadmap: ['조사', '정리'], teams: [{ id: 'research', name: '조사', focus: 'f' }], tasks: [
  { id: 't1', team: 'research', title: '가격 조사', where: 'text', goal: '가격 수집', acceptance: ['세 곳 이상'] },
], questions: [] });
const followUp = (id, extra = {}) => ({ id, team: 'research', title: `${id} 보완`, where: 'text', goal: '할인가 확인', acceptance: ['정가와 할인가'], dependsOn: ['t1'], ...extra });

async function setup(t, lead) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-lead-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], events = [], works = [];
  let leadCalls = 0;
  const gateway = { async send(target, request) {
    const last = request.messages.at(-1).content[0].text;
    calls.push({ role: target.role, last });
    let text;
    if (target.role === 'lead-manager') { const a = lead(last, leadCalls++); if (a instanceof Error) throw a; text = a; }
    else if (target.role === 'red-team') text = JSON.stringify({ summary: '쿠팡 가격이 할인가인지 모름', findings: [{ severity: 'major', target: '쿠팡 가격', problem: '할인가 불명' }] });
    else if (target.role === 'main') text = last.includes('All tasks have ended') ? '보고' : plan;
    else if (last.includes("Write the Worker's instructions")) text = '{"difficulty":"normal","instructions":"하라"}';
    else text = '{"verdict":"accept","summary":"수집함","verification":"링크"}';
    return { response: { provider: 'p', model: `${target.role}-m`, content: [{ type: 'text', text }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const o = new Office({ gateway, store: new BoardStore(dir), retryWaits: [], repository: async () => '',
    work: async task => { works.push(task.id); return { outcome: { status: 'finished', summary: 's' }, evidence: 'e', output: `${task.id} 결과` }; }, onEvent: e => events.push(e) });
  await o.plan('맥미니 가격 비교', new AbortController().signal);
  return { o, calls, events, works };
}

test('the Lead Manager answers the Red Team and adds follow-up tasks; they run as another round, reviewed again, then it closes', async t => {
  const { o, calls, events, works } = await setup(t, (last, n) => n === 0
    ? JSON.stringify({ verdict: 'follow-up', assessment: '할인가 확인이 빠졌습니다.', responses: [{ target: '쿠팡 가격', answer: 'fix: by task f1' }], tasks: [followUp('f1')] })
    : JSON.stringify({ verdict: 'close', assessment: '이제 요청이 충족됩니다.', responses: [{ target: '쿠팡 가격', answer: 'fix: f1에서 확인함' }] }));
  const done = await o.execute(new AbortController().signal);
  assert.equal(done.status, 'done');
  assert.deepEqual(works, ['t1', 'f1']);
  assert.deepEqual(done.tasks.map(x => [x.id, x.status, x.assignee]), [['t1', 'done', 'research-worker'], ['f1', 'done', 'research-worker']]);
  assert.deepEqual(done.lead.rounds.map(r => [r.verdict, r.added]), [['follow-up', ['f1']], ['close', []]]);
  const leadAsks = calls.filter(c => c.role === 'lead-manager');
  assert.match(leadAsks[0].last, /Red Team review \(concerns\): 쿠팡 가격이 할인가인지 모름/);
  assert.match(leadAsks[0].last, /Follow-up rounds left: 2/);
  assert.match(leadAsks[1].last, /Your earlier rounds:\n- round 1: follow-up\. 할인가 확인이 빠졌습니다\. Added f1\./);
  assert.match(leadAsks[1].last, /Follow-up rounds left: 1/);
  assert.equal(calls.filter(c => c.role === 'red-team').length, 2, 'each round is reviewed');
  const order = calls.map(c => c.role === 'red-team' ? 'R' : c.role === 'lead-manager' ? 'L' : c.last.includes('All tasks have ended') ? 'F' : '.').join('');
  assert.match(order, /^\.+RL\.+RLF$/);
  assert.ok(events.some(e => e.title === 'Lead Manager · 후속 Task 1개' && /쿠팡 가격: fix: by task f1/.test(e.text)));
});

test('follow-up rounds are capped; then the Lead Manager may only close', async t => {
  let n = 0;
  const { o, calls } = await setup(t, last => last.includes('No follow-up rounds are left')
    ? JSON.stringify({ verdict: 'close', assessment: '남은 것: 할인가 일부 미확인' })
    : JSON.stringify({ verdict: 'follow-up', assessment: '더 필요', tasks: [followUp(`f${++n}`)] }));
  const done = await o.execute(new AbortController().signal);
  assert.equal(done.status, 'done');
  assert.equal(done.lead.rounds.filter(r => r.verdict === 'follow-up').length, MAX_FOLLOW_UPS);
  assert.equal(done.lead.rounds.at(-1).verdict, 'close');
  assert.equal(done.tasks.length, 1 + MAX_FOLLOW_UPS);
  assert.doesNotMatch(calls.filter(c => c.role === 'lead-manager').at(-1).last, /"follow-up"/, 'follow-up is no longer offered');
});

test('a question only the user can settle goes to the Meeting Room; the Lead Manager decides again with the answer', async t => {
  const agenda = { title: '할인가까지 조사할까요?', background: '시간이 두 배', options: [{ label: '한다', impact: '하루 더' }, { label: '안 한다', impact: '정가만' }] };
  const { o, calls } = await setup(t, (last, n) => n === 0 ? JSON.stringify({ verdict: 'escalate', assessment: '범위 판단 필요', agenda }) : JSON.stringify({ verdict: 'close', assessment: '사용자 결정대로 정가만으로 마칩니다.' }));
  const running = o.execute(new AbortController().signal);
  const open = await new Promise(resolve => { const tick = () => { const a = o.project?.agendas?.find(x => !x.decision); a ? resolve(a) : setTimeout(tick, 5); }; tick(); });
  assert.equal(open.from, 'lead-manager');
  await o.decide(open.id, { kind: 'option', option: 1 });
  const done = await running;
  assert.equal(done.status, 'done');
  const second = calls.filter(c => c.role === 'lead-manager')[1].last;
  assert.match(second, /The user's decisions \(Meeting Room\):\n- "할인가까지 조사할까요\?": The user chose: 안 한다 \(정가만\)\./);
  assert.doesNotMatch(second, /"escalate"/, 'one question per decision');
});

test('without a Lead Manager model the project closes as before, and the reason is said', async t => {
  const { o, events } = await setup(t, () => Object.assign(new Error('roles.lead-manager: no candidates listed'), { code: 'invalid_request' }));
  const done = await o.execute(new AbortController().signal);
  assert.equal(done.status, 'done');
  assert.match(done.lead.skipped, /no candidates listed/);
  assert.ok(events.some(e => e.title === 'Lead Manager 판단을 건너뛰었습니다'));
});

test('follow-up tasks are checked: known teams, new ids, dependencies on earlier tasks only', () => {
  const project = { teams: [{ id: 'research' }], staff: [{ id: 'r1', group: 'research', kind: 'worker' }], tasks: [{ id: 't1' }], agendas: [] };
  const answer = (tasks, verdict = 'follow-up') => JSON.stringify({ verdict, assessment: 'a', tasks });
  assert.deepEqual(parseLead(answer([followUp('f1'), followUp('f2', { dependsOn: ['f1'] })]), project, 1, true).tasks.map(x => [x.id, x.assignee]), [['f1', 'r1'], ['f2', 'r1']]);
  assert.throws(() => parseLead(answer([followUp('t1')]), project, 1, true), /id is taken/);
  assert.throws(() => parseLead(answer([followUp('f1', { team: 'sales' })]), project, 1, true), /unknown team/);
  assert.throws(() => parseLead(answer([followUp('f1', { dependsOn: ['f2'] }), followUp('f2')]), project, 1, true), /unknown dependency f2/);
  assert.throws(() => parseLead(answer([]), project, 1, true), /at least one task/);
  assert.throws(() => parseLead(answer([followUp('f1')]), project, 0, true), /verdict must be close, escalate/);
  assert.throws(() => parseLead(JSON.stringify({ verdict: 'close' }), project, 1, true), /assessment/);
  assert.throws(() => parseLead(JSON.stringify({ verdict: 'escalate', assessment: 'a' }), project, 1, false), /verdict must be close, follow-up$/);
});
