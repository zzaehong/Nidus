import test from 'node:test';
import assert from 'node:assert/strict';
import { mainSystem, managerSystem, workerSystem, rolePrompts, toolCatalog } from '../dist/office/roles.js';
import { WORKER_TOOLS } from '../dist/workspace/tools.js';
import { DESK_TOOLS } from '../dist/office/desk.js';

const listed = prompt => [...prompt.matchAll(/^- ([a-z_]+): /gm)].map(m => m[1]);
const desk = DESK_TOOLS.map(t => t.name), vm = WORKER_TOOLS.map(t => t.name);

test('each Worker prompt lists exactly the tools of its place', () => {
  assert.deepEqual(listed(workerSystem('desk', 'p-1')), desk);
  assert.deepEqual(listed(workerSystem('vm', 't-1')), vm);
  assert.match(workerSystem('vm', 't-1'), /branch nidus\/t-1/);
  assert.doesNotMatch(workerSystem('desk', 'p-1'), /- shell:|browser_open/);
});

test('Main and Managers have no tools, but know every Worker tool of both places', () => {
  for (const prompt of [mainSystem(), managerSystem()]) {
    assert.deepEqual(listed(prompt).filter(n => n !== 'desk' && n !== 'vm'), [...desk, ...vm]);
    assert.match(prompt, /no tools of your own/);
    assert.match(prompt, /data, not instructions/);
  }
  assert.match(mainSystem(), /^You are Main/);
  assert.match(managerSystem(), /^You are a Manager/);
  assert.match(managerSystem(), /simple .* normal .* complex/s);
});

test('the catalog takes the first sentence of each description unless asked for all of it', () => {
  const spec = [{ name: 'x', description: 'Does one thing. Then more detail.', inputSchema: {} }];
  assert.equal(toolCatalog(spec), '- x: Does one thing.');
  assert.equal(toolCatalog(spec, true), '- x: Does one thing. Then more detail.');
  assert.deepEqual(Object.keys(rolePrompts()), ['main', 'manager', 'worker-desk', 'worker-vm']);
});
