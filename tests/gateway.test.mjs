import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../dist/http.js';
import { ProviderClient } from '../dist/gateway/providers.js';
import { ModelGateway } from '../dist/gateway/gateway.js';
import { initVault, openVault } from '../dist/gateway/vault.js';
import { parseTable, parseRef } from '../dist/gateway/assignment.js';
import { toolCallsOf, textOf } from '../dist/gateway/contract.js';
import { gatewayMain } from '../dist/gateway/cli.js';

class MemoryCredentials {
  constructor(keys = {}) { this.keys = new Map(Object.entries(keys)); this.reads = 0; }
  async get(provider) { this.reads++; return this.keys.get(provider) ?? null; }
  async set(provider, key) { this.keys.set(provider, key); }
  async delete(provider) { this.keys.delete(provider); }
}

// Routes by URL: model listings come from `catalog`, chat calls from `chat(provider, body)`.
function fakeProviders(catalog, chat) {
  const calls = [];
  const http = new HttpClient(async (url, init) => {
    const target = String(url);
    const provider = target.includes('anthropic') ? 'anthropic' : target.includes('openai.com') ? 'openai' : target.includes('groq') ? 'groq' : 'deepseek';
    let body;
    if (init.method === 'GET') body = { data: (catalog[provider] ?? []).map(id => ({ id, ...(provider === 'anthropic' ? { max_tokens: 4000, capabilities: { tool_use: { supported: true } } } : {}) })) };
    else { const sent = JSON.parse(init.body); calls.push({ provider, body: sent }); body = await chat(provider, sent); }
    if (body.httpStatus) return new Response('{}', { status: body.httpStatus });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { providers: new ProviderClient({ http }), calls };
}

const anthropicText = text => ({ model: 'claude-big', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 } });
const completionText = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const hello = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

async function vault(t, table, budget) {
  const root = await mkdtemp(join(tmpdir(), 'nidus-gateway-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { paths } = await initVault(root);
  if (table) await writeFile(paths.modelsFile, JSON.stringify(table));
  if (budget !== undefined) await writeFile(paths.budgetFile, JSON.stringify({ version: 1, monthlyUSD: budget }));
  return paths;
}

const table = {
  version: 1,
  roles: { main: ['anthropic:claude-big'], manager: ['openai:gpt-missing', 'anthropic:claude-big'], 'lead-manager': [] },
  worker: { simple: ['groq:openai/gpt-oss-120b', 'deepseek:deepseek-flash'], normal: ['deepseek:deepseek-flash'], complex: ['anthropic:claude-big'] },
};

test('init creates the .nidus layout once and keeps runtime data out of Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nidus-gateway-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(openVault(root), { code: 'storage' });

  const first = await initVault(root);
  assert.equal(first.created.length, 3);
  assert.equal(await readFile(first.paths.gitignore, 'utf8'), 'local/\n');
  assert.deepEqual(Object.keys(parseTable(JSON.parse(await readFile(first.paths.modelsFile, 'utf8'))).roles), ['main', 'lead-manager', 'manager']);

  await writeFile(first.paths.modelsFile, JSON.stringify(table));
  await writeFile(first.paths.gitignore, '*.tmp');
  const second = await initVault(root);
  assert.deepEqual(second.created, []);
  assert.deepEqual(JSON.parse(await readFile(first.paths.modelsFile, 'utf8')), table, 'existing table is never overwritten');
  assert.equal(await readFile(first.paths.gitignore, 'utf8'), '*.tmp\nlocal/\n');
});

test('assignment table parsing rejects malformed input', () => {
  assert.deepEqual(parseRef('groq:openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(parseRef('cloudflare:@cf/meta/llama:latest'), { provider: 'cloudflare', model: '@cf/meta/llama:latest' });
  for (const bad of [null, { version: 2, roles: {}, worker: {} }, { version: 1, roles: { worker: [] }, worker: {} }, { version: 1, roles: { Main: [] }, worker: {} },
    { version: 1, roles: {}, worker: { hard: [] } }, { version: 1, roles: { main: ['nope:model'] }, worker: {} }, { version: 1, roles: { main: ['openai:'] }, worker: {} }, { version: 1, roles: { main: 'openai:x' }, worker: {} }])
    assert.throws(() => parseTable(bad), { code: 'invalid_request' }, JSON.stringify(bad));
});

test('assignment follows role and worker difficulty, falls back in order and never borrows another slot', async t => {
  const paths = await vault(t, table);
  const credentials = new MemoryCredentials({ anthropic: 'ka', deepseek: 'kd', openai: 'ko' });
  const { providers } = fakeProviders({ anthropic: ['claude-big'], deepseek: ['deepseek-flash'], openai: ['gpt-other'] }, () => ({}));
  const gateway = new ModelGateway(paths, { credentials, providers });
  t.after(() => gateway.close());
  for (const provider of ['anthropic', 'deepseek', 'openai']) await gateway.refreshModels(provider);

  const main = await gateway.assign({ role: 'main' });
  assert.equal(`${main.provider}:${main.model}`, 'anthropic:claude-big');
  assert.equal(main.candidateIndex, 0);
  assert.equal(main.outputTokenLimit, 4000);

  // First manager candidate is missing from the provider's model list.
  const manager = await gateway.assign({ role: 'manager', needs: { tools: true } });
  assert.equal(manager.model, 'claude-big');
  assert.equal(manager.candidateIndex, 1);
  assert.match(manager.reason, /fallback #1 \(openai:gpt-missing: model not in the cached model list\); tools confirmed/);

  // Groq has no key, so the simple slot falls through to DeepSeek.
  const simple = await gateway.assign({ role: 'worker', difficulty: 'simple', needs: { tools: true } });
  assert.equal(simple.provider, 'deepseek');
  assert.match(simple.reason, /no API key connected.*tools unverified/);
  assert.equal((await gateway.assign({ role: 'worker', difficulty: 'complex' })).model, 'claude-big');

  await assert.rejects(gateway.assign({ role: 'worker' }), { code: 'invalid_request' });
  await assert.rejects(gateway.assign({ role: 'main', difficulty: 'simple' }), { code: 'invalid_request' });
  await assert.rejects(gateway.assign({ role: 'reviewer' }), { code: 'invalid_request' });
  await assert.rejects(gateway.assign({ role: 'lead-manager' }), error => error.code === 'unsupported' && error.reason === 'no_assignable_model');
  assert.ok(credentials.reads <= 4, 'each provider key is read at most once per gateway');
});

test('send calls the assigned model, clamps output to the model limit and records usage by role and difficulty', async t => {
  const paths = await vault(t, table);
  const credentials = new MemoryCredentials({ anthropic: 'ka', deepseek: 'kd' });
  const { providers, calls } = fakeProviders({ anthropic: ['claude-big'], deepseek: ['deepseek-flash'] },
    provider => provider === 'anthropic' ? anthropicText('plan') : completionText('done'));
  const gateway = new ModelGateway(paths, { credentials, providers, now: () => new Date('2026-11-11T00:00:00Z') });
  t.after(() => gateway.close());
  await gateway.refreshModels('anthropic'); await gateway.refreshModels('deepseek');

  const planned = await gateway.send({ role: 'main', agentId: 'agent-1', taskId: 'task-1' }, { ...hello, maxOutputTokens: 9000 });
  assert.equal(textOf(planned.response.content), 'plan');
  assert.equal(calls[0].body.model, 'claude-big');
  assert.equal(calls[0].body.max_tokens, 4000);
  assert.equal(planned.costUSD, null);
  assert.deepEqual(planned.warnings.map(w => w.code), ['cost_unknown']);

  // deepseek-flash has a reviewed price: 10 input + 5 output tokens at the higher listed rate.
  const worked = await gateway.send({ role: 'worker', difficulty: 'normal' }, hello);
  assert.equal(calls[1].provider, 'deepseek');
  assert.equal(worked.costUSD, '0.000009000');
  assert.deepEqual(worked.warnings, []);
  await gateway.send({ role: 'worker', difficulty: 'normal' }, hello);

  const summary = gateway.usageSummary();
  assert.equal(summary.month, '2026-11');
  assert.equal(summary.calls, 3);
  assert.equal(summary.costUSD, '0.000018000');
  assert.equal(summary.unknownCostCalls, 1);
  assert.deepEqual(summary.groups.map(g => [g.role, g.difficulty, g.model, g.calls, g.inputTokens, g.outputTokens]),
    [['main', null, 'claude-big', 1, 100, 20], ['worker', 'normal', 'deepseek-flash', 2, 20, 10]]);

  assert.equal((await stat(paths.usageDb)).mode & 0o777, 0o600);
  const events = [];
  for await (const event of gateway.stream({ role: 'main' }, hello)) events.push(event.type);
  assert.deepEqual(events, ['text_delta', 'done']);
});

test('failed calls are recorded and rethrown; an exceeded budget warns but does not block', async t => {
  const paths = await vault(t, table, '0.00001');
  const credentials = new MemoryCredentials({ deepseek: 'kd' });
  let fail = true;
  const { providers } = fakeProviders({ deepseek: ['deepseek-flash'] }, () => fail ? { httpStatus: 429 } : completionText('ok'));
  const gateway = new ModelGateway(paths, { credentials, providers });
  t.after(() => gateway.close());
  await gateway.refreshModels('deepseek');

  await assert.rejects(gateway.send({ role: 'worker', difficulty: 'normal' }, hello), { code: 'rate_limit' });
  fail = false;
  assert.deepEqual((await gateway.send({ role: 'worker', difficulty: 'normal' }, hello)).warnings, []);
  const over = await gateway.send({ role: 'worker', difficulty: 'normal' }, hello);
  assert.equal(textOf(over.response.content), 'ok', 'the call still completes');
  assert.deepEqual(over.warnings.map(w => w.code), ['budget_exceeded']);

  const [group] = gateway.usageSummary().groups;
  assert.equal(group.calls, 3);
  assert.equal(group.failed, 1);

  await writeFile(paths.budgetFile, '{"version":1,"monthlyUSD":"lots"}');
  await assert.rejects(gateway.send({ role: 'worker', difficulty: 'normal' }, hello), { code: 'invalid_request' });
});

test('verifyTools runs a real round trip and assignment then reports tools as confirmed', async t => {
  const paths = await vault(t, table);
  const credentials = new MemoryCredentials({ deepseek: 'kd' });
  const { providers, calls } = fakeProviders({ deepseek: ['deepseek-flash', 'deepseek-mute'] }, (_, body) => {
    if (body.model === 'deepseek-mute') return completionText('I cannot use tools.');
    const answered = body.messages.some(message => message.role === 'tool');
    return answered ? completionText('The sum is 42.')
      : { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'add', arguments: '{"a":17,"b":25}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
  });
  const gateway = new ModelGateway(paths, { credentials, providers });
  t.after(() => gateway.close());
  await gateway.refreshModels('deepseek');

  assert.deepEqual(await gateway.verifyTools('deepseek', 'deepseek-mute'), { supported: false, detail: 'The model did not call the tool.' });
  assert.equal(await gateway.toolsVerified('deepseek', 'deepseek-mute'), false);

  assert.equal((await gateway.verifyTools('deepseek', 'deepseek-flash')).supported, true);
  assert.equal(calls.at(-1).body.messages.at(-1).role, 'tool');
  assert.match((await gateway.assign({ role: 'worker', difficulty: 'normal', needs: { tools: true } })).reason, /tools confirmed/);
  assert.deepEqual(gateway.usageSummary().groups.map(g => [g.role, g.model, g.calls]), [['probe', 'deepseek-flash', 2], ['probe', 'deepseek-mute', 1]]);
});

test('CLI: init, connect, models, assign, ask and usage against one vault', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nidus-gateway-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = new MemoryCredentials();
  const { providers, calls } = fakeProviders({ deepseek: ['deepseek-flash'] }, () => completionText('pong'));
  const run = async (args, extra = {}) => {
    let output = '';
    await gatewayMain([...args, '--vault', root], { credentials, providers, write: text => { output += text; }, ...extra });
    return JSON.parse(output);
  };

  await assert.rejects(run(['usage']), { code: 'storage' });
  assert.equal((await run(['init'])).created.length, 3);
  await writeFile(join(root, '.nidus', 'models.json'), JSON.stringify(table));

  assert.deepEqual(await run(['connect', 'deepseek'], { readSecret: async () => 'secret-key' }), { provider: 'deepseek', stored: true, models: 1 });
  assert.equal(credentials.keys.get('deepseek'), 'secret-key');
  assert.equal((await run(['models', 'deepseek'])).models[0].id, 'deepseek-flash');
  assert.equal((await run(['assign', '--role', 'worker', '--difficulty', 'normal'])).model, 'deepseek-flash');

  const answer = await run(['ask', '--role', 'worker', '--difficulty', 'normal', '--system', 'Reply pong.'], { readPrompt: async () => 'ping' });
  assert.equal(answer.text, 'pong');
  assert.equal(answer.model, 'deepseek-flash');
  assert.deepEqual(calls[0].body.messages, [{ role: 'system', content: 'Reply pong.' }, { role: 'user', content: 'ping' }]);
  assert.equal((await run(['usage'])).calls, 1);

  await assert.rejects(run(['ask', '--role', 'worker', '--difficulty', 'extreme']), { code: 'invalid_request' });
  await assert.rejects(run(['assign']), { code: 'invalid_request' });
  await assert.rejects(run(['nonsense']), { code: 'invalid_request' });
  assert.equal(toolCallsOf([]).length, 0);
});
