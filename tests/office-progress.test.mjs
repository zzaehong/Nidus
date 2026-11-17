import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog, describeModels, describeProgress, elapsed } from '../dist/office/progress.js';

const now = new Date('2026-11-16T15:20:00Z');

test('Main sees every Task with its time, tries and the last review', () => {
  const task = (id, extra) => ({ id, team: 'r', title: `${id} 제목`, contract: {}, dependsOn: [], attempts: 0, reviews: [], status: 'pending', ...extra });
  const project = { id: 'p1', instruction: 'i', createdAt: '2026-11-16T14:04:30Z', status: 'running', summary: '', roadmap: [], teams: [], questions: [], conversation: [], tasks: [
    task('t1', { status: 'done', where: 'vm', difficulty: 'normal', attempts: 1, startedAt: '2026-11-16T14:04:38Z', finishedAt: '2026-11-16T14:34:38Z', reviews: [{ verdict: 'accept', feedback: '좋음', at: '' }] }),
    task('t2', { status: 'in_progress', where: 'vm', attempts: 2, startedAt: '2026-11-16T14:20:00Z', reviews: [{ verdict: 'revise', feedback: '429로 조사가 끝나지 않음', at: '' }] }),
    task('t3', { dependsOn: ['t2'] }),
  ] };
  const text = describeProgress(project, now);
  assert.match(text, /^Project p1: running, started 1시간 15분 ago/);
  assert.match(text, /- t1 \[done\] t1 제목 — vm, normal, attempt 1, took 30분\n    last review \(accept\): 좋음/);
  assert.match(text, /- t2 \[in_progress\] t2 제목 — vm, attempt 2, running for 1시간 0분\n    last review \(revise\): 429로 조사가 끝나지 않음/);
  assert.match(text, /- t3 \[pending\] t3 제목 — vm \(waits for t2\)/);
});

test('Main sees which models rest, why and for how long, and a slot where every candidate rests', () => {
  const ref = (provider, model) => ({ provider, model });
  const table = { roles: { main: [ref('gemini-free', 'lite')] }, worker: { simple: [], normal: [ref('cloudflare', 'mini'), ref('nvidia', 'flash')], complex: [ref('cloudflare', 'mini')] } };
  const health = new Map([
    ['cloudflare:mini', { streak: 46, lastError: 'rate_limit', restUntil: new Date('2026-11-16T17:14:46Z'), medianMs: null }],
    ['nvidia:flash', { streak: 1, lastError: 'timeout', restUntil: new Date('2026-11-16T15:19:00Z'), medianMs: 104_000 }],
    ['gemini-free:lite', { streak: 0, lastError: null, restUntil: null, medianMs: 1_500 }],
  ]);
  const text = describeModels(table, health, now);
  assert.match(text, /- main: gemini-free:lite \(ok, usually 2초\)/);
  assert.match(text, /- worker simple: no candidates/);
  assert.match(text, /- worker normal: cloudflare:mini \(resting 1시간 54분 more after 46 rate_limit failure\(s\)\) > nvidia:flash \(1 recent timeout failure\(s\), usually 1분 44초\)$/m);
  assert.match(text, /- worker complex: cloudflare:mini .* — every candidate is resting/);
  const capped = describeModels(table, health, now, ['gemini-free:lite']);
  assert.match(capped, /- main: gemini-free:lite \(at its quota limit \(per minute or per day\), passed over until it resets, usually 2초\) — every candidate is resting/);
});

test('the activity log keeps the latest entries with their time', () => {
  let at = Date.parse('2026-11-16T15:00:00Z');
  const log = new ActivityLog(3, () => new Date(at += 1000));
  for (const n of [1, 2, 3, 4]) log.add(`일 ${n}\n줄바꿈`);
  assert.equal(log.render(), '11-16 15:00:02 일 2 줄바꿈\n11-16 15:00:03 일 3 줄바꿈\n11-16 15:00:04 일 4 줄바꿈');
  assert.equal(log.render(1), '11-16 15:00:04 일 4 줄바꿈');
  assert.deepEqual([elapsed(40_000), elapsed(180_000), elapsed(4_320_000)], ['40초', '3분', '1시간 12분']);
  assert.equal(elapsed(104_000), '1분 44초');
});

test('the activity log survives a restart: kept as JSON lines, trimmed when reopened, a damaged line is skipped', async t => {
  const { mkdtemp, rm, readFile, appendFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'nidus-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'main-desk', 'activity.jsonl');
  let at = Date.parse('2026-11-16T15:00:00Z');
  const clockNow = () => new Date(at += 1000);
  const first = await ActivityLog.open(file, 3, clockNow);
  for (const n of [1, 2, 3, 4]) first.add(`일 ${n}`);
  await first.flushed();
  await appendFile(file, 'not json\n');
  const again = await ActivityLog.open(file, 3, clockNow);
  assert.equal(again.render(), '11-16 15:00:02 일 2\n11-16 15:00:03 일 3\n11-16 15:00:04 일 4');
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3, 'the file is trimmed to what is kept');
});

test('Main Desk: the open project, activity, models, earlier projects and the month, from the records', async () => {
  const { renderMainDesk, describeHistory, describeUsage } = await import('../dist/office/progress.js');
  const task = (id, status, extra = {}) => ({ id, team: 'r', title: id, contract: {}, dependsOn: [], attempts: 1, reviews: [], status, ...extra });
  const old = { id: 'p-old', instruction: '맥미니 가격 비교', createdAt: '2026-11-16T14:04:30Z', status: 'done', summary: '', roadmap: [], teams: [], questions: [], conversation: [],
    tasks: [task('t1', 'done', { finishedAt: '2026-11-16T17:33:23Z' }), task('t2', 'blocked', { finishedAt: '2026-11-16T18:38:37Z' }), task('t3', 'skipped')] };
  assert.equal(describeHistory([old]), '- p-old [done, took 4시간 34분] 맥미니 가격 비교 — tasks 1/3 done (t2 blocked, t3 skipped)');
  const usage = { month: '2026-11', calls: 120, costUSD: '0.00', unknownCostCalls: 0, groups: [
    { provider: 'cloudflare', model: 'mini', calls: 106, failed: 105 }, { provider: 'nvidia', model: 'flash', calls: 14, failed: 10 }] };
  assert.equal(describeUsage(usage), '2026-11: 120 calls, 115 failed, $0.00\nMost failures: cloudflare:mini 105/106 failed; nvidia:flash 10/14 failed');
  const log = new ActivityLog(10, () => new Date('2026-11-17T01:00:00Z'));
  log.add('t1 Worker 모델 답 nvidia:flash (1분 40초 걸림)');
  const open = { ...old, id: 'p-new', status: 'running', instruction: '새 일', tasks: [task('t1', 'in_progress', { startedAt: '2026-11-17T00:50:00Z' })] };
  const page = renderMainDesk({ now: new Date('2026-11-17T01:00:00Z'), state: 'Running: yes. VM: running, used by t1.', project: open, activity: log, models: '- main: a (ok)', history: [open, old], usage: describeUsage(usage) });
  assert.match(page, /^# Main Desk — 2026-11-17 01:00:00 UTC\n\n## Now\nRunning: yes\. VM: running, used by t1\.\n\n## Open project\n새 일\n/);
  assert.match(page, /- t1 \[in_progress\] t1 — vm, attempt 1, running for 10분/);
  assert.match(page, /## Recent activity \(UTC, newest last\)\n11-17 01:00:00 t1 Worker 모델 답 nvidia:flash \(1분 40초 걸림\)/);
  assert.match(page, /## Earlier projects \(newest first\)\n- p-old \[done, took 4시간 34분\]/);
  assert.ok(!page.includes('- p-new ['), 'the open project is not repeated among earlier ones');
  assert.match(page, /## This month\n2026-11: 120 calls, 115 failed/);
  const idle = renderMainDesk({ now: new Date(), state: 'Running: no.', project: old, activity: new ActivityLog(), models: '', history: [old], usage: '' });
  assert.match(idle, /## Open project\nNone\./);
});
