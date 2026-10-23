import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const run = (...args) => spawnSync(process.execPath, ['bin/nidus.mjs', ...args], { encoding: 'utf8', input: '', timeout: 10000 });
test('CLI help and providers work without keys, network, or Keychain', () => {
  assert.equal(run('--help').status, 0);
  const result = run('providers'); assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).map(p => p.id), ['openai', 'anthropic', 'gemini', 'deepseek']);
});
test('CLI rejects secrets in arguments without echoing them', () => {
  const result = run('connect', 'gemini', '--api-key', 'secret-should-not-appear');
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error.code, 'invalid_request');
  assert.ok(!result.stderr.includes('secret-should-not-appear')); assert.equal(result.stdout, '');
});
test('CLI refuses non-TTY key input instead of echoing or hanging', () => {
  const result = run('connect', 'gemini'); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'invalid_request');
});
test('CLI pricing is available offline and marks snapshot source', () => {
  const result = run('pricing', 'openai'); assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).autoRefresh, false);
});
