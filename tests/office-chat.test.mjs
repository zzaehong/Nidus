import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MainChat, ChatStore, parseChat, chatSystem } from '../dist/office/chat.js';
import { resetCooling } from '../dist/workspace/worker.js';

const usage = { inputTokens: 1, outputTokens: 1 };
async function chat(t, answers, extra = {}) {
  resetCooling();
  const dir = await mkdtemp(join(tmpdir(), 'nidus-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [], started = [], changes = [];
  const gateway = { async send(target, request) {
    requests.push({ target, request: structuredClone(request) });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { response: { provider: 'p', model: 'main-model', content: [{ type: 'text', text: next }], stopReason: 'end', usage }, costUSD: null, warnings: [] };
  } };
  const store = new ChatStore(join(dir, 'main-chat.json'));
  const c = new MainChat({ gateway, store, context: async () => 'No project is open.', blocked: () => null, start: async i => { started.push(i); }, onChange: m => changes.push(m.length), retryWaits: [], ...extra });
  return { c, requests, started, changes, store };
}
const signal = () => new AbortController().signal;

test('Main answers a question itself, and the conversation is kept', async t => {
  const { c, requests, started, store, changes } = await chat(t, ['{"reply": "팀은 세 개입니다.", "project": null}', '그냥 글로 한 답']);
  const answer = await c.send('팀이 몇 개야?', signal());
  assert.deepEqual([answer.role, answer.text, answer.project, answer.model], ['main', '팀은 세 개입니다.', undefined, 'main-model']);
  assert.deepEqual(started, []);
  assert.equal(requests[0].target.role, 'main');
  assert.equal(requests[0].request.system, chatSystem());
  assert.match(requests[0].request.messages[0].content[0].text, /^\[Context now, not from the user\]\nNo project is open\.\n\n\[The user says\]\n팀이 몇 개야\?$/);
  const second = await c.send('고마워', signal());
  assert.equal(second.text, '그냥 글로 한 답', 'an answer that is not JSON is what Main says');
  const sent = requests[1].request.messages;
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent[0].content[0].text, '팀이 몇 개야?', 'the context goes with the latest message only');
  assert.equal(sent[1].content[0].text, '{"reply":"팀은 세 개입니다.","project":null,"library":null}');
  assert.deepEqual((await store.load()).map(m => m.role), ['user', 'main', 'user', 'main']);
  assert.deepEqual(changes, [1, 2, 3, 4]);
  await assert.rejects(c.send('  ', signal()), /비어/);
});

test('when the user wants work done, Main starts a project; not while one is open', async t => {
  const reply = '{"reply": "계획을 세우겠습니다.", "project": "맥미니 가격을 세 곳에서 조사해 표로 정리"}';
  const { c, started } = await chat(t, [reply]);
  const answer = await c.send('맥미니 가격 조사해 줘', signal());
  assert.deepEqual(started, ['맥미니 가격을 세 곳에서 조사해 표로 정리']);
  assert.equal(answer.project, '맥미니 가격을 세 곳에서 조사해 표로 정리');
  const blocked = await chat(t, [reply], { blocked: () => '열려 있는 프로젝트가 있습니다' });
  const refused = await blocked.c.send('또 조사해 줘', signal());
  assert.deepEqual(blocked.started, []);
  assert.equal(refused.project, undefined);
  assert.match(refused.text, /새 프로젝트를 시작하지 못했습니다: 열려 있는 프로젝트가 있습니다/);
});

test('a failed call is shown as an error and left out of what Main is sent next', async t => {
  const failure = Object.assign(new Error('Provider request failed'), { code: 'invalid_request' });
  const { c, requests } = await chat(t, [failure, '{"reply": "네", "project": null}']);
  const first = await c.send('안녕', signal());
  assert.equal(first.isError, true);
  assert.match(first.text, /답하지 못했습니다: Provider request failed/);
  await c.send('다시', signal());
  assert.deepEqual(requests[1].request.messages.map(m => m.role), ['user', 'user']);
  await c.clear();
  assert.deepEqual(c.messages, []);
});

test('parseChat reads the JSON, a fenced one too, and falls back to the text', () => {
  assert.deepEqual(parseChat('```json\n{"reply": "a", "project": " b "}\n```'), { reply: 'a', project: 'b', library: null });
  assert.deepEqual(parseChat('{"reply": "", "project": "일"}'), { reply: '계획을 세우겠습니다.', project: '일', library: null });
  assert.deepEqual(parseChat('{"reply": "a", "project": ""}'), { reply: 'a', project: null, library: null });
  assert.deepEqual(parseChat('안녕하세요'), { reply: '안녕하세요', project: null, library: null });
  assert.deepEqual(parseChat('{"reply": "", "project": null, "library": "tidy"}'), { reply: 'Library를 정리하겠습니다.', project: null, library: 'tidy' });
  assert.equal(parseChat('{"reply": "a", "library": "connect"}').library, 'connect');
  assert.equal(parseChat('{"reply": "a", "library": "delete"}').library, null);
  assert.equal(parseChat('{"reply": "a", "project": "일", "library": "tidy"}').library, null, 'a project and a tidy do not start together');
  assert.match(chatSystem(), /^You are Main/);
});

test('asked to tidy the Library, Main starts a Dream Sequence after its answer; the report is one turn with the answer', async t => {
  const order = [];
  const { c, requests } = await chat(t, ['{"reply": "정리를 시작합니다.", "project": null, "library": "tidy"}', '{"reply": "네", "project": null}'], { tidy: () => { order.push(`tidy after ${c.messages.length}`); } });
  await c.send('Library 정리해 줘', signal());
  assert.deepEqual(order, ['tidy after 2'], 'the answer is in the conversation before the tidy starts');
  await c.note('합침 1건');
  await c.send('고마워', signal());
  const sent = requests[1].request.messages;
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(JSON.parse(sent[1].content[0].text).reply, '정리를 시작합니다.\n\n합침 1건');
  const refused = await chat(t, ['{"reply": "정리합니다.", "library": "tidy"}'], { tidy: () => { throw new Error('작업이 진행 중입니다'); } });
  await refused.c.send('정리', signal());
  assert.match(refused.c.messages.at(-1).text, /Library 정리를 시작하지 못했습니다: 작업이 진행 중입니다/);
  assert.equal(refused.c.messages.at(-1).isError, true);
  let connected = 0;
  const linking = await chat(t, ['{"reply": "노트를 살펴볼게요.", "library": "connect"}'], { connect: () => { connected++; } });
  await linking.c.send('내 노트들 서로 연결해 줘', signal());
  assert.equal(connected, 1);
});
