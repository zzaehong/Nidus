import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../dist/cli.js';
import { ConnectivityEngine, GeminiAdapter, HttpClient } from '../dist/index.js';

test('CLI connect → discover → cached models → refresh → detail → pricing → chat → disconnect', async () => {
  const key = 'synthetic-workflow-key';
  let storedKey = null, snapshot = null; const httpCalls = []; const output = [];
  const credentials = { get: async () => storedKey, set: async (p, k) => { storedKey = k; }, delete: async () => { storedKey = null; } };
  const store = { load: async () => snapshot, save: async s => { snapshot = s; }, remove: async () => { snapshot = null; } };
  const model = { name: 'models/arbitrary-new-model', displayName: 'Arbitrary', supportedGenerationMethods: ['generateContent'] };
  const http = new HttpClient(async (url, options) => {
    httpCalls.push(String(url));
    assert.equal(options.headers['x-goog-api-key'], key);
    return Response.json(String(url).includes(':generateContent')
      ? { candidates: [{ content: { parts: [{ text: 'Actual mock response' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
      : String(url).endsWith('/models') ? { models: [model] } : model);
  });
  const engine = new ConnectivityEngine(credentials, store, { gemini: new GeminiAdapter('https://example.invalid', http) });
  const dependencies = { engine, readSecret: async () => key, readPrompt: async () => 'Hello', write: text => output.push(JSON.parse(text)) };
  await main(['connect', 'gemini'], dependencies);
  assert.equal(storedKey, key); assert.equal(httpCalls.length, 1);
  await main(['models', 'gemini'], dependencies); assert.equal(httpCalls.length, 1);
  await main(['models', 'gemini', '--refresh'], dependencies); assert.equal(httpCalls.length, 2);
  await main(['models', 'gemini', '--detail', 'arbitrary-new-model'], dependencies);
  await main(['pricing', 'gemini'], dependencies); assert.equal(output.at(-1).prices[0].status, 'unknown');
  await main(['chat', '--provider', 'gemini', '--model', 'arbitrary-new-model'], dependencies);
  assert.equal(output.at(-1).text, 'Actual mock response'); assert.equal(output.at(-1).usage.totalTokens, 5);
  assert.ok(!JSON.stringify(output).includes(key)); assert.ok(!JSON.stringify(snapshot).includes(key));
  await main(['disconnect', 'gemini'], dependencies);
  assert.equal(storedKey, null); assert.equal(snapshot, null);
});
