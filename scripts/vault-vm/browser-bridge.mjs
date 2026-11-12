// Resident workspace browser (guest side). Starts Chromium and joins its DevTools pipe to the
// host over the egress link's "browser" service (127.0.0.1:3129, see egress-relay.py). The host
// drives the browser and receives its screen (src/workspace/browser.ts); nothing is decided here.
//
// Web traffic goes through the Egress Proxy (127.0.0.1:3128). Chromium sends loopback
// addresses direct, so pages served inside the VM open without the proxy.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';

const profile = '/home/profile';
mkdirSync(profile, { recursive: true });
// A profile left by a killed browser keeps its lock files; they would stop the next start.
for (const name of readdirSync(profile)) if (name.startsWith('Singleton')) rmSync(`${profile}/${name}`, { force: true });

const chromium = spawn('/usr/lib/chromium/chromium', [
  '--headless', '--lang=ko-KR', '--disable-setuid-sandbox', '--disable-gpu', '--in-process-gpu',
  '--disable-software-rasterizer', '--disable-dev-shm-usage', '--disable-extensions', '--disable-sync',
  '--no-first-run', '--no-default-browser-check', '--disable-quic', '--disable-background-networking',
  // Chromium's own background traffic (updates, hints, reporting) would each ask the user for
  // network approval for a site they never opened. Only pages make requests.
  '--disable-component-update', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
  '--disable-default-apps', '--no-pings', '--disable-breakpad', '--metrics-recording-only', '--safebrowsing-disable-auto-update',
  '--disable-features=OptimizationHints,OptimizationHintsFetching,OptimizationGuideModelDownloading,OptimizationTargetPrediction,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,NetworkTimeServiceQuerying',
  '--variations-server-url=data:,',
  // The component updater ignores --disable-component-update for some components; its update
  // server is pointed at a closed port inside the VM, so checks fail without leaving the VM.
  '--component-updater=url-source=http://127.0.0.1:9/',
  // Last guard for downloads that ignore the policy (spellcheck dictionaries are fetched on the
  // first keystroke even with spellcheck off). Bypassing the proxy means a direct connection,
  // which fails inside the VM: there is no network device. Ordinary pages do not use these hosts.
  '--proxy-bypass-list=redirector.gvt1.com;update.googleapis.com;clients2.google.com;clients2.googleusercontent.com;optimizationguide-pa.googleapis.com;safebrowsing.googleapis.com;content-autofill.googleapis.com',
  '--proxy-server=http://127.0.0.1:3128', '--window-size=1280,800', `--user-data-dir=${profile}`,
  '--remote-debugging-pipe', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/home', LANG: 'C.UTF-8', TMPDIR: '/tmp' } });

// Chromium writes its profile (cookies) on a clean exit; give it the chance before killing it.
let quitting = false;
function quit(code) {
  if (quitting) return;
  quitting = true;
  if (chromium.exitCode !== null || chromium.signalCode !== null) process.exit(code);
  chromium.once('exit', () => process.exit(code));
  chromium.kill('SIGTERM');
  setTimeout(() => { chromium.kill('SIGKILL'); process.exit(code); }, 10000).unref();
}
chromium.on('exit', () => quit(3));
chromium.on('error', () => quit(4));

function open(attempt = 0) {
  let connected = false;
  const socket = connect(3129, '127.0.0.1');
  socket.on('connect', () => {
    connected = true;
    socket.pipe(chromium.stdio[3]);
    chromium.stdio[4].pipe(socket);
  });
  socket.on('error', () => {});
  // The host closing the link ends the browser; before that, the relay may still be starting.
  socket.on('close', () => {
    if (connected) quit(0);
    else if (attempt < 50) setTimeout(() => open(attempt + 1), 200);
    else quit(5);
  });
}
open();
