import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateProfile, sandboxLiteral, command } from '../scripts/agent-sandbox/probe.mjs';

test('M0 profile rejects control characters and escapes sandbox syntax in paths', () => {
  for (const path of ['relative', '/tmp/a\n(allow default)', '/tmp/a\0']) assert.throws(() => sandboxLiteral(path));
  const path = '/tmp/a"(allow default)\\folder';
  assert.equal(JSON.parse(sandboxLiteral(path)), path);
  const profile = candidateProfile('/private/tmp/vault');
  assert.ok(profile.includes('(deny default)'));
  assert.ok(profile.includes('(subpath "/private/tmp/vault/.nidus")'));
  assert.ok(profile.includes('(subpath "/private/tmp/vault/.git")'));
  assert.ok(!profile.includes('(allow network'));
  assert.ok(!profile.includes('(allow file-read*)'));
});
test('M0 launcher distinguishes failure to launch from a successful denial check', async () => {
  const r = await command('/nonexistent/nidus-probe', [], '/private/tmp');
  assert.equal(r.launchError, true); assert.equal(r.code, null);
});
