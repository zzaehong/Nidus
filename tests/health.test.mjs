import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from '../dist/classification.js';
import { probeModel } from '../dist/health.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { dispatch } from '../dist/dashboard.js';
import { NidusError } from '../dist/errors.js';

const model = (id, provider = 'gemini', details = {}, chat = 'unknown') => ({
  id, provider, name: id, details, capabilities: { chat, vision: 'unknown', streaming: 'unknown', tools: 'unknown' },
  limits: { inputTokens: null, outputTokens: null, contextTokens: null }, capabilitySource: 'fixture'
});
test('classifies metadata without confusing image input with image output', () => {
  const multimodal = model('arbitrary', 'deepseek', { inputModalities: ['text', 'image'], outputModalities: ['text'] }, 'supported');
  assert.equal(classifyModel(multimodal).kind, 'text');
  assert.equal(classifyModel(multimodal).confidence, 'metadata');
  for (const kind of ['image', 'video', 'audio']) assert.equal(classifyModel(model('arbitrary', 'deepseek', { outputModalities: [kind] })).kind, kind);
  assert.equal(classifyModel(model('arbitrary', 'gemini', { supportedGenerationMethods: ['bidiGenerateContent'] })).kind, 'live');
  for (const method of ['embedContent', 'batchEmbedContents']) assert.equal(classifyModel(model('arbitrary', 'gemini', { supportedGenerationMethods: [method] })).kind, 'embedding');
});
test('specialized family hints exclude text probes and remain explicitly inferred', () => {
  for (const [id, kind] of [['gemini-test-image-preview', 'image'], ['imagen-3', 'image'], ['veo-3', 'video'], ['sora-2', 'video'], ['gpt-realtime', 'live'], ['gemini-native-audio', 'live'], ['gemini-test-tts', 'audio'], ['lyria-3', 'audio'], ['text-embedding-3', 'embedding'], ['omni-moderation-latest', 'moderation']]) {
    const c = classifyModel(model(id, 'gemini', { supportedGenerationMethods: ['generateContent'] }));
    assert.equal(c.kind, kind, id); assert.equal(c.confidence, 'inferred'); assert.equal(c.textProbe, 'unsupported');
  }
});
test('generateContent alone and generic prediction do not prove text output or video generation', () => {
  for (const methods of [['generateContent'], ['predict'], ['predictLongRunning']]) {
    const c = classifyModel(model('new-unrecognized-model', 'gemini', { supportedGenerationMethods: methods }));
    assert.equal(c.kind, 'unknown'); assert.equal(c.textProbe, 'unsupported');
  }
  const inferred = classifyModel(model('gemini-new-family', 'gemini', { supportedGenerationMethods: ['generateContent'] }));
  assert.equal(inferred.kind, 'text'); assert.equal(inferred.textProbe, 'opt_in');
  assert.equal(classifyModel(model('gpt-example', 'openai')).textProbe, 'opt_in');
  assert.equal(classifyModel(model('retired', 'anthropic', {}, 'unsupported')).textProbe, 'unsupported');
});
test('probe never calls unsupported models, unknown models, or unapproved inferred text', async () => {
  for (const m of [model('veo-3'), model('unknown'), model('gpt-example', 'openai')]) {
    const result = await probeModel(m, false, async () => { throw new Error('must not call'); });
    assert.equal(result.status, 'skipped'); assert.equal(result.usage, null);
  }
  assert.equal((await probeModel(model('veo-3'), true, async () => assert.fail('must not call'))).status, 'skipped');
});
const usage = { inputTokens: 3, outputTokens: 1, totalTokens: 4, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerUsage: { input_tokens: 3 } };
test('probe uses bounded fixed text request, preserves usage without returning model content', async () => {
  const result = await probeModel(model('gpt-example', 'openai'), true, async (request, options) => {
    assert.equal(request.maxOutputTokens, 256); assert.equal(request.messages[0].content, 'Reply with OK.'); assert.equal(options.timeoutMs, 30000);
    return { text: 'synthetic-model-content', usage };
  });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.usage, usage);
  assert.ok(!JSON.stringify(result).includes('synthetic-model-content')); assert.ok(result.durationMs >= 0);
});
test('probe failure distinguishes provider-wide blockers and preserves safe errors', async () => {
  for (const code of ['authentication', 'permission', 'quota', 'rate_limit', 'missing_key', 'timeout', 'network', 'not_found', 'provider_error']) {
    const result = await probeModel(model('text', 'anthropic', {}, 'supported'), false, async () => { throw new NidusError(code, 'Safe failure', 429, '5'); });
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, code); assert.equal(result.error.retryAfter, '5');
    assert.equal(result.stopProvider, ['authentication', 'permission', 'quota', 'rate_limit', 'missing_key'].includes(code));
  }
  const unexpected = await probeModel(model('text', 'anthropic', {}, 'supported'), false, async () => { throw new Error('synthetic-secret'); });
  assert.ok(!JSON.stringify(unexpected).includes('synthetic-secret'));
  const empty = await probeModel(model('text', 'anthropic', {}, 'supported'), false, async () => ({ text: ' ', usage }));
  assert.equal(empty.status, 'failed'); assert.deepEqual(empty.usage, usage);
});
test('engine reclassifies legacy cache; probe requires discovered ID, confirmation, and optional inferred consent', async () => {
  let readKeys = 0, requests = 0;
  const models = [model('gpt-example', 'openai'), model('gpt-image-example', 'openai')];
  const engine = new ConnectivityEngine({ get: async () => { readKeys++; return 'synthetic'; } },
    { load: async () => ({ version: 1, provider: 'openai', fetchedAt: '2026-10-24', models }) },
    { openai: { chat: async () => { requests++; return { text: 'OK', usage }; } } });
  assert.equal((await engine.cachedModels('openai')).models[0].classification.kind, 'text'); assert.equal(readKeys, 0);
  await assert.rejects(dispatch({ method: 'probe', provider: 'openai', model: 'gpt-example' }, engine));
  await assert.rejects(dispatch({ method: 'probe', provider: 'openai', model: 'gpt-example', confirmed: true, allowInferred: 'yes' }, engine));
  await assert.rejects(engine.probe('openai', 'invented', true));
  assert.equal((await engine.probe('openai', 'gpt-example')).status, 'skipped');
  assert.equal((await engine.probe('openai', 'gpt-image-example', true)).status, 'skipped'); assert.equal(readKeys, 0);
  assert.equal((await dispatch({ method: 'probe', provider: 'openai', model: 'gpt-example', confirmed: true, allowInferred: true }, engine)).status, 'passed');
  assert.equal(requests, 1); assert.equal(readKeys, 1);
});
