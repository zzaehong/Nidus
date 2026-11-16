import test from 'node:test';
import assert from 'node:assert/strict';
import { clearOldResults, conversationChars, summaryCut, applySummary, transcript, DEFAULT_COMPACT } from '../dist/workspace/compact.js';
import { WorkerRun, resetCooling } from '../dist/workspace/worker.js';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const call = (id, name, input) => ({ role: 'assistant', content: [{ type: 'text', text: `step ${id}` }, { type: 'tool_call', id, name, input }] });
const result = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', callId: id, content, isError: false }] });
function conversation(steps, size) {
  const messages = [user('지시: 보고서를 써라')];
  for (let i = 1; i <= steps; i++) messages.push(call(`c${i}`, i === 1 ? 'write_file' : 'read_file', i === 1 ? { path: 'a.md', content: 'x'.repeat(5000) } : { path: `f${i}` }), result(`c${i}`, `내용${i} `.repeat(size)));
  return messages;
}
const pairs = messages => {
  const calls = messages.flatMap(m => m.content.filter(b => b.type === 'tool_call').map(b => b.id));
  const results = messages.flatMap(m => m.content.filter(b => b.type === 'tool_result').map(b => b.callId));
  return { calls, results };
};

test('nothing is cleared while the old tool results are small', () => {
  const messages = conversation(6, 100);
  const before = JSON.stringify(messages);
  assert.equal(clearOldResults(messages), 0);
  assert.equal(JSON.stringify(messages), before);
});

test('old tool results and large inputs are cleared in one batch; the latest stay whole and calls stay paired', () => {
  const messages = conversation(10, 2000);
  const before = conversationChars(messages);
  const removed = clearOldResults(messages);
  assert.ok(removed > 0 && conversationChars(messages) === before - removed);
  const results = messages.flatMap(m => m.content.filter(b => b.type === 'tool_result'));
  assert.equal(results.filter(r => r.content.startsWith('[cleared')).length, 10 - DEFAULT_COMPACT.keepResults);
  assert.match(results[0].content, /write_file result, \d+ characters, began "내용1/);
  assert.match(results[0].content, /run the tool again/);
  assert.equal(results.at(-1).content, '내용10 '.repeat(2000), 'the latest results stay whole');
  assert.match(messages[1].content[1].input.content, /^\[5000 characters, cleared\]$/);
  assert.equal(messages[1].content[1].input.path, 'a.md');
  const { calls, results: answered } = pairs(messages);
  assert.deepEqual(calls, answered);
  // Stable between batches: right after clearing, nothing more changes.
  const once = JSON.stringify(messages);
  assert.equal(clearOldResults(messages), 0);
  assert.equal(JSON.stringify(messages), once);
});

test('a summary replaces the start; the instructions and the latest turns stay, calls stay paired', () => {
  const messages = conversation(8, 10);
  const cut = summaryCut(messages, 6);
  assert.equal(messages[cut].role, 'assistant');
  assert.equal(messages.length - cut, 6);
  assert.match(transcript(messages.slice(0, cut)), /USER: 지시: 보고서를 써라[\s\S]*CALL write_file \{"path":"a.md","content":"\[5000 characters, cleared\]"\}[\s\S]*RESULT: 내용1/);
  applySummary(messages, cut, '요약: f2~f5를 읽었다', ['지시: 보고서를 써라']);
  assert.equal(messages.length, 7);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content[0].text, /^\[Summary of the work so far[\s\S]*Your instructions:\n지시: 보고서를 써라[\s\S]*요약: f2~f5를 읽었다/);
  assert.equal(messages[1].role, 'assistant');
  const { calls, results } = pairs(messages);
  assert.deepEqual(calls, results);
  assert.equal(summaryCut([user('x'), call('a', 'r', {}), result('a', 'y')], 6), null, 'too short to summarize');
});

async function longRun(compact) {
  resetCooling();
  const usage = { inputTokens: 1, outputTokens: 1 };
  const sent = [];
  let step = 0;
  const gateway = { async send(target, request) {
    sent.push({ system: request.system, chars: JSON.stringify(request.messages).length, first: request.messages[0].content[0].text ?? '' });
    if (request.system.startsWith('You compact')) return { response: { provider: 'p', model: 'summarizer', content: [{ type: 'text', text: '요약: 파일 12개를 읽었고 다음은 보고서 작성' }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
    step++;
    const content = step < 14 ? [{ type: 'tool_call', id: `c${step}`, name: 'read_file', input: { path: `f${step}` } }] : [{ type: 'tool_call', id: 'end', name: 'finish', input: { summary: '끝' } }];
    return { response: { provider: 'p', model: 'm', content, stopReason: 'tool_use', usage }, costUSD: null, warnings: [] };
  } };
  const tools = { specs: [], async run(c) { return c.name === 'finish' ? { content: 'ok', isError: false, finish: c.input.summary } : { content: `${c.input.path} `.repeat(3000), isError: false }; } };
  const events = [];
  const run = new WorkerRun(gateway, tools, { task: 't', difficulty: 'simple', onEvent: e => events.push(e), compact });
  const outcome = await run.run('지시: 파일을 모두 읽고 정리', new AbortController().signal);
  assert.deepEqual(outcome, { status: 'finished', summary: '끝' });
  return { events, sent };
}

test('a long Worker run stays small by clearing old tool results alone', async () => {
  const { events, sent } = await longRun({ summarizeAboveChars: 1_000_000 });
  assert.ok(events.some(e => e.type === 'compacted' && e.how === 'cleared'));
  assert.ok(!events.some(e => e.type === 'compacted' && e.how === 'summarized'));
  assert.ok(Math.max(...sent.map(s => s.chars)) < 90_000, 'never the whole history of ~130k');
});

test('a long Worker run that is still large is summarized, keeps its instruction, and goes on', async () => {
  const { events, sent } = await longRun({ summarizeAboveChars: 30_000 });
  const compactions = events.filter(e => e.type === 'compacted');
  const summarized = compactions.find(e => e.how === 'summarized');
  assert.ok(summarized && summarized.afterChars < summarized.beforeChars, 'summarized');
  assert.equal(summarized.model, 'summarizer');
  const workerCalls = sent.filter(s => !s.system.startsWith('You compact'));
  assert.ok(Math.max(...workerCalls.map(s => s.chars)) < 60_000, `every call stayed small: ${Math.max(...workerCalls.map(s => s.chars))}`);
  const after = workerCalls.at(-1);
  assert.match(after.first, /^\[Summary of the work so far[\s\S]*지시: 파일을 모두 읽고 정리[\s\S]*요약: 파일 12개를/);
  // The summarizer saw the conversation, not the Worker's own system prompt.
  assert.equal(sent.filter(s => s.system.startsWith('You compact')).length >= 1, true);
});

test('a failing summary does not stop the work', async () => {
  resetCooling();
  const usage = { inputTokens: 1, outputTokens: 1 };
  let step = 0;
  const gateway = { async send(target, request) {
    if (request.system.startsWith('You compact')) { const e = new Error('bad'); e.code = 'invalid_request'; throw e; }
    step++;
    const content = step < 8 ? [{ type: 'tool_call', id: `c${step}`, name: 'read_file', input: { path: `f${step}` } }] : [{ type: 'text', text: '완료' }];
    return { response: { provider: 'p', model: 'm', content, stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const tools = { specs: [], async run(c) { return { content: 'y'.repeat(9000), isError: false }; } };
  const run = new WorkerRun(gateway, tools, { task: 't', difficulty: 'simple', compact: { summarizeAboveChars: 20_000, clearAboveChars: 1_000_000 } });
  assert.deepEqual(await run.run('지시', new AbortController().signal), { status: 'finished', summary: '완료' });
});

test('very large recent results are kept only as far as the budget allows, the latest always', () => {
  const messages = [user('지시')];
  for (let i = 1; i <= 3; i++) messages.push(call(`c${i}`, 'read_file', { path: `f${i}` }), result(`c${i}`, 'z'.repeat(35_000)));
  assert.ok(clearOldResults(messages) > 0);
  const results = messages.flatMap(m => m.content.filter(b => b.type === 'tool_result'));
  assert.deepEqual(results.map(r => r.content.startsWith('[cleared')), [true, true, false]);
});
