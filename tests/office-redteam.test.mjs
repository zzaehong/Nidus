import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Office } from '../dist/office/office.js';
import { BoardStore } from '../dist/office/board.js';
import { parseRedTeam, describeRedTeam } from '../dist/office/redteam.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const plan = JSON.stringify({ summary: '맥미니 가격 비교표', roadmap: [], teams: [{ id: 'research', name: '조사', focus: 'f' }], tasks: [
  { id: 't1', team: 'research', title: '가격 조사', where: 'text', goal: '가격 수집', acceptance: ['세 곳 이상'], verification: '출처 확인' },
], questions: [] });

async function setup(t, redTeam) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-red-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], events = [];
  let reviews = 0;
  const gateway = { async send(target, request) {
    const last = request.messages.at(-1).content[0].text;
    calls.push({ role: target.role, system: request.system, last });
    let text;
    if (target.role === 'red-team') { const answer = redTeam(last); if (answer instanceof Error) throw answer; text = answer; }
    else if (target.role === 'lead-manager') text = '{"verdict":"close","assessment":"요청한 비교는 됐습니다.","responses":[{"target":"쿠팡 가격","answer":"rebut: 할인가라고 표에 적혀 있음"}]}';
    else if (target.role === 'main') text = last.includes('All tasks have ended') ? '보고' : plan;
    else if (last.includes("Write the Worker's instructions")) text = '{"difficulty":"normal","instructions":"하라"}';
    else text = reviews++ === 0 ? '{"verdict":"revise","feedback":"쿠팡 가격이 빠짐 (내부 검토)","summary":"x"}' : '{"verdict":"accept","summary":"세 곳 가격 수집","verification":"출처 링크 확인"}';
    return { response: { provider: 'p', model: `${target.role}-m`, content: [{ type: 'text', text }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const o = new Office({ gateway, store: new BoardStore(dir), retryWaits: [], repository: async () => '',
    work: async () => ({ outcome: { status: 'finished', summary: 's' }, evidence: 'e', output: '쿠팡 99만 원, 애플 95만 원' }), onEvent: e => events.push(e) });
  await o.plan('맥미니 가격 비교', new AbortController().signal);
  return { o, calls, events };
}

test('the Red Team sees the goal, results and evidence (not the team\'s reviews); its findings go into the final report, which must answer them', async t => {
  const { o, calls, events } = await setup(t, () => JSON.stringify({ verdict: 'sound', summary: '가격 출처가 하루 지난 값입니다.', findings: [
    { severity: 'minor', target: '표 형식', problem: '단위 표기가 섞임' },
    { severity: 'major', target: '쿠팡 가격', problem: '할인 쿠폰 적용가인지 알 수 없음', scenario: '실제 결제가가 다를 수 있음', suggestion: '정가와 할인가를 나눠 적기' },
  ] }));
  const done = await o.execute(new AbortController().signal);
  assert.equal(done.status, 'done');
  const red = calls.find(c => c.role === 'red-team');
  assert.match(red.system, /^You are the Red Team/);
  assert.match(red.last, /The user's request: 맥미니 가격 비교/);
  assert.match(red.last, /Result: 세 곳 가격 수집\n  Evidence: 출처 링크 확인/);
  assert.match(red.last, /쿠팡 99만 원/);
  assert.doesNotMatch(red.last, /내부 검토/, 'the team\'s own reviews are not shown');
  assert.equal(done.redTeam.verdict, 'concerns', 'a major finding is a concern, whatever the model said');
  assert.deepEqual(done.redTeam.findings.map(f => f.severity), ['major', 'minor']);
  assert.equal(done.redTeam.model, 'p:red-team-m');
  const final = calls.find(c => c.role === 'main' && c.last.includes('All tasks have ended'));
  assert.match(final.last, /Red Team review \(concerns\): 가격 출처가 하루 지난 값입니다\.\n- \[major\] 쿠팡 가격: 할인 쿠폰 적용가인지 알 수 없음 Scenario: 실제 결제가가 다를 수 있음/);
  assert.match(final.last, /Answer the Red Team/);
  assert.ok(events.some(e => e.title === 'Red Team 검토 · 우려 있음 (major 1, minor 1)'));
  // Red Team runs after every task and before the report.
  const order = calls.map(c => c.role === 'red-team' ? 'R' : c.role === 'lead-manager' ? 'L' : c.last.includes('All tasks have ended') ? 'F' : '.').join('');
  assert.match(order, /^\.+RLF$/, 'Red Team, then the Lead Manager, then the report');
});

test('a critical matter only the user can settle goes to the Meeting Room; the report waits for the decision and includes it', async t => {
  const agenda = { title: '하루 지난 가격으로 결론을 낼까요?', background: '가격이 매일 바뀝니다.', options: [{ label: '그대로', impact: '오차 가능' }, { label: '다시 조사', impact: '시간 더 듦' }] };
  const { o, calls } = await setup(t, () => JSON.stringify({ summary: '가격 시점이 문제입니다.', findings: [{ severity: 'critical', target: '결론', problem: '가격이 오래됨' }], agenda }));
  const running = o.execute(new AbortController().signal);
  const open = await new Promise(resolve => { const tick = () => { const a = o.project?.agendas?.find(x => !x.decision); a ? resolve(a) : setTimeout(tick, 5); }; tick(); });
  assert.deepEqual([open.from, open.taskId], ['red-team', null]);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!calls.some(c => c.last.includes('All tasks have ended')), 'no report before the decision');
  await o.decide(open.id, { kind: 'option', option: 0, note: '오늘 기준이라고 적어 줘' });
  const done = await running;
  assert.equal(done.status, 'done');
  assert.equal(done.agendas[0].applied, true);
  const final = calls.find(c => c.last.includes('All tasks have ended'));
  assert.match(final.last, /The user's decisions \(Meeting Room\):\n- "하루 지난 가격으로 결론을 낼까요\?": The user chose: 그대로 \(오차 가능\)\. The user adds: 오늘 기준이라고 적어 줘/);
});

test('without a Red Team model the review is skipped and said so; the project still ends', async t => {
  const { o, events, calls } = await setup(t, () => Object.assign(new Error('roles.red-team: no candidates listed'), { code: 'invalid_request' }));
  const done = await o.execute(new AbortController().signal);
  assert.equal(done.status, 'done');
  assert.equal(done.redTeam.verdict, 'skipped');
  assert.match(done.redTeam.skipped, /no candidates listed/);
  assert.ok(events.some(e => e.title === 'Red Team 검토를 건너뛰었습니다' && /Red Team 칸/.test(e.text)));
  const final = calls.find(c => c.last.includes('All tasks have ended'));
  assert.match(final.last, /Red Team review: not done \(roles\.red-team: no candidates listed\)/);
  assert.doesNotMatch(final.last, /Answer the Red Team/);
});

test('parseRedTeam: a summary is required, findings are ordered by severity, and the verdict follows them', () => {
  assert.throws(() => parseRedTeam('{"findings": []}'), /summary/);
  const r = parseRedTeam(JSON.stringify({ verdict: 'concerns', summary: 's', findings: [{ severity: 'minor', problem: 'a' }, { severity: 'weird', problem: 'b' }, { severity: 'critical', problem: 'c' }, { problem: '' }] }));
  assert.deepEqual(r.findings.map(f => [f.severity, f.problem]), [['critical', 'c'], ['minor', 'a'], ['minor', 'b']]);
  assert.equal(parseRedTeam(JSON.stringify({ verdict: 'concerns', summary: 's', findings: [{ severity: 'minor', problem: 'a' }] })).verdict, 'sound');
  assert.throws(() => parseRedTeam(JSON.stringify({ summary: 's', agenda: { title: 'x', options: ['하나'] } })), /at least two options/);
  assert.equal(describeRedTeam(undefined), '');
});
