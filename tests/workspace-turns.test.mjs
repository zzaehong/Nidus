import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalGate, vmTurns } from '../dist/workspace/turns.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const signal = () => new AbortController().signal;

test('the VM goes to one Worker at a time: the next starts when the holder is done, also after a failure; a stopped turn never starts', async () => {
  const turns = vmTurns();
  let releaseA;
  const a = turns.take('a', signal(), () => new Promise(resolve => { releaseA = resolve; }));
  let bStarted = false;
  const b = turns.take('b', signal(), async () => { bStarted = true; throw new Error('b broke'); });
  const c = turns.take('c', signal(), async () => 'c done');
  await tick();
  assert.equal(turns.holder, 'a');
  assert.equal(bStarted, false, 'b waits for a');
  releaseA('a done');
  assert.equal(await a, 'a done');
  await assert.rejects(b, /b broke/);
  assert.equal(await c, 'c done', 'c runs although b failed');
  assert.equal(turns.holder, null);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(turns.take('d', stopped.signal, async () => 'never'), /stopped/);
});

test('a tool call waits only while an approval is pending, and wakes when the last one is answered or the task stops', async () => {
  let pending = 0;
  const gate = approvalGate(() => pending);
  assert.equal(await gate.wait(), false, 'nothing pending: no wait');
  pending = 2;
  let woke = null;
  const waiting = gate.wait().then(value => { woke = value; });
  pending = 1; gate.settled();
  await tick();
  assert.equal(woke, null, 'one approval still pending');
  pending = 0; gate.settled();
  await waiting;
  assert.equal(woke, true);
  pending = 1;
  const stop = new AbortController();
  const stopping = gate.wait(stop.signal);
  stop.abort();
  assert.equal(await stopping, true, 'a stopped task does not wait');
});
