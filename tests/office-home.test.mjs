import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeStore, defaultStaff, parseStaff, describeStaff, identity, managerOf, workersOf } from '../dist/office/home.js';
import { parsePlan, planRequest } from '../dist/office/plan.js';
import { Office } from '../dist/office/office.js';
import { BoardStore } from '../dist/office/board.js';

const usage = { inputTokens: 1, outputTokens: 1 };
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new HomeStore(join(dir, 'office', 'staff.json'), join(dir, 'local', 'home')) };
}
const task = (extra = {}) => ({ id: 't1', team: 'research', title: '조사', where: 'text', goal: 'g', acceptance: ['a'], ...extra });
const planJson = (extra = {}) => JSON.stringify({ summary: 's', roadmap: [], teams: [{ id: 'research' }], tasks: [task()], questions: [], ...extra });

test('a Vault starts with a small standing staff: three teams, each a Manager and a Worker', async t => {
  const { dir, store } = await home(t);
  const staff = await store.staff();
  assert.deepEqual(staff.groups.map(g => g.id), ['research', 'development', 'writing']);
  for (const g of staff.groups) { assert.ok(managerOf(staff, g.id)); assert.equal(workersOf(staff, g.id).length, 1); }
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'office', 'staff.json'), 'utf8')), staff, 'written to the Vault');
  assert.match(describeStaff(staff), /team "research" 조사[\s\S]*manager: research-manager \(조사 팀장\); workers: researcher \(리서처, Researcher\)/);
  // The user's edits are kept, nonsense is dropped, and a second Manager of a team is ignored.
  staff.employees.push({ id: 'x', name: '둘째 팀장', group: 'research', kind: 'manager', role: 'Manager', principles: [] }, { id: 'BAD ID', name: 'x', group: 'research', kind: 'worker' }, { id: 'analyst', name: '분석가', group: 'research', kind: 'worker', role: 'Analyst', principles: ['출처를 적는다'] });
  await writeFile(join(dir, 'office', 'staff.json'), JSON.stringify(staff));
  const again = await store.staff();
  assert.deepEqual(again.employees.filter(e => e.group === 'research').map(e => e.id), ['research-manager', 'researcher', 'analyst']);
  await writeFile(join(dir, 'office', 'staff.json'), '{broken');
  await assert.rejects(store.staff(), /staff\.json/);
});

test('identity names the employee, not a model, and carries the user\'s principles', async t => {
  const { store } = await home(t);
  await store.staff();
  const staff = await store.setPrinciples('researcher', ['  항상 출처를 적는다 ', '']);
  const who = identity(staff.employees.find(e => e.id === 'researcher'), staff.groups[0]);
  assert.match(who, /^You are 리서처 \(id researcher\), a Worker with the role Researcher of the 조사 team/);
  assert.match(who, /whatever model runs you/);
  assert.match(who, /Your own principles, set by the user:\n- 항상 출처를 적는다$/);
  await assert.rejects(store.setPrinciples('nobody', []), /그런 직원/);
  await store.setState({ employee: 'researcher', project: 'p-1', task: 't1', status: 'working' });
  const state = await store.state('researcher');
  assert.deepEqual([state.project, state.task, state.status], ['p-1', 't1', 'working']);
  assert.equal(await store.state('../../etc'), null);
});

test('a plan uses standing teams by id; new teams and hires are proposals; every team gets a Manager and a Worker', () => {
  const standing = defaultStaff();
  const plan = parsePlan(planJson({
    teams: [{ id: 'research', name: '무시됨' }, { id: 'legal', name: '법무', focus: '계약 검토', keep: 'permanent', reason: '계약서가 자주 온다' }, { id: 'event', name: '행사', focus: '행사 준비' }],
    hires: [{ id: 'analyst', team: 'research', name: '분석가', role: 'Analyst', keep: 'permanent', reason: '수치 분석' }, { id: 'planner', team: 'event', name: '기획자', role: 'Planner', keep: 'permanent' }],
    tasks: [task({ assignee: 'analyst' }), task({ id: 't2' }), task({ id: 't3', team: 'legal' }), task({ id: 't4', team: 'event' })],
  }), standing);
  assert.deepEqual(plan.teams.map(t => [t.id, t.name, t.proposed ?? false, t.keep ?? null]), [['research', '조사', false, null], ['legal', '법무', true, 'permanent'], ['event', '행사', true, 'temporary']]);
  const people = Object.fromEntries(plan.staff.map(e => [e.id, e]));
  assert.equal(people['researcher'].proposed, undefined, 'standing staff');
  assert.deepEqual([people['analyst'].proposed, people['analyst'].keep, people['analyst'].group], [true, 'permanent', 'research']);
  assert.equal(people['planner'].keep, 'temporary', 'nobody stays longer than their temporary team');
  assert.deepEqual([people['legal-manager'].kind, people['legal-manager'].keep, people['legal-worker'].kind], ['manager', 'permanent', 'worker']);
  assert.ok(people['event-manager'] && !people['event-worker'], 'the hire is the event team\'s worker');
  assert.deepEqual(plan.tasks.map(t => t.assignee), ['analyst', 'researcher', 'legal-worker', 'planner']);
  assert.throws(() => parsePlan(planJson({ tasks: [task({ assignee: 'developer' })] }), standing), /not a worker of team research/);
  assert.throws(() => parsePlan(planJson({ hires: [{ id: 'researcher', team: 'research', name: 'x', role: 'y' }] }), standing), /already an employee/);
  assert.throws(() => parsePlan(planJson({ hires: [{ id: 'a1', team: 'nowhere', name: 'x', role: 'y' }] }), standing), /unknown team/);
  assert.match(planRequest('x', 'repo', standing), /standing teams of this Vault[\s\S]*team "writing"/);
});

test('approving a plan adds permanent proposals to the Vault\'s staff; temporary ones stay in the project; prompts carry who works', async t => {
  const { dir, store } = await home(t);
  await store.setPrinciples('researcher', ['출처를 적는다']);
  const calls = [], works = [];
  const gateway = { async send(target, request) {
    calls.push({ target, request });
    const last = request.messages.at(-1).content[0].text;
    const text = target.role === 'main'
      ? (last.includes('All tasks have ended') ? '보고' : planJson({ teams: [{ id: 'research' }, { id: 'legal', name: '법무', focus: '계약', keep: 'permanent' }, { id: 'event', name: '행사', focus: '행사' }], tasks: [task(), task({ id: 't2', team: 'legal' }), task({ id: 't3', team: 'event' })] }))
      : last.includes("Write the Worker's instructions") ? '{"difficulty":"simple","instructions":"하라"}' : '{"verdict":"accept","summary":"ok"}';
    return { response: { provider: 'p', model: 'm', content: [{ type: 'text', text }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const events = [];
  const office = new Office({ gateway, store: new BoardStore(join(dir, 'board')), home: store, repository: async () => '', retryWaits: [], maxParallel: 1, onEvent: e => events.push(e),
    work: async task => { works.push(task.id); return { outcome: { status: 'finished', summary: 's' }, evidence: 'e', output: 'o' }; } });
  let project = await office.plan('x', new AbortController().signal);
  assert.match(calls[0].request.messages[0].content[0].text, /team "research" 조사/, 'Main sees the standing staff');
  assert.equal((await store.staff()).groups.length, 3, 'nothing is added before approval');
  assert.equal(project.staff.find(e => e.id === 'legal-manager').proposed, true);
  project = await office.execute(new AbortController().signal);
  assert.equal(project.status, 'done');
  const staff = await store.staff();
  assert.deepEqual(staff.groups.map(g => g.id), ['research', 'development', 'writing', 'legal']);
  assert.ok(staff.employees.some(e => e.id === 'legal-worker' && e.createdAt), 'the permanent team\'s people are staff now');
  assert.ok(!staff.employees.some(e => e.group === 'event'), 'the temporary team is not');
  assert.equal(project.teams.find(t => t.id === 'legal').proposed, false);
  assert.equal(project.teams.find(t => t.id === 'event').proposed, true);
  assert.ok(events.some(e => e.title === '상설 직원 추가' && /법무/.test(e.text)));
  const brief = calls.find(c => c.target.role === 'manager' && c.target.taskId === 't1');
  assert.match(brief.request.system, /^You are 조사 팀장 \(id research-manager\), the Manager of the 조사 team/);
  assert.match(brief.request.messages[0].content[0].text, /The Worker on this task: 리서처 \(Researcher\); their principles: 출처를 적는다/);
  assert.equal((await store.state('researcher')).status, 'done');
  assert.equal((await store.state('research-manager')).task, 't1');
});

test('the user adds a team (with its Manager) and Workers, and renames them; ids stay, so Desks and history still point right', async t => {
  const { store } = await home(t);
  let staff = await store.addGroup({ name: '데이터 분석', focus: '숫자와 표', id: 'Data' });
  assert.deepEqual(staff.groups.at(-1), { id: 'data', name: '데이터 분석', focus: '숫자와 표' });
  assert.deepEqual(managerOf(staff, 'data') && [managerOf(staff, 'data').id, managerOf(staff, 'data').name], ['data-manager', '데이터 분석 팀장']);
  staff = await store.addGroup({ name: '마케팅' });
  assert.equal(staff.groups.at(-1).id, 'team', 'a name without Latin letters gets a made-up id');
  assert.equal((await store.addGroup({ name: '홍보' })).groups.at(-1).id, 'team-2');
  await assert.rejects(store.addGroup({ name: '마케팅' }), /이미 있습니다/);
  await assert.rejects(store.addGroup({ name: '  ' }), /이름이 필요/);
  staff = await store.hire({ group: 'data', name: '분석가 김', role: 'Data Analyst' });
  staff = await store.hire({ group: 'data', name: '분석가 이', role: 'Data Analyst' });
  assert.deepEqual(workersOf(staff, 'data').map(e => [e.id, e.name, e.role]), [['data-analyst', '분석가 김', 'Data Analyst'], ['data-analyst-2', '분석가 이', 'Data Analyst']]);
  await assert.rejects(store.hire({ group: 'none', name: 'x', role: 'y' }), /그런 팀이 없습니다/);
  staff = await store.editEmployee('data-analyst', { name: '수석 분석가', role: 'Lead Analyst' });
  assert.deepEqual(staff.employees.find(e => e.id === 'data-analyst').name, '수석 분석가');
  staff = await store.editEmployee('data-manager', { role: 'Boss' });
  assert.equal(managerOf(staff, 'data').role, 'Manager', 'a Manager stays a Manager');
  await assert.rejects(store.editEmployee('data-analyst', { name: '' }), /비어 있습니다/);
  staff = await store.editGroup('data', { name: '데이터', focus: '분석' });
  assert.deepEqual(staff.groups.find(g => g.id === 'data'), { id: 'data', name: '데이터', focus: '분석' });
  await assert.rejects(store.editGroup('data', { name: '마케팅' }), /이미 있습니다/);
  // What was written reads back the same (the file is the source of truth).
  assert.deepEqual(parseStaff(JSON.parse(JSON.stringify(await store.staff()))), await store.staff());
  await store.setState({ employee: 'data-analyst', project: 'p1', task: 't1', status: 'working' });
  assert.deepEqual(Object.keys(await store.states()), ['data-analyst']);
});
