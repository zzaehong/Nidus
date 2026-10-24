import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectivityEngine } from '../dist/engine.js';
import { UsageLedger } from '../dist/ledger.js';
import { NidusError } from '../dist/errors.js';
import { modelProfile, rankCandidates } from '../dist/router.js';
import { dispatch } from '../dist/dashboard.js';
import { main } from '../dist/cli.js';
import { fundedLedger } from './helpers/ledger.mjs';
const request = { model: 'automatic', messages: [{ role: 'user', content: 'private-prompt' }], maxOutputTokens: 128 };
const pairs = [['openai', 'gpt-4.1-mini'], ['gemini', 'gemini-3.5-flash-lite'], ['gemini', 'gemini-2.5-flash'], ['deepseek', 'deepseek-flash'], ['deepseek', 'deepseek-v4-pro'], ['anthropic', 'claude-sonnet-4-6'], ['anthropic', 'claude-opus-4-6']];
const model = (provider, id) => ({ provider, id, name: id, capabilities: { chat: 'supported', tools: 'unknown', vision: 'unknown', streaming: 'unknown' }, limits: { inputTokens: null, outputTokens: null, contextTokens: null }, details: {}, capabilitySource: 'mock' });
function fixture({ ledger = fundedLedger(), models = pairs, fail = () => {} } = {}) {
  const calls = []; let discovery = 0;
  const registry = Object.fromEntries(['openai', 'gemini', 'deepseek', 'anthropic'].map(provider => [provider, {
    listModels: async () => { discovery++; throw Error('selection must not discover'); },
    chat: async (key, r) => { calls.push([provider, r.model]); await fail(provider, r.model); return { provider, model: r.model, text: 'OK', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 12, providerUsage: {} } }; }
  }]));
  const engine = new ConnectivityEngine({ get: async () => 'private-key' }, { load: async provider => ({ version: 1, provider, models: models.filter(([p]) => p === provider).map(([p, id]) => model(p, id)), fetchedAt: '2026-10-24' }) }, registry, ledger);
  return { engine, ledger, calls, discovery: () => discovery };
}
test('task policies select lightweight/general/advanced, default Normal, local preview has no inference or reservation', async () => {
  const f = fixture();
  for (const [difficulty, grade] of [['simple', 'lightweight'], ['normal', 'general'], ['complex', 'advanced']]) {
    const plan = await f.engine.routePlan(request, difficulty);
    assert.equal(plan.candidates[0].profile.grade, grade);
  }
  assert.equal((await f.engine.routePlan(request)).difficulty, 'normal');
  assert.equal(f.calls.length, 0); assert.equal(f.discovery(), 0); assert.equal(f.ledger.snapshot().requests.length, 0);
  assert.equal((await f.engine.autoChat(request, 'complex')).model, 'deepseek-v4-pro');
  assert.equal(f.ledger.snapshot().requests.length, 1);
});
test('unknown grades/prices excluded; Complex never downgrades; invalid difficulty rejected', async () => {
  const f = fixture({ models: [['openai', 'gpt-4.1-mini'], ['openai', 'new-unknown']] });
  assert.equal(modelProfile('openai', 'new-unknown').grade, 'unknown');
  assert.equal(modelProfile('openai', 'new-unknown').releasedAt, null);
  assert.equal((await f.engine.routePlan(request, 'simple')).candidates.length, 1);
  await assert.rejects(f.engine.autoChat(request, 'complex'), e => e.code === 'budget');
  await assert.rejects(f.engine.autoChat(request, 'invalid'), e => e.code === 'invalid_request');
  assert.equal(f.calls.length, 0);
});
test('verified zero bound wins, free-tier flag alone never makes Gemini free, recency only breaks same-grade/cost ties', async () => {
  const f = fixture(), plan = await f.engine.routePlan(request, 'simple');
  const base = plan.candidates[0];
  const old = { ...base, profile: { ...base.profile, releasedAt: '2024-01-01' } };
  const recent = { ...base, model: { ...base.model, id: 'reviewed-recent' }, profile: { ...base.profile, releasedAt: '2025-01-01' } };
  assert.equal(rankCandidates([old, recent], 'simple')[0].model.id, 'reviewed-recent');
  const unknownDate = { ...recent, profile: { ...recent.profile, releasedAt: null } };
  assert.equal(rankCandidates([unknownDate, old], 'simple')[0].profile.releasedAt, '2024-01-01');
  const free = { ...recent, quote: { allowed: true, reason: null, boundUSD: '0.000000000' } };
  assert.equal(rankCandidates([old, free], 'simple')[0].model.id, 'reviewed-recent');
  assert.ok(Number(plan.candidates.find(c => c.model.provider === 'gemini').quote.boundUSD) > 0);
});
test('provider, global and single budgets exclude before dispatch; no budget exceptions in automatic mode', async () => {
  const f = fixture(); f.ledger.setBudget('openai', '0');
  assert.equal((await f.engine.autoChat(request, 'simple')).provider, 'gemini');
  f.ledger.setBudget('total', '0');
  await assert.rejects(f.engine.autoChat(request, 'simple'), e => e.code === 'budget');
  await assert.rejects(f.engine.autoChat(request, 'simple', { budgetException: true }), e => e.code === 'invalid_request');
  assert.equal(f.calls.length, 1);
  const unconfigured = fixture({ ledger: new UsageLedger(':memory:') });
  await assert.rejects(unconfigured.engine.autoChat(request), e => e.code === 'budget');
  assert.equal(unconfigured.calls.length, 0);
});
test('80/90 percent pressure prefers cheaper compatible candidates and 100 blocks', async () => {
  for (const used of ['8', '9', '10']) {
    const f = fixture(); f.ledger.setBudget('total', '10');
    const reservation = f.ledger.reserve('openai', { ...request, model: 'gpt-4.1-mini' }, 'chat');
    f.ledger.settle(reservation, 'failed'); f.ledger.reconcile(reservation.id, used, { provider: 'openai', reference: 'mock-billing' });
    const plan = await f.engine.routePlan(request, 'simple');
    assert.equal(plan.budget.level, used === '8' ? 'warning' : used === '9' ? 'saving' : 'blocked');
    if (used !== '10') assert.ok(plan.candidates.every(c => c.pressure)); else assert.equal(plan.candidates.length, 0);
  }
});
test('rate limit switches once, persists cooldown and records transitions without secrets; unresolved liability retained', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nidus-router-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'usage.sqlite'); const ledger = new UsageLedger(path); ledger.setBudget('total', '100'); ledger.setBudget('request', '10');
  const f = fixture({ ledger, fail: p => { if (p === 'openai') throw new NidusError('rate_limit', 'private-prompt private-key', 429, '120'); } });
  const result = await f.engine.autoChat(request, 'simple');
  assert.equal(result.provider, 'gemini'); assert.equal(f.calls.length, 2);
  assert.ok(result.routing.transitions.some(t => t.reason === 'rate_limit'));
  assert.ok(Number(ledger.snapshot().total.reservedUSD) > 0);
  const log = JSON.stringify(ledger.routes()); assert.ok(!log.includes('private-prompt')); assert.ok(!log.includes('private-key'));
  ledger.close(); const reopened = new UsageLedger(path); t.after(() => reopened.close());
  assert.equal(reopened.health('openai', 'gpt-4.1-mini').available, false); assert.equal(reopened.routes().length, 4);
  assert.ok(!(await fixture({ ledger: reopened }).engine.routePlan(request, 'simple')).candidates.some(c => c.model.provider === 'openai'));
});
test('authentication, permission, quota and missing key exclude provider; unavailable model falls back', async () => {
  for (const code of ['authentication', 'permission', 'quota', 'missing_key', 'not_found']) {
    const f = fixture({ models: [['openai', 'gpt-4.1-mini'], ['openai', 'gpt-4.1-mini-2025-04-14'], ['gemini', 'gemini-3.5-flash-lite']], fail: p => { if (p === 'openai') throw new NidusError(code, 'mock'); } });
    assert.equal((await f.engine.autoChat(request, 'simple')).provider, 'gemini');
    assert.equal(f.calls.filter(([p]) => p === 'openai').length, code === 'not_found' ? 2 : 1);
  }
});
test('timeout, network, invalid response, cancellation and unknown errors never trigger duplicate execution', async () => {
  for (const code of ['timeout', 'network', 'invalid_response', 'cancelled', 'provider_error']) {
    const f = fixture({ fail: () => { throw new NidusError(code, 'ambiguous'); } });
    await assert.rejects(f.engine.autoChat(request, 'simple'), e => e.code === code);
    assert.equal(f.calls.length, 1); assert.equal(f.ledger.snapshot().requests[0].costStatus, 'unknown');
    assert.ok(Number(f.ledger.snapshot().total.reservedUSD) > 0);
  }
});
test('parallel automatic requests cannot spend the same remaining budget', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ models: [['openai', 'gpt-4.1-mini']], fail: async () => { await gate; } });
  f.ledger.setBudget('total', '0.5');
  const first = f.engine.autoChat(request, 'simple');
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.engine.autoChat(request, 'simple'), e => e.code === 'budget');
  release(); await first; assert.equal(f.calls.length, 1);
});
test('CLI and SwiftUI transport share automatic policy and preserve manual requests', async () => {
  const cli = fixture(), ui = fixture(); let output = '';
  await main(['chat', '--auto', '--difficulty', 'complex'], { engine: cli.engine, readPrompt: async () => 'private-prompt', write: s => { output += s; } });
  const result = await dispatch({ method: 'auto-chat', difficulty: 'complex', request }, ui.engine);
  assert.equal(JSON.parse(output).model, result.model);
  assert.equal(JSON.parse(output).routing.difficulty, result.routing.difficulty);
  const preview = await dispatch({ method: 'route-plan', difficulty: 'simple', request }, ui.engine);
  assert.ok(preview.candidates.length); assert.equal(ui.calls.length, 1);
  const manual = await dispatch({ method: 'chat', provider: 'openai', request: { ...request, model: 'gpt-4.1-mini' } }, ui.engine);
  assert.equal(manual.model, 'gpt-4.1-mini'); assert.equal(manual.routing, undefined);
});
test('schema 1 migration preserves Phase 3 reservations and expiry permits later selection', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'nidus-migrate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'usage.sqlite'); const original = new UsageLedger(path);
  original.setBudget('total', '10'); original.setBudget('request', '5');
  original.reserve('openai', { ...request, model: 'gpt-4.1-mini' }, 'chat'); original.close();
  const old = new DatabaseSync(path); old.exec('DROP TABLE route_events; DROP TABLE model_health; PRAGMA user_version=1;'); old.close();
  let time = new Date('2026-10-24T12:00:00Z');
  const ledger = new UsageLedger(path, () => time); t.after(() => ledger.close());
  assert.equal(ledger.snapshot().requests.length, 1); assert.ok(Number(ledger.snapshot().total.reservedUSD) > 0);
  ledger.recordHealth('openai', 'gpt-4.1-mini', 'rate_limit', 60);
  assert.equal(ledger.health('openai', 'gpt-4.1-mini').available, false);
  time = new Date('2026-10-24T12:01:01Z'); assert.equal(ledger.health('openai', 'gpt-4.1-mini').available, true);
});
test('metadata incompatibility and cancelled request cannot dispatch; newer advanced never replaces Simple grade by date', async () => {
  const f = fixture(); const plan = await f.engine.routePlan(request, 'simple'); const light = plan.candidates[0];
  const media = { ...light, model: { ...light.model, details: { outputModalities: ['IMAGE'] } } };
  assert.equal(rankCandidates([media], 'simple').length, 0);
  const advanced = { ...light, model: { ...light.model, id: 'new-advanced' }, profile: { ...light.profile, grade: 'advanced', releasedAt: '2026-10-24' } };
  assert.equal(rankCandidates([advanced, light], 'simple')[0].profile.grade, 'lightweight');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.engine.autoChat(request, 'simple', { signal: controller.signal }), e => e.code === 'cancelled');
  assert.equal(f.calls.length, 0);
});
