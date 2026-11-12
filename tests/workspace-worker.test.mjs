import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRun } from '../dist/workspace/worker.js';
import { WorkerTools, describePage } from '../dist/workspace/tools.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null };
/** A gateway that replays scripted model turns and records what it was asked. */
function gateway(turns) {
  const requests = [];
  return {
    requests,
    async send(target, request, options) {
      requests.push({ target, request: structuredClone(request), signal: options?.signal });
      const next = turns.shift();
      if (!next) throw new Error('no more turns');
      if (next instanceof Error) throw next;
      return { response: { provider: 'test', model: 'm', content: next.content, stopReason: next.stopReason ?? (next.content.some(b => b.type === 'tool_call') ? 'tool_call' : 'end'), usage }, costUSD: '0.001', warnings: [] };
    },
  };
}
const call = (id, name, input, extra = {}) => ({ type: 'tool_call', id, name, input, ...extra });

function runtime() {
  const commands = [];
  return {
    commands,
    shell: async (command) => { commands.push(command); return { exitCode: 0, stdout: 'ok\n', stderr: '', reason: 'completed' }; },
    browser: async () => { throw new Error('no browser in this test'); },
  };
}

test('a worker runs tools until finish and reports each step', async () => {
  const g = gateway([
    { content: [{ type: 'text', text: '파일을 만들겠습니다' }, call('c1', 'write_file', { path: 'a.txt', content: '안녕' })] },
    { content: [call('c2', 'shell', { command: 'cat a.txt' })] },
    { content: [call('c3', 'finish', { summary: 'a.txt를 만들었습니다' })] },
  ]);
  const rt = runtime(), events = [];
  const run = new WorkerRun(g, new WorkerTools(rt), { task: 't-1', difficulty: 'simple', onEvent: e => events.push(e) });
  const outcome = await run.run('a.txt를 만들어 줘', new AbortController().signal);
  assert.deepEqual(outcome, { status: 'finished', summary: 'a.txt를 만들었습니다' });
  assert.deepEqual(g.requests[0].target, { role: 'worker', difficulty: 'simple', taskId: 't-1' });
  assert.ok(g.requests[0].request.tools.some(t => t.name === 'browser_click'));
  assert.match(g.requests[0].request.system, /nidus\/t-1/);
  // The file content travels base64-encoded, so quotes and Hangul cannot break the command.
  assert.ok(rt.commands[0].includes(Buffer.from('안녕').toString('base64')));
  assert.deepEqual(events.map(e => e.type), ['instruction', 'model', 'tool_call', 'tool_result', 'model', 'tool_call', 'tool_result', 'model', 'tool_call', 'tool_result', 'finished']);
  // Each tool result goes back to the model with the call id.
  assert.deepEqual(g.requests[1].request.messages.at(-1).content[0], { type: 'tool_result', callId: 'c1', content: 'exit code 0\n[stdout]\nok\n', isError: false });
});

test('bad tool calls are answered with errors; a text-only answer ends the instruction; follow-ups continue the conversation', async () => {
  const g = gateway([
    { content: [call('c1', 'nope', {}, { inputError: 'unknown tool' }), call('c2', 'write_file', { path: 'x', content: 'y'.repeat(40_000) })] },
    { content: [{ type: 'text', text: '할 수 없습니다' }] },
    { content: [call('c3', 'finish', { summary: '이어서 끝냄' })] },
  ]);
  const run = new WorkerRun(g, new WorkerTools(runtime()), { task: 't-2', difficulty: 'normal' });
  assert.deepEqual(await run.run('first', new AbortController().signal), { status: 'finished', summary: '할 수 없습니다' });
  const results = g.requests[1].request.messages.at(-1).content;
  assert.equal(results[0].isError, true);
  assert.match(results[0].content, /unknown tool/);
  assert.match(results[1].content, /append=true/);
  assert.equal((await run.run('second', new AbortController().signal)).status, 'finished');
  assert.equal(g.requests[2].request.messages.filter(m => m.role === 'user' && m.content[0].type === 'text').length, 2, 'the follow-up keeps the earlier conversation');
});

test('limits and the user stop the worker; gateway errors fail it', async () => {
  const looping = gateway(Array.from({ length: 5 }, (_, i) => ({ content: [call(`c${i}`, 'shell', { command: 'true' })] })));
  const limited = new WorkerRun(looping, new WorkerTools(runtime()), { task: 't', difficulty: 'simple', limits: { modelCalls: 3 } });
  assert.deepEqual(await limited.run('loop', new AbortController().signal), { status: 'stopped', reason: 'limit', detail: '모델 호출 3회 한도' });

  const controller = new AbortController();
  const slow = { shell: async () => { controller.abort(); return { exitCode: 0, stdout: '', stderr: '', reason: 'cancelled' }; }, browser: async () => { throw new Error('x'); } };
  const stopped = new WorkerRun(gateway([{ content: [call('c1', 'shell', { command: 'sleep 100' }), call('c2', 'shell', { command: 'true' })] }]), new WorkerTools(slow), { task: 't', difficulty: 'simple' });
  assert.equal((await stopped.run('x', controller.signal)).reason, 'user');

  const broken = new WorkerRun(gateway([new Error('provider down')]), new WorkerTools(runtime()), { task: 't', difficulty: 'simple' });
  assert.deepEqual(await broken.run('x', new AbortController().signal), { status: 'failed', error: 'provider down' });
});

test('transient provider errors are retried; other errors are not', async () => {
  const flaky = Object.assign(new Error('Provider request failed (HTTP 500, provider_error).'), { code: 'provider_error' });
  const events = [];
  const g = gateway([flaky, { content: [call('c1', 'finish', { summary: 'ok' })] }]);
  const run = new WorkerRun(g, new WorkerTools(runtime()), { task: 't', difficulty: 'simple', retryWaits: [1, 1], onEvent: e => events.push(e) });
  assert.equal((await run.run('x', new AbortController().signal)).status, 'finished');
  assert.deepEqual(events.filter(e => e.type === 'retry').map(e => e.attempt), [1]);
  const denied = Object.assign(new Error('bad key'), { code: 'authentication' });
  const once = new WorkerRun(gateway([denied, { content: [] }]), new WorkerTools(runtime()), { task: 't', difficulty: 'simple', retryWaits: [1] });
  assert.equal((await once.run('x', new AbortController().signal)).status, 'failed');
  const always = new WorkerRun(gateway([flaky, flaky, flaky]), new WorkerTools(runtime()), { task: 't', difficulty: 'simple', retryWaits: [1, 1] });
  assert.equal((await always.run('x', new AbortController().signal)).status, 'failed', 'gives up after the retries');
});

test('output cut off by the token limit asks the model to continue', async () => {
  const g = gateway([{ content: [{ type: 'text', text: '길게…' }], stopReason: 'max_tokens' }, { content: [call('c1', 'finish', { summary: 'done' })] }]);
  const run = new WorkerRun(g, new WorkerTools(runtime()), { task: 't', difficulty: 'simple' });
  assert.equal((await run.run('x', new AbortController().signal)).status, 'finished');
  assert.match(g.requests[1].request.messages.at(-1).content[0].text, /cut off/);
});

test('browser tools use the latest observation; pages are shown as untrusted data', async () => {
  const actions = [];
  const page = { url: 'https://a.example/', title: 'A', text: '본문', textOffset: 0, textLength: 2, nextOffset: null, pageState: 'page', snapshotId: 'S1', tabs: [{ id: 'T1', url: 'https://a.example/', title: 'A', active: true }],
    elements: [{ id: '1', tag: 'A', role: 'link', name: '다음', href: 'https://a.example/next', value: '', checked: null }, { id: '2', tag: 'INPUT', role: 'textbox', name: '검색', value: 'abc', checked: null }] };
  const fakeBrowser = { act: async action => { actions.push(action); return page; } };
  const tools = new WorkerTools({ shell: async () => ({}), browser: async () => fakeBrowser });
  const early = await tools.run(call('c0', 'browser_click', { element: 1 }));
  assert.equal(early.isError, true);
  assert.match(early.content, /browser_observe first/);
  const seen = await tools.run(call('c1', 'web_search', { query: '맥미니 가격' }));
  assert.match(actions[0].url, /search\.naver\.com/, 'Korean queries go to Naver');
  assert.match(seen.content, /untrusted external data/);
  assert.match(seen.content, /#1 link "다음" -> https:\/\/a\.example\/next/);
  assert.match(seen.content, /#2 textbox "검색" = "abc"/);
  await tools.run(call('c2', 'browser_click', { element: 1 }));
  assert.deepEqual(actions[1], { op: 'click', snapshotId: 'S1', targetId: '1' });
  await tools.run(call('c3', 'web_search', { query: 'mac mini price' }));
  assert.match(actions[2].url, /bing\.com/);
  assert.equal(describePage({ ...page, elements: [], pageState: 'captcha_required' }).includes('State: captcha_required'), true);
});

test('a page that timed out while an approval was pending is opened again after the answer', async () => {
  const actions = [];
  const failed = { url: 'https://slow.example/', title: '', text: '', textOffset: 0, textLength: 0, nextOffset: null, pageState: 'browser_access_blocked', navigationError: 'net::ERR_TIMED_OUT', snapshotId: 'S0', elements: [] };
  const loaded = { ...failed, pageState: 'page', navigationError: undefined, title: 'Slow', snapshotId: 'S1' };
  const browser = { act: async action => { actions.push(action); return actions.length === 1 ? failed : loaded; } };
  let waited = 0;
  const tools = new WorkerTools({ shell: async () => ({}), browser: async () => browser, waitForApprovals: async () => { waited++; return true; } });
  const result = await tools.run(call('c1', 'browser_open', { url: 'https://slow.example/' }));
  assert.equal(waited, 1);
  assert.equal(actions.length, 2, 'opened again after the approval');
  assert.match(result.content, /Title: Slow/);
  // Without a pending approval the failure is returned as it is.
  const once = new WorkerTools({ shell: async () => ({}), browser: async () => ({ act: async () => failed }), waitForApprovals: async () => false });
  assert.match((await once.run(call('c2', 'browser_open', { url: 'https://slow.example/' }))).content, /ERR_TIMED_OUT/);
});

test('background services start in /workspace with a log, and stop by name', async () => {
  const started = [], commands = [];
  const tools = new WorkerTools({
    shell: async command => { commands.push(command); return { exitCode: 0, stdout: 'listening on 3000\n', stderr: '', reason: 'completed' }; },
    browser: async () => { throw new Error('x'); },
    startService: async (name, command) => { started.push({ name, command }); },
    stopService: async name => name === 'web',
    services: () => ['web'],
  });
  const result = await tools.run(call('c1', 'start_service', { name: 'web', command: 'npm run dev' }));
  assert.equal(result.isError, false);
  assert.match(result.content, /listening on 3000/);
  assert.equal(started[0].name, 'web');
  assert.ok(started[0].command.includes(Buffer.from('npm run dev').toString('base64')));
  assert.ok(started[0].command.includes('/workspace/.git/nidus-logs/web.log'));
  assert.equal((await tools.run(call('c2', 'stop_service', { name: 'web' }))).isError, false);
  assert.equal((await tools.run(call('c3', 'stop_service', { name: 'db' }))).isError, true);
  assert.match((await tools.run(call('c4', 'start_service', { name: 'Bad Name', command: 'x' }))).content, /service name/);
  assert.match((await tools.run(call('c5', 'shell', { command: 'npm ci', timeout_seconds: 5000 }))).content, /exit code 0/);
});
