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

// Tests the diagnostic verdict, not an OS process-tree guarantee.
const { observationStatus } = await import('../scripts/agent-sandbox/lifecycle.mjs');
test('M0 lifecycle requires observed activity and independently detects continuing work', () => {
  const observation = {started:true,before:5,after:5,networkBefore:2,networkAfter:2};
  assert.equal(observationStatus(observation),'PASS');
  assert.equal(observationStatus({...observation,started:false}),'NOT_RUN');
  assert.equal(observationStatus({...observation,before:0}),'NOT_RUN');
  assert.equal(observationStatus({...observation,after:6}),'FAIL');
  assert.equal(observationStatus({...observation,networkAfter:3}),'FAIL');
});
