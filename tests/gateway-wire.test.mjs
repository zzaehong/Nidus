import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from '../dist/http.js';
import { ProviderClient } from '../dist/gateway/providers.js';
import { validateRequest, textOf, toolCallsOf } from '../dist/gateway/contract.js';
import { schemaError } from '../dist/gateway/schema.js';

// Fake fetch: records each request and answers from a queue of JSON bodies.
function fakeProviders(...replies) {
  const requests = [];
  const http = new HttpClient(async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies.shift();
    // { httpStatus, body } answers with an error status; anything else is a 200 JSON body.
    const failure = typeof reply.httpStatus === 'number';
    return new Response(JSON.stringify(failure ? reply.body : reply), { status: failure ? reply.httpStatus : 200, headers: { 'content-type': 'application/json' } });
  });
  return { client: new ProviderClient({ http }), requests };
}

const weather = { name: 'get_weather', description: 'Weather for a city.', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } };
const ask = { role: 'user', content: [{ type: 'text', text: 'Weather in Seoul?' }] };
const base = { model: 'm1', system: 'Be brief.', messages: [ask], tools: [weather], maxOutputTokens: 500 };

// Second turn of a tool exchange, built from a first response.
const followUp = first => ({ ...base, messages: [ask, { role: 'assistant', content: first.content },
  { role: 'user', content: toolCallsOf(first.content).map(call => ({ type: 'tool_result', callId: call.id, content: 'Sunny, 21C', isError: false })) }] });

test('Anthropic: tool round trip, thinking passback, x-api-key and cache-inclusive input', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
  const { client, requests } = fakeProviders(
    { model: 'm1', stop_reason: 'tool_use', content: [thinking, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Seoul' } }],
      usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 0, output_tokens: 7 } },
    { model: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sunny.' }], usage: { input_tokens: 50, output_tokens: 3 } });

  const first = await client.send('anthropic', 'key-a', { ...base, toolChoice: 'required' });
  assert.equal(first.stopReason, 'tool_call');
  assert.deepEqual(first.content.map(block => block.type), ['provider_state', 'text', 'tool_call']);
  assert.deepEqual(toolCallsOf(first.content)[0], { type: 'tool_call', id: 'toolu_1', name: 'get_weather', input: { city: 'Seoul' } });
  assert.equal(first.usage.inputTokens, 40);
  assert.equal(first.usage.cachedInputTokens, 30);

  const sent = requests[0];
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'key-a');
  assert.equal(sent.headers['anthropic-version'], '2026-10-21');
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.body.system, 'Be brief.');
  assert.equal(sent.body.max_tokens, 500);
  assert.deepEqual(sent.body.tools, [{ name: 'get_weather', description: weather.description, input_schema: weather.inputSchema }]);
  // Forced tool use is rejected by current models, so "required" degrades to "auto".
  assert.deepEqual(sent.body.tool_choice, { type: 'auto' });
  assert.equal('temperature' in sent.body, false);

  const second = await client.send('anthropic', 'key-a', followUp(first));
  assert.equal(second.stopReason, 'end');
  assert.equal(textOf(second.content), 'Sunny.');
  assert.deepEqual(requests[1].body.messages[1].content, [thinking, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Seoul' } }]);
  assert.deepEqual(requests[1].body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 21C', is_error: false }]);
});

test('OpenAI Responses: function calls, encrypted reasoning replay and usage details', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] };
  const { client, requests } = fakeProviders(
    { model: 'm1', status: 'completed', output: [reasoning, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
      usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 4 } } },
    { model: 'm1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Sunny.' }] }], usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 } });

  const first = await client.send('openai', 'key-o', base);
  assert.equal(first.stopReason, 'tool_call');
  assert.deepEqual(toolCallsOf(first.content)[0].input, { city: 'Seoul' });
  assert.equal(first.usage.cachedInputTokens, 5);
  assert.equal(first.usage.reasoningTokens, 4);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].headers.authorization, 'Bearer key-o');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.instructions, 'Be brief.');
  assert.deepEqual(requests[0].body.tools[0], { type: 'function', name: 'get_weather', description: weather.description, parameters: weather.inputSchema, strict: false });

  const second = await client.send('openai', 'key-o', followUp(first));
  assert.equal(textOf(second.content), 'Sunny.');
  assert.deepEqual(requests[1].body.input, [
    { role: 'user', content: 'Weather in Seoul?' },
    reasoning,
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Seoul"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Sunny, 21C' }]);
});

test('OpenAI Responses: truncated and refused outputs map to stop reasons', async () => {
  const { client } = fakeProviders(
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: {} },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }], usage: {} });
  assert.equal((await client.send('openai', 'k', { model: 'm1', messages: [ask] })).stopReason, 'max_tokens');
  assert.equal((await client.send('openai', 'k', { model: 'm1', messages: [ask] })).stopReason, 'refusal');
});

test('Gemini: function calls get ids, thought signatures return on the same part, results are matched by name', async () => {
  const { client, requests } = fakeProviders(
    { modelVersion: 'm1', candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }, { functionCall: { name: 'get_weather', args: { city: 'Seoul' } }, thoughtSignature: 'sig-g' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 22 } },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Sunny.' }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2 } });

  const first = await client.send('gemini', 'key-g', { ...base, toolChoice: 'required' });
  assert.equal(first.stopReason, 'tool_call');
  assert.equal(textOf(first.content), '');
  const call = toolCallsOf(first.content)[0];
  assert.match(call.id, /^call_[0-9a-f]{32}$/);
  assert.equal(first.usage.outputTokens, 10);
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent');
  assert.equal(requests[0].headers['x-goog-api-key'], 'key-g');
  assert.deepEqual(requests[0].body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.deepEqual(requests[0].body.tools[0].functionDeclarations[0].parametersJsonSchema, weather.inputSchema);

  await client.send('gemini', 'key-g', followUp(first));
  assert.deepEqual(requests[1].body.contents, [
    { role: 'user', parts: [{ text: 'Weather in Seoul?' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Seoul' } }, thoughtSignature: 'sig-g' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: 'Sunny, 21C' } } }] }]);
});

test('Chat Completions: tool messages, reasoning passback and provider quirks', async () => {
  const reply = { model: 'm1', choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Seoul"}' } }] } }],
    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_cache_hit_tokens: 3 } };
  const done = { choices: [{ finish_reason: 'stop', message: { content: 'Sunny.' } }], usage: { prompt_tokens: 25, completion_tokens: 2 } };

  const deepseek = fakeProviders(reply, done);
  const first = await deepseek.client.send('deepseek', 'key-d', base);
  assert.equal(first.stopReason, 'tool_call');
  assert.equal(first.usage.cachedInputTokens, 3);
  assert.equal(deepseek.requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(deepseek.requests[0].body.max_tokens, 500);
  assert.deepEqual(deepseek.requests[0].body.messages[0], { role: 'system', content: 'Be brief.' });
  await deepseek.client.send('deepseek', 'key-d', followUp(first));
  assert.deepEqual(deepseek.requests[1].body.messages.slice(2), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Seoul"}' } }], reasoning_content: 'thinking' },
    { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny, 21C' }]);

  // Groq names the output limit differently; Mistral needs nine-character ids and "any".
  const groq = fakeProviders(done);
  await groq.client.send('groq', 'k', base);
  assert.equal(groq.requests[0].body.max_completion_tokens, 500);
  assert.equal('max_tokens' in groq.requests[0].body, false);

  const mistral = fakeProviders(done);
  await mistral.client.send('mistral', 'k', { ...followUp(first), toolChoice: 'required' });
  const [assistant, tool] = mistral.requests[0].body.messages.slice(2);
  assert.match(assistant.tool_calls[0].id, /^[a-z0-9]{9}$/);
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
  assert.equal(assistant.reasoning_content, undefined, 'DeepSeek reasoning is not sent to another provider');
  assert.equal(mistral.requests[0].body.tool_choice, 'any');
});

test('Cloudflare uses the account endpoint and unpacked token', async () => {
  const { client, requests } = fakeProviders({ choices: [{ finish_reason: 'stop', message: { content: 'Hi' } }], usage: {} });
  const key = JSON.stringify({ token: 'cf-token', accountId: 'a'.repeat(32) });
  await client.send('cloudflare', key, { model: '@cf/meta/llama', messages: [ask] });
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1/chat/completions`);
  assert.equal(requests[0].headers.authorization, 'Bearer cf-token');
  await assert.rejects(client.send('cloudflare', 'not-json', { model: 'm', messages: [ask] }), { code: 'invalid_request' });
});

test('a conversation continues on another provider: foreign state is dropped, calls and results carry over', async () => {
  const anthropic = fakeProviders({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Seoul' } }], usage: {} });
  const first = await anthropic.client.send('anthropic', 'k', base);

  const openai = fakeProviders({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Sunny.' }] }], usage: {} });
  const second = await openai.client.send('openai', 'k', followUp(first));
  assert.equal(textOf(second.content), 'Sunny.');
  assert.deepEqual(openai.requests[0].body.input, [
    { role: 'user', content: 'Weather in Seoul?' },
    { type: 'function_call', call_id: 'toolu_9', name: 'get_weather', arguments: '{"city":"Seoul"}' },
    { type: 'function_call_output', call_id: 'toolu_9', output: 'Sunny, 21C' }]);

  const gemini = fakeProviders({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Sunny.' }] } }] });
  await gemini.client.send('gemini', 'k', followUp(first));
  assert.deepEqual(gemini.requests[0].body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Seoul' } } }] });
});

test('invalid tool calls are returned with inputError instead of failing the response', async () => {
  const { client } = fakeProviders({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
    { id: 'c1', function: { name: 'get_weather', arguments: '{"city":5}' } },
    { id: 'c2', function: { name: 'get_weather', arguments: '{broken' } },
    { id: 'c3', function: { name: 'delete_everything', arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const calls = toolCallsOf((await client.send('groq', 'k', base)).content);
  assert.equal(calls[0].inputError, 'input.city: expected string');
  assert.equal(calls[1].inputError, 'input: arguments are not valid JSON');
  assert.equal(calls[2].inputError, 'unknown tool "delete_everything"');
});

test('provider failures keep the existing safe error mapping', async () => {
  const { client } = fakeProviders({ httpStatus: 429, body: { error: { message: 'secret detail' } } });
  await assert.rejects(client.send('anthropic', 'k', { model: 'm1', messages: [ask] }), error => error.code === 'rate_limit' && !error.message.includes('secret'));
});

test('validateRequest rejects malformed conversations', () => {
  const call = { type: 'tool_call', id: 'c1', name: 'get_weather', input: {} };
  const result = { type: 'tool_result', callId: 'c1', content: 'ok', isError: false };
  const bad = [
    { model: '', messages: [ask] },
    { model: 'm', messages: [] },
    { model: 'm', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] },
    { model: 'm', messages: [ask, { role: 'assistant', content: [call] }] },
    { model: 'm', messages: [ask, { role: 'assistant', content: [call] }, ask] },
    { model: 'm', messages: [{ role: 'user', content: [result] }] },
    { model: 'm', messages: [ask, { role: 'assistant', content: [call] }, { role: 'user', content: [result, result] }] },
    { model: 'm', messages: [ask], toolChoice: 'required' },
    { model: 'm', messages: [ask], tools: [weather, weather] },
    { model: 'm', messages: [ask], tools: [{ ...weather, name: 'bad name' }] },
    { model: 'm', messages: [ask], maxOutputTokens: 0 },
  ];
  for (const request of bad) assert.throws(() => validateRequest(request), { code: 'invalid_request' }, JSON.stringify(request));
  validateRequest({ model: 'm', messages: [ask, { role: 'assistant', content: [call] }, { role: 'user', content: [result] }], tools: [weather] });
});

test('schemaError covers types, required, extras, enums, arrays and nesting', () => {
  const schema = { type: 'object', required: ['n'], additionalProperties: false, properties: {
    n: { type: 'integer', minimum: 1 }, mode: { enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string', maxLength: 3 } }, ratio: { type: 'number' } } };
  assert.equal(schemaError({ n: 2, mode: 'a', tags: ['x'], ratio: 1 }, schema), null);
  assert.equal(schemaError({ n: 1.5 }, schema), 'input.n: expected integer');
  assert.equal(schemaError({ n: 0 }, schema), 'input.n: below minimum');
  assert.equal(schemaError({}, schema), 'input: missing required property "n"');
  assert.equal(schemaError({ n: 1, extra: 1 }, schema), 'input: unexpected property "extra"');
  assert.equal(schemaError({ n: 1, mode: 'c' }, schema), 'input.mode: value is not one of the allowed options');
  assert.equal(schemaError({ n: 1, tags: ['toolong'] }, schema), 'input.tags[0]: too long');
  assert.equal(schemaError([], schema), 'input: expected object');
});
