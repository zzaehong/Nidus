import { fundedLedger } from './helpers/ledger.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dispatch } from '../dist/dashboard.js';
import { ConnectivityEngine, GeminiAdapter, HttpClient } from '../dist/index.js';

test('dashboard connects with key, returns discovered models, refreshes, chats and disconnects', async () => {
  let storedKey = null, snapshot = null, requests = 0;
  const credentials = { get: async () => storedKey, set: async (_, k) => { storedKey = k; }, delete: async () => { storedKey = null; } };
  const store = { load: async () => snapshot, save: async s => { snapshot = s; }, remove: async () => { snapshot = null; } };
  const model = { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] };
  const adapter = new GeminiAdapter('https://example.invalid', new HttpClient(async (url, options) => {
    requests++;
    assert.equal(options.headers['x-goog-api-key'], 'synthetic-dashboard-key');
    return Response.json(String(url).includes(':generateContent') ? {
      candidates: [{ content: { parts: [{ text: 'Mock answer' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
    } : String(url).endsWith('/models') ? { models: [model] } : model);
  }));
  const engine = new ConnectivityEngine(credentials, store, { gemini: adapter }, fundedLedger());
  const call = (method, extra = {}) => dispatch({ method, provider: 'gemini', ...extra }, engine);
  assert.deepEqual((await call('cached')).models, []); assert.equal(requests, 0);
  const connected = await call('connect', { key: 'synthetic-dashboard-key',billing:{state:'paid_only',paidAllowed:true,confirmed:true,riskAccepted:true} });
  assert.equal(connected.models[0].id, 'gemini-2.5-flash');
  assert.equal(connected.source, 'api');
  assert.equal(JSON.stringify(connected).includes('synthetic-dashboard-key'), false);
  assert.equal((await call('cached')).source, 'cache'); assert.equal(requests, 1);
  await call('models'); assert.equal(requests, 2);
  assert.equal((await call('detail', { model: 'gemini-2.5-flash' })).id, 'gemini-2.5-flash');
  assert.equal((await call('pricing')).prices[0].status, 'verified_snapshot');
  const chat = await call('chat', { request: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }] } });
  assert.equal(chat.text, 'Mock answer'); assert.equal(chat.usage.totalTokens, 5);
  await call('disconnect'); assert.equal(storedKey, null); assert.equal(snapshot, null);
});

test('dashboard rejects malformed operations without credential echo', async () => {
  for (const input of [null, { method: 'connect', provider: 'gemini' }, { method: 'detail', provider: 'gemini' }, { method: 'chat', provider: 'gemini' }, { method: 'oops', provider: 'gemini', key: 'secret' }]) {
    await assert.rejects(dispatch(input, {}), error => !error.message.includes('secret'));
  }
});

function child(input) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/dashboard.js']); let stdout = '', stderr = '';
    p.stdout.on('data', c => { stdout += c; }); p.stderr.on('data', c => { stderr += c; });
    p.on('error', reject); p.on('close', code => resolve({ code, stdout, stderr })); p.stdin.end(input);
  });
}
test('dashboard subprocess stdout is a single JSON envelope; malformed input is sanitized', async () => {
  const ping = await child('{"method":"ping"}');
  assert.equal(ping.code, 0); assert.equal(ping.stderr, ''); assert.deepEqual(JSON.parse(ping.stdout), { result: { ready: true } });
  const broken = await child('{"key":"synthetic-secret"');
  assert.equal(JSON.parse(broken.stdout).error.code, 'invalid_request');
  assert.ok(!broken.stdout.includes('synthetic-secret')); assert.equal(broken.stderr, '');
});
