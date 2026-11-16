import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectivityEngine } from '../../dist/engine.js';
import { FileModelStore } from '../../dist/storage.js';
import { adapters } from '../../dist/adapters/index.js';
import { credentialEnvironment } from '../../dist/credentials.js';

// Explicit opt-in only. No Keychain reads, no key values in test names or logs.
for (const [provider, adapter] of Object.entries(adapters())) {
  const enabled = process.env.NIDUS_LIVE === '1';
  const key = process.env[credentialEnvironment[provider]];
  test(`LIVE ${provider} model discovery`, { skip: !enabled ? 'NOT RUN: NIDUS_LIVE=1 not set' : !key ? 'NOT RUN: credential not provided' : false }, async () => {
    const models = await adapter.listModels(key);
    assert.ok(Array.isArray(models));
    assert.ok(models.every(m => m.id && m.provider === provider));
  });
  const model = process.env[`NIDUS_${provider.toUpperCase()}_MODEL`];
  test(`LIVE ${provider} paid chat`, { skip: !enabled || !key || !model || process.env.NIDUS_LIVE_CHAT !== '1' ? 'NOT RUN: requires credential, discovered model ID and NIDUS_LIVE_CHAT=1' : false }, async () => {
    const engine = new ConnectivityEngine({ get: async () => key }, new FileModelStore());
    const result = await engine.chat(provider, { model, messages: [{ role: 'user', content: 'Reply with a short greeting.' }], maxOutputTokens: 512 }, { timeoutMs: 120000 });
    assert.ok(result.text.length); assert.equal(result.provider, provider);
  });
}
