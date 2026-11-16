import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../dist/http.js';
import { ProviderClient } from '../dist/gateway/providers.js';
import { ModelGateway } from '../dist/gateway/gateway.js';
import { initVault } from '../dist/gateway/vault.js';
import { modelHealth, restMs, hedgeDelayMs, resting } from '../dist/gateway/health.js';
import { sendWithRetry, resetCooling } from '../dist/workspace/worker.js';

const credentials = { async get() { return 'k'; }, async set() {}, async delete() {} };
const hello = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

/** Two providers in one slot: groq first, deepseek second. behave(provider) -> { ms, status } per chat call. */
async function setup(t, behave, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nidus-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { paths } = await initVault(root);
  await writeFile(paths.modelsFile, JSON.stringify({ version: 1, roles: { main: ['groq:slow-one', 'deepseek:fast-one'], manager: [], 'lead-manager': [] }, worker: { simple: [], normal: [], complex: [] } }));
  const calls = [];
  const http = new HttpClient((url, init) => {
    const provider = String(url).includes('groq') ? 'groq' : 'deepseek';
    if (init.method === 'GET') return Promise.resolve(new Response(JSON.stringify({ data: [{ id: provider === 'groq' ? 'slow-one' : 'fast-one' }] }), { status: 200 }));
    calls.push(provider);
    const { ms = 0, status = 200 } = behave(provider, calls.length);
    // Like fetch: an aborted request rejects at once.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(status === 200 ? JSON.stringify(reply(provider)) : '{}', { status })), ms);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason ?? new Error('aborted')); }, { once: true });
    });
  });
  let clock = new Date('2026-11-12T10:00:00Z');
  const gateway = new ModelGateway(paths, { credentials, providers: new ProviderClient({ http }), now: () => clock, hedgeDelayMs: () => 40, ...options });
  t.after(() => gateway.close());
  for (const p of ['groq', 'deepseek']) await gateway.refreshModels(p);
  return { gateway, calls, paths, advance: ms => { clock = new Date(clock.getTime() + ms); } };
}

test('failures in a row make a model rest longer each time; a success ends the run; a missing model rests a day', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(n => restMs(n, 'timeout') / 60_000), [0, 1, 3, 9, 27, 81, 120, 120]);
  assert.equal(restMs(1, 'not_found'), 24 * 3600_000);
  const row = (model, at, status, error = null, durationMs = 1000) => ({ provider: 'p', model, at, status, error, durationMs });
  const health = modelHealth([
    row('a', '2026-11-12T10:05:00Z', 'failed', 'timeout'),
    row('a', '2026-11-12T10:04:00Z', 'cancelled', 'cancelled'), // the user stopped it: says nothing about the model
    row('a', '2026-11-12T10:03:00Z', 'cancelled', 'slow'),
    row('a', '2026-11-12T10:02:00Z', 'succeeded', null, 30_000),
    row('a', '2026-11-12T10:01:00Z', 'failed', 'timeout'),
    row('b', '2026-11-12T10:05:00Z', 'failed', 'invalid_request'), // the request's fault
    row('c', '2026-11-12T10:00:00Z', 'failed', 'not_found'),
  ]);
  assert.equal(health.get('p:a').streak, 2);
  assert.equal(health.get('p:a').restUntil.toISOString(), '2026-11-12T10:08:00.000Z');
  assert.equal(health.get('p:a').medianMs, 30_000);
  assert.equal(health.get('p:b').streak, 0);
  assert.deepEqual(resting(health, new Date('2026-11-12T10:07:00Z')), ['p:a', 'p:c']);
  assert.deepEqual(resting(health, new Date('2026-11-12T10:09:00Z')), ['p:c']);
  assert.deepEqual([null, 1000, 10_000, 100_000].map(hedgeDelayMs), [45_000, 20_000, 25_000, 60_000]);
});

test('a slow call is sent to the next candidate too; the first answer wins and the slow model moves back', async t => {
  const { gateway, calls } = await setup(t, provider => ({ ms: provider === 'groq' ? 2000 : 5 }));
  const started = Date.now();
  const result = await gateway.send({ role: 'main' }, hello);
  assert.ok(Date.now() - started < 1000, 'did not wait for the slow model');
  assert.equal(result.response.content[0].text, 'deepseek');
  assert.equal(result.warnings.find(w => w.code === 'hedged')?.message.includes('groq:slow-one'), true);
  assert.deepEqual(calls, ['groq', 'deepseek']);
  await new Promise(resolve => setTimeout(resolve, 20)); // the stopped call is recorded as it ends
  const health = gateway.health();
  assert.equal(health.get('groq:slow-one').lastError, 'slow');
  // It rests now: the next call goes straight to the other candidate, with no wait.
  const next = await gateway.send({ role: 'main' }, hello);
  assert.equal(next.response.content[0].text, 'deepseek');
  assert.deepEqual(calls, ['groq', 'deepseek', 'deepseek']);
  assert.equal(next.warnings.some(w => w.code === 'hedged'), false);
});

test('a model that keeps failing rests, across a new Gateway too, and comes back when its rest is over', async t => {
  const { gateway, calls, advance } = await setup(t, provider => provider === 'groq' ? { status: 500 } : {}, { hedgeDelayMs: null });
  await assert.rejects(gateway.send({ role: 'main' }, hello), e => e.modelRef === 'groq:slow-one');
  assert.equal((await gateway.send({ role: 'main' }, hello)).response.content[0].text, 'deepseek');
  advance(61_000);
  await assert.rejects(gateway.send({ role: 'main' }, hello), e => e.modelRef === 'groq:slow-one');
  advance(61_000); // the second failure in a row rests 3 minutes
  assert.equal((await gateway.send({ role: 'main' }, hello)).response.content[0].text, 'deepseek');
  assert.deepEqual(calls, ['groq', 'deepseek', 'groq', 'deepseek']);
});

test('when the slot has no other candidate, a slow call is simply waited for', async t => {
  const { gateway, calls, paths } = await setup(t, () => ({ ms: 150 }));
  await writeFile(paths.modelsFile, JSON.stringify({ version: 1, roles: { main: ['groq:slow-one'], manager: [], 'lead-manager': [] }, worker: { simple: [], normal: [], complex: [] } }));
  const result = await gateway.send({ role: 'main' }, hello);
  assert.equal(result.response.content[0].text, 'groq');
  assert.deepEqual(calls, ['groq']);
});

test('a missing model (not_found) is passed over for another candidate instead of failing the work', async t => {
  resetCooling();
  const { gateway, calls } = await setup(t, provider => provider === 'groq' ? { status: 404 } : {}, { hedgeDelayMs: null });
  const result = await sendWithRetry(gateway, { role: 'main' }, hello, new AbortController().signal, { waits: [], rateLimitWaits: [] });
  assert.equal(result.response.content[0].text, 'deepseek');
  assert.deepEqual(calls, ['groq', 'deepseek']);
  assert.equal(gateway.health().get('groq:slow-one').restUntil > new Date('2026-11-13T09:00:00Z'), true, 'rests about a day');
});

test('when the first model answers after all, the backup it no longer needs is not counted against', async t => {
  const { gateway, calls } = await setup(t, provider => ({ ms: provider === 'groq' ? 80 : 2000 }));
  const result = await gateway.send({ role: 'main' }, hello);
  assert.equal(result.response.content[0].text, 'groq');
  assert.deepEqual(calls, ['groq', 'deepseek']);
  await new Promise(resolve => setTimeout(resolve, 20));
  const health = gateway.health();
  assert.equal(health.get('deepseek:fast-one').streak, 0, 'the unused backup does not rest');
  assert.equal(health.get('groq:slow-one').streak, 0);
});
