import { fundedLedger } from './helpers/ledger.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectivityEngine, FileModelStore, NidusError, priceFor, pricesFor, EnvironmentCredentials } from '../dist/index.js';

const model = { provider: 'gemini', id: 'new-from-api', name: 'New', capabilities: { chat: 'supported', tools: 'unknown', vision: 'unknown', streaming: 'unknown' }, limits: { inputTokens: null, outputTokens: null, contextTokens: null }, details: {}, capabilitySource: 'models-api' };
function fixture() {
  const secrets = new Map(), cache = new Map(); let calls = 0; let fail = false;
  const credentials = { get: async p => secrets.get(p) ?? null, set: async (p, k) => { secrets.set(p, k); }, delete: async p => { secrets.delete(p); } };
  const store = { load: async p => cache.get(p) ?? null, save: async s => { cache.set(s.provider, s); }, remove: async p => { cache.delete(p); } };
  const adapter = { id: 'gemini', listModels: async key => { calls++; if (fail || key === 'invalid') throw new NidusError('authentication', 'Invalid credentials'); return [structuredClone(model)]; }, getModel: async () => structuredClone(model), chat: async () => ({ text: 'OK' }) };
  const engine = new ConnectivityEngine(credentials, store, { gemini: adapter }, fundedLedger());
  return { engine, cache, secrets, credentials, calls: () => calls, fail: () => { fail = true; } };
}
test('connect validates before persisting, refresh updates, failure preserves old registration', async () => {
  const f = fixture();
  await assert.rejects(f.engine.connect('gemini', 'invalid'), e => e.code === 'authentication');
  assert.equal(f.secrets.size, 0); assert.equal(f.cache.size, 0);
  const connected = await f.engine.connect('gemini', 'synthetic-secret');
  assert.equal(connected.authentication, 'models-api-verified'); assert.equal(connected.chatVerification, 'not-run');
  assert.equal(connected.models[0].pricing.status, 'unknown');
  assert.equal((await f.engine.models('gemini')).source, 'cache'); assert.equal(f.calls(), 2);
  await f.engine.models('gemini', true); assert.equal(f.calls(), 3);
  const before = JSON.stringify(f.cache.get('gemini'));
  f.fail(); await assert.rejects(f.engine.connect('gemini', 'replacement'));
  await assert.rejects(f.engine.models('gemini', true));
  assert.equal(f.secrets.get('gemini'), 'synthetic-secret'); assert.equal(JSON.stringify(f.cache.get('gemini')), before);
  assert.ok(!before.includes('synthetic-secret'));
  await f.engine.disconnect('gemini'); assert.equal(f.cache.size, 0); assert.equal(f.secrets.size, 0);
});
test('ephemeral connect never writes credentials, unknown capabilities remain selectable', async () => {
  const f = fixture(); await f.engine.connect('gemini', 'key', false); assert.equal(f.secrets.size, 0);
  f.secrets.set('gemini', 'key');await f.engine.setAccountPermission('gemini','paid_only',true,true,true);
  f.cache.get('gemini').models[0].capabilities.chat = 'unknown';
  await f.engine.chat('gemini', { model: model.id, messages: [{ role: 'user', content: 'hi' }] });
  f.cache.get('gemini').models[0].capabilities.chat = 'unsupported';
  await assert.rejects(f.engine.chat('gemini', { model: model.id, messages: [] }), e => e.code === 'unsupported');
});
test('model snapshots survive restart, are private and contain no credential fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nidus-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot = { version: 1, provider: 'gemini', fetchedAt: new Date().toISOString(), models: [model] };
  await new FileModelStore(directory).save(snapshot);
  assert.deepEqual(await new FileModelStore(directory).load('gemini'), snapshot);
  const file = join(directory, 'gemini.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, 'utf8')).includes('apiKey'));
  assert.deepEqual(await readdir(directory), ['gemini.json']);
});
test('prices are exact matches with provenance and never turn unknown into free', () => {
  assert.equal(priceFor('gemini', 'gemini-2.5-flash').rates[0].input, 0.3);
  assert.equal(priceFor('gemini', 'gemini-2.5-flash-new').status, 'unknown');
  assert.equal(priceFor('openai', 'claude-sonnet-4-6').status, 'unknown');
  assert.deepEqual(priceFor('openai', 'new').rates, []);
  assert.equal(priceFor('openai', 'new').freeTier, 'unknown');
  for (const p of ['openai', 'anthropic', 'gemini', 'deepseek']) {
    for (const price of pricesFor(p)) { assert.ok(price.sourceUrl.startsWith('https://')); assert.ok(Number.isFinite(Date.parse(price.checkedAt))); }
  }
  assert.equal(pricesFor('deepseek')[0].rates.length, 2);
});
test('environment credential override does not write persistent store', async () => {
  const f = fixture();
  const env = new EnvironmentCredentials(f.credentials, { NIDUS_GEMINI_API_KEY: 'session-only' });
  assert.equal(await env.get('gemini'), 'session-only'); assert.equal(f.secrets.size, 0);
});

test('cache write failure rolls back credential rotation', async () => {
  let stored = 'previous';
  const credentials = { get: async () => stored, set: async (p, key) => { stored = key; }, delete: async () => { stored = null; } };
  const store = { save: async () => { throw new NidusError('storage', 'Disk full'); } };
  const engine = new ConnectivityEngine(credentials, store, { gemini: { listModels: async () => [model] } });
  await assert.rejects(engine.connect('gemini', 'replacement'), e => e.code === 'storage');
  assert.equal(stored, 'previous');
});
