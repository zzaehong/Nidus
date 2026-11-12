// Real-VM check of stage 2c: the workspace browser inside the VM, driven from the host.
// Usage: node scripts/vault-vm/workspace-browser-verify.mjs <vm-assets-dir> <evidence-dir>
// Network approvals are answered by a fixed test policy below, not by a person.
// The "user" here is this script sending input the way the app will.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppleOfflineBackend } from '../../dist/vault/apple-backend.js';
import { CacheDiskStore } from '../../dist/vault/cache-disk.js';
import { EgressProxy, EgressRules } from '../../dist/workspace/egress.js';
import { CDPClient } from '../../dist/workspace/cdp.js';
import { WorkspaceBrowser } from '../../dist/workspace/browser.js';

const [assets, out] = process.argv.slice(2);
if (!assets || !out) { console.error('usage: workspace-browser-verify.mjs <vm-assets-dir> <evidence-dir>'); process.exit(2); }
await mkdir(out, { recursive: true });

// Test pages on the Mac, reached from the VM as host.nidus:<port>.
const pages = {
  '/form': `<!doctype html><title>Form</title><form action="/search"><input name="q" placeholder="검색어"><button>찾기</button></form>
    <p id="echo">-</p><a href="/opened" target="_blank">새 탭 열기</a>
    <script>document.querySelector('input').addEventListener('input',e=>document.querySelector('#echo').textContent='입력: '+e.target.value)</script>`,
  '/opened': '<!doctype html><title>Opened</title><p>새 탭에서 열린 페이지</p>',
  '/anim': `<!doctype html><title>Anim</title><div id="n" style="font:48px sans-serif">0</div>
    <script>let i=0;(function f(){document.getElementById('n').textContent=++i;requestAnimationFrame(f)})()</script>`,
};
const mac = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/search') return res.end(`<!doctype html><title>Results</title><h1>결과: ${url.searchParams.get('q')?.replace(/[<&]/g, '')}</h1>`);
  if (url.pathname === '/set') { res.setHeader('set-cookie', 'nidus=kept; Max-Age=86400; Path=/'); return res.end('<title>Set</title>cookie set'); }
  if (url.pathname === '/echo') return res.end(`<title>Echo</title><p>cookie=[${(req.headers.cookie ?? '').replace(/[<&]/g, '')}]</p>`);
  res.end(pages[url.pathname] ?? '<title>Missing</title>');
});
mac.listen(0, '127.0.0.1'); await once(mac, 'listening');
const macPort = mac.address().port;
const macUrl = path => `http://host.nidus:${macPort}${path}`;

const allowed = new Set(['example.com']);
const asked = [], proxyEvents = [];
const proxy = new EgressProxy({
  rules: EgressRules.empty(),
  approve: async request => {
    asked.push(request.target === 'mac' ? `mac:${request.port}` : request.host);
    return (request.target === 'mac' ? request.port === macPort : allowed.has(request.host)) ? 'once' : 'deny';
  },
  onEvent: event => proxyEvents.push(`${event.outcome} ${event.host}:${event.port}`),
});

const evidence = { at: new Date().toISOString(), scope: 'real Apple Virtualization VM and guest Chromium; approvals by a fixed test policy; user input sent by this script', checks: [] };
const check = async (name, body) => {
  const started = Date.now(), askedBefore = asked.length;
  const entry = { name };
  try { Object.assign(entry, await body()); entry.pass ??= true; } catch (error) { entry.pass = false; entry.error = String(error?.message ?? error); }
  entry.ms = Date.now() - started;
  entry.asked = asked.slice(askedBefore);
  evidence.checks.push(entry);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${name} (${entry.ms} ms)${entry.pass ? '' : ' ' + JSON.stringify(entry)}`);
  return entry;
};
const expect = (condition, detail) => { if (!condition) throw new Error('expectation failed: ' + JSON.stringify(detail)); };

const vaultId = randomUUID(), environmentId = randomUUID();
const diskDir = await mkdtemp(join(await realpath(tmpdir()), 'nidus-browser-verify-'));
const disks = new CacheDiskStore(diskDir);
let backend, disk, browser;
const frames = [];

async function bootVM() {
  disk = await disks.acquire(vaultId, environmentId);
  backend = new AppleOfflineBackend(assets, proxy);
  await backend.start(disk);
}
async function stopVM() {
  await backend.stop();
  await disks.release(disk.diskId, backend.cacheClean);
}
async function openBrowser() {
  const link = await backend.openBrowser(900);
  browser = new WorkspaceBrowser(new CDPClient(link), { maxFps: 15 });
  browser.on('frame', frame => frames.push(frame));
  await browser.start();
}

try {
  await bootVM();
  await check('browser starts beside the shell, over the link', async () => {
    const started = Date.now();
    await openBrowser();
    return { startMs: Date.now() - started, tabs: browser.listTabs() };
  });

  await check('Mac page through host.nidus after port approval', async () => {
    const page = await browser.act({ op: 'navigate', url: macUrl('/form') });
    expect(page.title === 'Form' && asked.includes(`mac:${macPort}`), { title: page.title, asked });
    return { title: page.title, elements: page.elements.length };
  });

  await check('AI types and submits a form', async () => {
    let page = await browser.act({ op: 'observe' });
    const input = page.elements.find(e => e.tag === 'INPUT');
    page = await browser.act({ op: 'type', snapshotId: page.snapshotId, targetId: input.id, text: 'Mac mini' });
    expect(page.actionResult.status === 'verified' && /입력: Mac mini/.test(page.text), page.actionResult);
    page = await browser.act({ op: 'press', snapshotId: page.snapshotId, targetId: page.elements.find(e => e.tag === 'INPUT').id, key: 'Enter' });
    expect(page.title === 'Results' && /결과: Mac mini/.test(page.text), { title: page.title, text: page.text });
    return { url: page.url };
  });

  await check('a link to a new tab opens in front, closing it returns', async () => {
    let page = await browser.act({ op: 'navigate', url: macUrl('/form') });
    page = await browser.act({ op: 'click', snapshotId: page.snapshotId, targetId: page.elements.find(e => e.tag === 'A').id });
    if (page.title !== 'Opened') page = await browser.act({ op: 'wait', ms: 500 });
    expect(page.title === 'Opened' && page.tabs.length === 2, { title: page.title, tabs: page.tabs });
    const opened = page.tabs.find(t => t.active).id;
    page = await browser.act({ op: 'closeTab', tabId: opened });
    expect(page.title === 'Form' && page.tabs.length === 1, { title: page.title, tabs: page.tabs });
    return { tabs: 2 };
  });

  await check('public site through the Egress Proxy after approval', async () => {
    const page = await browser.act({ op: 'navigate', url: 'https://example.com/' });
    expect(page.title === 'Example Domain' && asked.includes('example.com'), { title: page.title });
    const frame = frames.at(-1);
    if (frame) await writeFile(join(out, 'example.jpg'), Buffer.from(frame.data, 'base64'));
    return { title: page.title };
  });

  await check('refused site is a page, not a crash', async () => {
    const page = await browser.act({ op: 'navigate', url: 'https://www.wikipedia.org/' });
    expect(asked.includes('www.wikipedia.org') && (page.navigationError || page.pageState === 'browser_access_blocked'), { navigationError: page.navigationError, state: page.pageState });
    return { navigationError: page.navigationError, pageState: page.pageState };
  });

  await check('a server inside the VM opens directly, without the proxy', async () => {
    const before = proxyEvents.length;
    const shell = backend.execute(randomUUID(), 'mkdir -p /tmp/site && echo "<title>VM site</title><h1>served inside the VM</h1>" > /tmp/site/index.html && cd /tmp/site && { python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 12; kill %1; }', 60, { profile: 'shell' });
    let page;
    for (let i = 0; i < 30; i++) {
      page = await browser.act({ op: 'navigate', url: 'http://localhost:8765/' });
      if (page.title === 'VM site') break;
      await new Promise(r => setTimeout(r, 500));
    }
    const viaProxy = proxyEvents.slice(before).filter(line => /:8765/.test(line));
    await shell.catch(() => {});
    expect(page.title === 'VM site' && viaProxy.length === 0, { title: page.title, viaProxy });
    return { title: page.title };
  });

  await check('screen streams while the page changes', async () => {
    await browser.act({ op: 'navigate', url: macUrl('/anim') });
    const start = frames.length, bytesStart = browser.stats.frameBytes, t0 = Date.now();
    await new Promise(r => setTimeout(r, 4000));
    const count = frames.length - start, seconds = (Date.now() - t0) / 1000;
    const fps = Math.round(count / seconds * 10) / 10;
    const kbPerFrame = Math.round((browser.stats.frameBytes - bytesStart) / Math.max(1, count) / 1024);
    await writeFile(join(out, 'anim.jpg'), Buffer.from(frames.at(-1).data, 'base64'));
    expect(fps >= 5, { fps });
    return { fps, kbPerFrame, cap: 15, size: `${frames.at(-1).width}x${frames.at(-1).height}` };
  });

  await check('user takes over: AI waits, user input reaches the page, AI continues after hand back', async () => {
    let page = await browser.act({ op: 'navigate', url: macUrl('/form') });
    const input = page.elements.find(e => e.tag === 'INPUT');
    let refused = false;
    try { await browser.input({ type: 'mouse', action: 'down', x: input.x, y: input.y }); } catch (error) { refused = /browser_not_user_control/.test(error.message); }
    browser.takeOver('test');
    let aiDone = false;
    const ai = browser.act({ op: 'observe' }).then(p => { aiDone = true; return p; });
    for (const action of ['move', 'down', 'up']) await browser.input({ type: 'mouse', action, x: input.x, y: input.y, button: 'left', clickCount: 1 });
    for (const ch of 'abc') {
      await browser.input({ type: 'key', action: 'down', key: ch, code: 'Key' + ch.toUpperCase(), text: ch });
      await browser.input({ type: 'key', action: 'up', key: ch, code: 'Key' + ch.toUpperCase() });
    }
    await browser.input({ type: 'text', text: ' 한글' });
    await new Promise(r => setTimeout(r, 800));
    const waited = !aiDone;
    browser.handBack();
    page = await ai;
    const value = page.elements.find(e => e.tag === 'INPUT')?.value;
    await writeFile(join(out, 'user-input.jpg'), Buffer.from(frames.at(-1).data, 'base64'));
    expect(refused && waited && value === 'abc 한글', { refused, waited, value });
    return { value };
  });

  await check('profile survives a browser restart', async () => {
    await browser.act({ op: 'navigate', url: macUrl('/set') });
    await browser.close();
    await backend.closeBrowser();
    await openBrowser();
    const page = await browser.act({ op: 'navigate', url: macUrl('/echo') });
    expect(/cookie=\[nidus=kept\]/.test(page.text), page.text);
    return { text: page.text };
  });

  await check('profile survives a VM restart on the same disk', async () => {
    await browser.close();
    await stopVM();
    await bootVM();
    await openBrowser();
    const page = await browser.act({ op: 'navigate', url: macUrl('/echo') });
    expect(/cookie=\[nidus=kept\]/.test(page.text), page.text);
    return { text: page.text };
  });

  evidence.frames = { total: browser.stats.frames };
} catch (error) {
  evidence.fatal = String(error?.message ?? error);
  console.log('FATAL', evidence.fatal);
} finally {
  try { await browser?.close(); await backend?.closeBrowser(); evidence.browserCleanup = 'CONFIRMED'; } catch (error) { evidence.browserCleanup = String(error?.message ?? error); }
  try { await stopVM(); evidence.stopped = 'STOP_CONFIRMED'; } catch (error) { evidence.stopped = String(error?.code ?? error?.message ?? error); }
  await proxy.close(); mac.close();
  await rm(diskDir, { recursive: true, force: true });
}
evidence.asked = asked;
evidence.pass = !evidence.fatal && evidence.checks.length > 0 && evidence.checks.every(c => c.pass) && evidence.stopped === 'STOP_CONFIRMED';
await writeFile(join(out, 'browser-vm.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(evidence.pass ? 'ALL PASS' : 'NOT ALL PASS', '| stop:', evidence.stopped);
process.exit(evidence.pass ? 0 : 1);
