import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { CDPClient } from '../dist/workspace/cdp.js';
import { WorkspaceBrowser, allowedUrl } from '../dist/workspace/browser.js';

/** Two connected in-memory streams. */
function pair() {
  let a, b;
  a = new Duplex({ read() {}, write(chunk, _e, cb) { b.push(chunk); cb(); }, final(cb) { b.push(null); cb(); } });
  b = new Duplex({ read() {}, write(chunk, _e, cb) { a.push(chunk); cb(); }, final(cb) { a.push(null); cb(); } });
  return [a, b];
}

/** A stand-in for Chromium's DevTools pipe: answers calls, records them, can send events. */
function fakeChromium(link) {
  const calls = [];
  const page = { url: 'https://example.com/', title: 'Example', text: 'Hello', challengeVisible: false };
  // One button on the page; tests move, replace or cover it.
  const element = { tag: 'BUTTON', type: 'submit', role: 'button', name: '찾기', href: '', target: '', formAction: '', frameUrl: 'https://example.com/', editable: false, disabled: false, value: '', x: 100, y: 50, visible: true, hit: true };
  const fake = { calls, page, element, revision: 1, elements: [], targets: [{ targetId: 'T1', type: 'page', url: 'about:blank', title: '' }], nextSession: 1 };
  let buffer = '';
  const send = message => link.write(JSON.stringify(message) + '\0');
  fake.event = (method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  link.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      calls.push(m);
      const reply = result => send({ id: m.id, result });
      switch (m.method) {
        case 'Target.getTargets': reply({ targetInfos: fake.targets }); break;
        case 'Target.attachToTarget': reply({ sessionId: 'S' + fake.nextSession++ }); break;
        case 'Target.createTarget': reply({ targetId: 'T' + (fake.targets.length + 1) }); break;
        case 'Browser.getVersion': reply({ userAgent: 'Mozilla/5.0 HeadlessChrome/140.0' }); break;
        case 'Page.getFrameTree': reply({ frameTree: { frame: { id: 'F', loaderId: 'L' } } }); break;
        case 'Page.createIsolatedWorld': reply({ executionContextId: 1 }); break;
        case 'Runtime.evaluate': reply({ result: { objectId: 'reader' } }); break;
        case 'Runtime.getProperties': reply({ result: fake.elements.map((_, i) => ({ name: String(i), value: { objectId: 'el' + i } })) }); break;
        case 'Page.navigate': fake.page.url = m.params.url; reply({ frameId: 'F' }); break;
        // Like Chromium: answer, then exit, which ends the link.
        case 'Browser.close': reply({}); setImmediate(() => link.end()); break;
        case 'Runtime.callFunctionOn': {
          const method = m.params.functionDeclaration.match(/this\["(\w+)"\]/)[1];
          if (method === 'state') reply({ result: { value: { revision: fake.revision, url: fake.page.url, ready: true, busy: false } } });
          else if (method === 'metadata') reply({ result: { value: { ...fake.element } } });
          else if (method === 'fingerprint') reply({ result: { value: JSON.stringify(fake.element) } });
          else if (method === 'scan') reply({ result: { objectId: 'list' } });
          else if (method === 'page') reply({ result: { value: { ...fake.page, frames: [], language: 'ko-KR', languages: [] } } });
          else reply({ result: { value: null } });
          break;
        }
        default: reply({});
      }
    }
  });
  return fake;
}

async function setup(options) {
  const [host, guest] = pair();
  const fake = fakeChromium(guest);
  const browser = new WorkspaceBrowser(new CDPClient(host, 2000), { settleMs: 2000, ...options });
  await browser.start();
  return { browser, fake };
}

const until = async (check, ms = 2000) => {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};

test('starts on the existing tab with a fixed viewport, a real user agent and the screencast', async () => {
  const { browser, fake } = await setup();
  const methods = fake.calls.map(c => c.method);
  assert.ok(methods.includes('Target.attachToTarget'));
  assert.equal(fake.calls.find(c => c.method === 'Emulation.setDeviceMetricsOverride').params.width, 1280);
  assert.equal(fake.calls.find(c => c.method === 'Network.setUserAgentOverride').params.userAgent, 'Mozilla/5.0 Chrome/140.0');
  const cast = fake.calls.find(c => c.method === 'Page.startScreencast');
  assert.equal(cast.sessionId, 'S1');
  assert.equal(cast.params.format, 'jpeg');
  assert.deepEqual(browser.listTabs(), [{ id: 'T1', url: 'about:blank', title: '', active: true }]);
  await browser.close();
});

test('screencast frames are emitted and acknowledged no faster than the frame cap', async () => {
  const { browser, fake } = await setup({ maxFps: 10 });
  const frames = [];
  browser.on('frame', frame => frames.push(frame));
  const started = Date.now();
  for (let i = 0; i < 3; i++) fake.event('Page.screencastFrame', { data: Buffer.from('jpeg' + i).toString('base64'), sessionId: i, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, 'S1');
  await until(() => fake.calls.filter(c => c.method === 'Page.screencastFrameAck').length === 3);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].tabId, 'T1');
  assert.equal(frames[0].width, 1280);
  assert.ok(Date.now() - started >= 180, 'three frames at 10 fps take at least two intervals');
  // Frames from a tab that is not in front are acknowledged but not shown.
  fake.event('Page.screencastFrame', { data: 'eA==', sessionId: 9 }, 'S-other');
  await until(() => fake.calls.filter(c => c.method === 'Page.screencastFrameAck').length === 4);
  assert.equal(frames.length, 3);
  await browser.close();
});

test('user input is refused while the AI has control and passed through after taking over', async () => {
  const { browser, fake } = await setup();
  await assert.rejects(browser.input({ type: 'mouse', action: 'down', x: 10, y: 10 }), /browser_not_user_control/);
  const changes = [];
  browser.on('control', change => changes.push(change));
  browser.takeOver();
  assert.equal(browser.control, 'user');
  await browser.input({ type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 });
  const click = fake.calls.findLast(c => c.method === 'Input.dispatchMouseEvent');
  assert.deepEqual({ ...click.params, sessionId: click.sessionId }, { type: 'mousePressed', x: 10, y: 20, modifiers: 0, button: 'left', clickCount: 1, sessionId: 'S1' });
  await browser.input({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a' });
  assert.equal(fake.calls.findLast(c => c.method === 'Input.dispatchKeyEvent').params.type, 'keyDown');
  // Ctrl+A is a shortcut: no character typed.
  await browser.input({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 2 });
  const shortcut = fake.calls.findLast(c => c.method === 'Input.dispatchKeyEvent').params;
  assert.equal(shortcut.type, 'rawKeyDown');
  assert.equal(shortcut.text, undefined);
  await assert.rejects(browser.input({ type: 'mouse', action: 'down', x: 5000, y: 10 }), /browser_input_invalid/);
  await assert.rejects(browser.input({ type: 'navigate', url: 'chrome://settings' }), /browser_url_invalid/);
  browser.handBack();
  assert.deepEqual(changes.map(c => c.control), ['user', 'ai']);
  await browser.close();
});

test('AI actions wait while the user has control and continue when it is handed back', async () => {
  const { browser } = await setup();
  browser.takeOver();
  let done = false;
  const action = browser.act({ op: 'navigate', url: 'https://example.com/next' }).then(page => { done = true; return page; });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(done, false, 'waits for the user');
  browser.handBack();
  const page = await action;
  assert.equal(page.url, 'https://example.com/next');
  assert.equal(page.tabs[0].active, true);
  assert.equal(page.untrusted, true);
  await browser.close();
});

test('a waiting AI action can be cancelled', async () => {
  const { browser } = await setup();
  browser.takeOver();
  const controller = new AbortController();
  const action = browser.act({ op: 'observe' }, controller.signal);
  controller.abort();
  await assert.rejects(action, /browser_action_cancelled/);
  await browser.close();
});

test('a CAPTCHA hands control to the user instead of failing, then the AI continues', async () => {
  const { browser, fake } = await setup();
  fake.page.challengeVisible = true;
  const changes = [];
  browser.on('control', change => changes.push(change));
  const action = browser.act({ op: 'observe' });
  await until(() => browser.control === 'user');
  assert.deepEqual(changes[0], { control: 'user', reason: 'captcha', by: 'page' });
  fake.page.challengeVisible = false;
  browser.handBack();
  const page = await action;
  assert.equal(page.pageState, 'page');
  await browser.close();
});

test('a CAPTCHA still there after the hand back is returned to the AI, not asked again', async () => {
  const { browser, fake } = await setup();
  fake.page.challengeVisible = true;
  const changes = [];
  browser.on('control', change => changes.push(change.control));
  const action = browser.act({ op: 'observe' });
  await until(() => browser.control === 'user');
  browser.handBack();
  const page = await action;
  assert.equal(page.pageState, 'captcha_required');
  assert.deepEqual(changes, ['user', 'ai']);
  await browser.close();
});

test('the AI can ask the user for help and gets the page back after', async () => {
  const { browser } = await setup();
  const changes = [];
  browser.on('control', change => changes.push(change));
  const action = browser.act({ op: 'askUser', reason: '로그인이 필요합니다' });
  await until(() => browser.control === 'user');
  assert.deepEqual(changes[0], { control: 'user', reason: '로그인이 필요합니다', by: 'ai' });
  browser.handBack();
  assert.equal((await action).url, 'https://example.com/');
  await browser.close();
});

test('a tab opened by the page in front comes to the front; closing it goes back', async () => {
  const { browser, fake } = await setup();
  fake.event('Target.targetCreated', { targetInfo: { targetId: 'T2', type: 'page', url: 'https://example.com/new', title: 'New', openerId: 'T1' } });
  await until(() => browser.activeTab === 'T2');
  assert.equal(fake.calls.findLast(c => c.method === 'Page.startScreencast').sessionId, 'S2');
  fake.event('Target.targetCreated', { targetInfo: { targetId: 'T3', type: 'page', url: 'https://example.com/bg', title: 'Background' } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(browser.activeTab, 'T2', 'a tab not opened by the front page stays in the back');
  fake.event('Target.targetDestroyed', { targetId: 'T2' });
  await until(() => browser.activeTab === 'T3');
  assert.deepEqual(browser.listTabs().map(t => t.id), ['T1', 'T3']);
  await browser.close();
});

test('the link closing ends the browser and wakes waiting actions', async () => {
  const { browser } = await setup();
  browser.takeOver();
  const action = browser.act({ op: 'observe' });
  let closed;
  browser.on('closed', reason => { closed = reason; });
  await browser.close();
  await assert.rejects(action, /browser_closed/);
  assert.equal(closed, 'link ended', 'Chromium exited by itself after Browser.close');
});

test('CDP client: malformed or oversized input from the VM closes the link', async () => {
  const [host, guest] = pair();
  const client = new CDPClient(host, 500);
  const call = client.call('Page.enable');
  guest.write('not json\0');
  await assert.rejects(call, /browser_closed/);
  assert.equal(client.closed, true);

  const [host2, guest2] = pair();
  const client2 = new CDPClient(host2, 500);
  guest2.write(Buffer.alloc(17 * 1024 * 1024, 0x61));
  await until(() => client2.closed);

  const [host3] = pair();
  await assert.rejects(new CDPClient(host3, 50).call('Page.enable'), /browser_cdp_timeout/);
});

test('URLs: web, VM files and blank only', () => {
  assert.equal(allowedUrl('https://example.com'), 'https://example.com/');
  assert.equal(allowedUrl('http://localhost:3000/a'), 'http://localhost:3000/a');
  assert.equal(allowedUrl('about:blank'), 'about:blank');
  assert.equal(allowedUrl('file:///workspace/index.html'), 'file:///workspace/index.html');
  for (const bad of ['chrome://settings', 'javascript:alert(1)', 'devtools://x', 'not a url', 42]) assert.throws(() => allowedUrl(bad), /browser_url_invalid/);
});

test('clicks work on a page that keeps changing, follow an element that moved, and refuse a replaced or covered one', async () => {
  const { browser, fake } = await setup();
  fake.elements = [fake.element];
  let page = await browser.act({ op: 'observe' });
  assert.equal(page.elements[0].name, '찾기');
  // Ads and tickers change the page between observing and clicking.
  fake.revision += 7;
  fake.element.x = 140; fake.element.y = 90;
  page = await browser.act({ op: 'click', snapshotId: page.snapshotId, targetId: '1' });
  const press = fake.calls.findLast(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.deepEqual([press.params.x, press.params.y], [140, 90], 'clicked where the button is now');

  fake.element.name = '다른 버튼';
  await assert.rejects(browser.act({ op: 'click', snapshotId: page.snapshotId, targetId: '1' }), /browser_element_gone/);
  page = await browser.act({ op: 'observe' });
  fake.element.hit = false;
  await assert.rejects(browser.act({ op: 'click', snapshotId: page.snapshotId, targetId: '1' }), /browser_element_hidden/);
  // A new document makes the whole observation stale.
  page = await browser.act({ op: 'observe' });
  await browser.act({ op: 'navigate', url: 'https://example.com/other' }).catch(() => {});
  await assert.rejects(browser.act({ op: 'click', snapshotId: page.snapshotId, targetId: '1' }), /browser_stale_observation/);
  await browser.close();
});
