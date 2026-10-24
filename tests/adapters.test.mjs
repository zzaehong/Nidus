import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIAdapter, AnthropicAdapter, GeminiAdapter, DeepSeekAdapter } from '../dist/adapters/index.js';

async function server(t, handler) {
  const requests = [];
  const instance = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = { url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : undefined };
    requests.push(request);
    try { await handler(request, res); } catch { res.writeHead(500); res.end(); }
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}
const json = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const request = { model: 'new-model-from-api', system: 'Be brief', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Again' }], maxOutputTokens: 100 };

test('OpenAI discovers arbitrary IDs, retrieves details, sends Responses and normalizes usage', async t => {
  const mock = await server(t, (r, res) => json(res, r.url === '/responses'
    ? { model: request.model, status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } }
    : r.url === '/models' ? { data: [{ id: request.model, owned_by: 'owner' }] } : { id: request.model, owned_by: 'owner' }));
  const adapter = new OpenAIAdapter(mock.url);
  const models = await adapter.listModels('fake-key');
  assert.equal(models[0].id, request.model); assert.equal(models[0].capabilities.chat, 'unknown');
  assert.equal((await adapter.getModel('fake-key', request.model)).details.owner, 'owner');
  const result = await adapter.chat('fake-key', request);
  assert.equal(result.text, 'Hello'); assert.equal(result.usage.cachedInputTokens, 4); assert.equal(result.usage.reasoningTokens, 2);
  assert.equal(mock.requests[0].headers.authorization, 'Bearer fake-key');
  assert.equal(mock.requests[2].body.store, false); assert.equal(mock.requests[2].body.instructions, request.system);
  assert.deepEqual(mock.requests[2].body.input, request.messages);
});

test('Anthropic paginates, maps capabilities and includes cache reads/writes in input usage', async t => {
  const mock = await server(t, (r, res) => json(res, r.url === '/messages'
    ? { model: request.model, content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5, output_tokens: 2 } }
    : r.url.includes('after_id=') ? { data: [{ id: 'second', display_name: 'Second' }], has_more: false }
    : r.url === '/models' ? { data: [{ id: 'first', display_name: 'First', max_input_tokens: 1000, capabilities: { image_input: { supported: true } } }], has_more: true, last_id: 'first' }
    : { id: request.model, max_tokens: 100 }));
  const adapter = new AnthropicAdapter(mock.url);
  const models = await adapter.listModels('fake-key');
  assert.deepEqual(models.map(m => m.id), ['first', 'second']); assert.equal(models[0].capabilities.vision, 'supported');
  assert.equal((await adapter.getModel('fake-key', request.model)).limits.outputTokens, 100);
  const result = await adapter.chat('fake-key', request);
  assert.equal(result.usage.inputTokens, 12); assert.equal(result.usage.totalTokens, 14);
  assert.equal(result.usage.providerUsage.input_tokens, 3);
  assert.equal(mock.requests[1].url, '/models?after_id=first');
  assert.equal(mock.requests[0].headers['anthropic-version'], '2026-10-21');
  assert.ok(mock.requests.every(r => r.headers['anthropic-version'] === '2026-10-21'));
  for (const removed of ['temperature', 'top_p', 'top_k']) assert.equal(mock.requests[3].body[removed], undefined);
  assert.equal(mock.requests[3].body.system, request.system); assert.equal(mock.requests[3].body.max_tokens, 100);
});

test('Gemini preserves full resource ID without baseModelId, loads pages and separates thoughts', async t => {
  const mock = await server(t, (r, res) => json(res, r.url.includes(':generateContent')
    ? { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'Hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 13, cachedContentTokenCount: 4 } }
    : r.url.includes('pageToken=') ? { models: [{ name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] }] }
    : r.url === '/models' ? { models: [{ name: 'models/gemini-new-version', displayName: 'New', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000 }], nextPageToken: 'p2' }
    : { name: 'models/gemini-new-version', baseModelId: 'wrong-base', supportedGenerationMethods: ['generateContent'] }));
  const adapter = new GeminiAdapter(mock.url);
  const models = await adapter.listModels('fake-key');
  assert.equal(models[0].id, 'gemini-new-version'); assert.equal(models[1].capabilities.chat, 'unsupported');
  assert.equal((await adapter.getModel('fake-key', 'gemini-new-version')).id, 'gemini-new-version');
  const result = await adapter.chat('fake-key', { ...request, model: models[0].id });
  assert.equal(result.text, 'Hello'); assert.equal(result.usage.outputTokens, 5); assert.equal(result.usage.totalTokens, 13);
  assert.equal(mock.requests[0].headers['x-goog-api-key'], 'fake-key'); assert.equal(mock.requests[1].url, '/models?pageToken=p2');
  assert.equal(mock.requests[3].url, '/models/gemini-new-version:generateContent');
  assert.equal(mock.requests[3].body.contents[1].role, 'model');
  assert.deepEqual(mock.requests[3].body.systemInstruction, { parts: [{ text: request.system }] });
});

test('DeepSeek metadata, list-based detail, native chat format and usage', async t => {
  const mock = await server(t, (r, res) => json(res, r.url === '/models'
    ? { data: [{ id: request.model, name: 'New', input_modalities: ['text'], output_modalities: ['text'], context_window: 1000, max_output_tokens: 100 }] }
    : { choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_cache_hit_tokens: 2 } }));
  const adapter = new DeepSeekAdapter(mock.url);
  assert.equal((await adapter.listModels('fake-key'))[0].capabilities.chat, 'supported');
  assert.equal((await adapter.getModel('fake-key', request.model)).limits.contextTokens, 1000);
  const result = await adapter.chat('fake-key', request);
  assert.equal(result.usage.cachedInputTokens, 2); assert.equal(result.text, 'Hello');
  assert.equal(mock.requests[2].body.messages[0].role, 'system');
  assert.equal(mock.requests[2].url, '/chat/completions');
});

for (const Adapter of [OpenAIAdapter, AnthropicAdapter, GeminiAdapter, DeepSeekAdapter]) {
  for (const [status, code] of [[401, 'authentication'], [403, 'permission'], [402, 'quota'], [429, 'rate_limit'], [500, 'provider_error']]) {
    test(`${Adapter.name} maps HTTP ${status} without leaking echoed secrets`, async t => {
      const mock = await server(t, (r, res) => { res.writeHead(status, { 'retry-after': '5' }); res.end(JSON.stringify({ error: { message: 'secret-key prompt leaked' } })); });
      await assert.rejects(new Adapter(mock.url).listModels('secret-key'), e => e.code === code && e.status === status && !JSON.stringify(e).includes('secret-key'));
    });
  }
}
test('Quota differs from transient rate limiting', async t => {
  const mock = await server(t, (r, res) => { res.statusCode = 429; json(res, { error: { code: 'insufficient_quota' } }); });
  await assert.rejects(new OpenAIAdapter(mock.url).listModels('key'), e => e.code === 'quota');
});
test('Gemini API_KEY_INVALID is an authentication error even with HTTP 400', async t => {
  const mock = await server(t, (r, res) => { res.statusCode = 400; json(res, { error: { details: [{ reason: 'API_KEY_INVALID' }], message: 'bad secret' } }); });
  await assert.rejects(new GeminiAdapter(mock.url).listModels('secret'), e => e.code === 'authentication' && !e.message.includes('secret'));
});
test('Malformed success responses fail rather than look like empty model catalogs', async t => {
  const mock = await server(t, (r, res) => res.end('not-json'));
  await assert.rejects(new GeminiAdapter(mock.url).listModels('key'), e => e.code === 'invalid_response');
});
test('Repeated pagination cursor fails without returning a partial catalog', async t => {
  const mock = await server(t, (r, res) => json(res, { models: [], nextPageToken: 'same' }));
  await assert.rejects(new GeminiAdapter(mock.url).listModels('key'), e => e.code === 'invalid_response');
  assert.equal(mock.requests.length, 2);
});
test('Timeout covers the response body, and cancellation is distinct', async t => {
  const mock = await server(t, (r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  const adapter = new OpenAIAdapter(mock.url);
  await assert.rejects(adapter.listModels('key', { timeoutMs: 30 }), e => e.code === 'timeout');
  const controller = new AbortController();
  const pending = adapter.listModels('key', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, e => e.code === 'cancelled');
});
test('Redirects never forward API credentials', async t => {
  const target = await server(t, (r, res) => json(res, { data: [] }));
  const mock = await server(t, (r, res) => { res.writeHead(302, { location: target.url }); res.end(); });
  await assert.rejects(new OpenAIAdapter(mock.url).listModels('key'), e => e.code === 'network');
  assert.equal(target.requests.length, 0);
});
test('Local request validation fails before any HTTP call', async t => {
  const mock = await server(t, (r, res) => json(res, {}));
  const adapter = new OpenAIAdapter(mock.url);
  await assert.rejects(adapter.listModels(''), e => e.code === 'missing_key');
  await assert.rejects(adapter.chat('key', { model: 'x', messages: [] }), e => e.code === 'invalid_request');
  assert.equal(mock.requests.length, 0);
});
