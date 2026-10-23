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
