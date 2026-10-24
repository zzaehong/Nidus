import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../dist/adapters/anthropic.js';
import { HttpClient } from '../dist/http.js';
import { priceFor, pricesFor, probeEstimate, usageCost } from '../dist/pricing.js';
import { assessContext, effectiveLimits } from '../dist/context.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { dispatch } from '../dist/dashboard.js';
const model = (id = 'gpt-4.1-mini') => ({ id, provider: 'openai', capabilities: { chat: 'supported' }, details: {}, limits: { inputTokens: null, outputTokens: null, contextTokens: null } });
const request = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 256 };
function fixture(models = [model()]) {
  let calls = 0, keys = 0;
  const engine = new ConnectivityEngine({ get: async () => { keys++; return 'synthetic'; } },
    { load: async () => ({ models, provider: 'openai' }) }, { openai: { chat: async (_, r) => {
      calls++; return { text: 'OK', usage: { inputTokens: 5, outputTokens: 2, cacheWriteTokens: 0 }, sent: r };
    } } });
  return { engine, calls: () => calls, keys: () => keys };
}
test('Anthropic preserves version on Models and Messages; version errors differ from auth/permission', async () => {
  for (const [status, message, code] of [[400, 'invalid anthropic-version: synthetic-secret', 'api_version'],
    [400, 'other bad field', 'invalid_request'], [401, 'anthropic-version', 'authentication'], [403, 'anthropic-version', 'permission']]) {
    const adapter = new AnthropicAdapter('https://mock.invalid', new HttpClient(async (_, options) => {
      assert.equal(options.headers['anthropic-version'], '2026-10-21');
      return Response.json({ error: { type: 'invalid_request_error', message } }, { status });
    }));
    for (const call of [() => adapter.listModels('synthetic'), () => adapter.chat('synthetic', request)]) {
      await assert.rejects(call(), e => e.code === code && !JSON.stringify(e).includes('synthetic-secret'));
    }
  }
});
test('pricing snapshots match exact IDs, retain tiers/cache/sources, and unknown is never zero', () => {
  assert.equal(probeEstimate('openai', 'gpt-4.1-mini-new').usd, null);
  assert.equal(priceFor('gemini', 'gemini-2.5-flash-lite').rates[0].output, 0.4);
  assert.equal(priceFor('anthropic', 'claude-haiku-5-5').rates.length, 2);
  assert.deepEqual(priceFor('deepseek', 'deepseek-v4-flash').rates, priceFor('deepseek', 'deepseek-flash').rates);
  const all = ['openai', 'anthropic', 'gemini', 'deepseek'].flatMap(pricesFor);
  assert.equal(new Set(all.map(p => p.provider + ':' + p.model)).size, all.length);
  for (const p of all) {
    assert.ok(p.sourceUrl.startsWith('https://')); assert.ok(Date.parse(p.checkedAt));
    for (const r of p.rates) { assert.ok(r.conditions); assert.ok(r.input >= 0 && r.output >= 0 && r.cachedInput >= 0); }
  }
  assert.equal(usageCost('openai', request.model, null), null);
  assert.equal(usageCost('anthropic', 'claude-sonnet-5-5', { inputTokens: 5, outputTokens: 2, cacheWriteTokens: 1 }), null);
});
test('probe budget and unknown consent gate requests before reading credentials', async () => {
  const f = fixture([model(), model('gpt-unpriced')]);
  for (const budget of [0, probeEstimate('openai', request.model).usd / 2])
    assert.equal((await f.engine.probe('openai', request.model, true, { remainingUSD: budget })).status, 'skipped');
  assert.equal((await f.engine.probe('openai', 'gpt-unpriced', true, { remainingUSD: 1 })).status, 'skipped');
  assert.equal(f.calls(), 0); assert.equal(f.keys(), 0);
  for (const remainingUSD of [NaN, Infinity, -1, '1'])
    await assert.rejects(f.engine.probe('openai', request.model, true, { remainingUSD }), e => e.code === 'invalid_request');
  const result = await f.engine.probe('openai', 'gpt-unpriced', true, { remainingUSD: 0.25, allowUnknownPrice: true });
  assert.equal(result.status, 'passed'); assert.equal(result.estimatedMaxUSD, null); assert.equal(result.estimatedUsageUSD, null);
  assert.equal(result.reservedUSD, 0.25); assert.equal(f.calls(), 1);
});
test('usage is estimated separately and reservation is never released after a failure', async () => {
  const f = fixture();
  const result = await f.engine.probe('openai', request.model, true, { remainingUSD: 1 });
  assert.ok(result.estimatedUsageUSD > 0); assert.ok(result.reservedUSD >= result.estimatedUsageUSD);
  const broken = new ConnectivityEngine({ get: async () => { throw Error('secret'); } }, { load: async () => ({ models: [model()] }) });
  const failed = await broken.probe('openai', request.model, true, { remainingUSD: 1 });
  assert.equal(failed.status, 'failed'); assert.equal(failed.estimatedUsageUSD, null);
  assert.equal(failed.reservedUSD, probeEstimate('openai', request.model).usd);
});
test('context accounts for UTF-8/system/output, respects metadata and does not truncate 100+ messages', async () => {
  const m = model(); m.limits = { inputTokens: 3000, outputTokens: 512, contextTokens: 3100 };
  const long = { ...request, system: '한글😀', messages: Array.from({ length: 120 }, () => ({ role: 'user', content: '안녕' })) };
  const c = assessContext('openai', long, m);
  assert.equal(c.inputTokens, 64 + Buffer.byteLength('한글😀') + 120 * (16 + Buffer.byteLength('안녕')));
  assert.equal(c.status, 'near_limit');
  assert.equal(assessContext('openai', { ...long, maxOutputTokens: 513 }, m).status, 'exceeded');
  assert.equal(effectiveLimits('openai', 'gpt-4.1-mini-guess').contextTokens, null);
  assert.equal(assessContext('openai', { ...request, model: 'unknown' }).status, 'unknown_limit');
  const f = fixture([m]);
  const preflight = await dispatch({ method: 'chat.preflight', provider: 'openai', request: long }, f.engine);
  assert.equal(preflight.status, 'near_limit'); assert.equal(f.keys(), 0);
  const result = await f.engine.chat('openai', long); assert.equal(result.sent.messages.length, 120);
  await assert.rejects(f.engine.chat('openai', { ...long, system: 'x'.repeat(5000) }), e => e.code === 'context_limit');
  assert.equal(f.calls(), 1);
  await assert.rejects(f.engine.preflight('openai', null), e => e.code === 'invalid_request');
});
