import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { KeychainStore } from '../../dist/credentials.js';

test('macOS Keychain synthetic credential create/read/update/delete', { skip: process.platform !== 'darwin' ? 'NOT RUN: macOS required' : false }, async () => {
  const store = new KeychainStore(undefined, `com.nidus.connectivity.test.${randomUUID()}`);
  try {
    assert.equal(await store.get('gemini'), null);
    await store.set('gemini', 'synthetic-not-a-real-api-key');
    assert.equal(await store.get('gemini'), 'synthetic-not-a-real-api-key');
    await store.set('gemini', 'synthetic-replacement');
    assert.equal(await store.get('gemini'), 'synthetic-replacement');
    await store.delete('gemini');
    assert.equal(await store.get('gemini'), null);
  } finally { await store.delete('gemini'); }
});

for (const provider of ['nvidia', 'groq', 'mistral', 'cloudflare']) {
  test(`${provider} isolated Keychain synthetic create/update/delete`, {skip:process.platform!=='darwin'}, async()=>{
    const store=new KeychainStore(undefined,`com.nidus.connectivity.test.${randomUUID()}`);
    const value=provider==='cloudflare'?JSON.stringify({token:'synthetic',accountId:'a'.repeat(32)}):'synthetic';
    try {
      await store.set(provider,value);assert.equal(await store.get(provider),value);
      await store.set(provider,'replacement');assert.equal(await store.get(provider),'replacement');
      await store.delete(provider);assert.equal(await store.get(provider),null);
    } finally { await store.delete(provider); }
  });
}
