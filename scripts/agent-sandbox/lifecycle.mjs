// M0 diagnostic only. This deliberately limited PGID supervisor is NOT a product backend.
import { fork, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { candidateProfile, command } from './probe.mjs';
const self = fileURLToPath(import.meta.url);
const delay = ms => new Promise(r => setTimeout(r, ms));
const cleanEnv = cwd => ({ PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd });

export function observationStatus({ started, before, after, networkBefore, networkAfter }) {
  if (!started || before === 0) return 'NOT_RUN';
  return after > before || networkAfter > networkBefore ? 'FAIL' : 'PASS';
}

function supervise() {
  let worker, shell, timer, stopped = false;
  const send = message => { if (process.connected) process.send(message); };
  const stop = reason => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    // No stale numeric PID cleanup after leader exit. This is not a PID-reuse-safe tree primitive.
    let signalSent = false;
    if (shell && shell.exitCode === null && shell.signalCode === null) {
      try { process.kill(-shell.pid, 'SIGKILL'); signalSent = true; } catch {}
    }
    worker?.kill('SIGKILL');
    send({ type: 'stopped', reason, signalSent });
  };
  process.on('message', message => {
    if (message.type === 'start' && !worker && !stopped) {
      if (message.approved !== true) { stop('approval-denied'); return; }
      worker = fork(self, ['worker'], { env: cleanEnv(message.vault), stdio: ['ignore','ignore','ignore','ipc'] });
      worker.on('error', () => stop('worker-launch-error'));
      worker.on('exit', () => stop('worker-exit'));
      worker.once('message', () => {
        if (stopped) return;
        shell = spawn('/usr/bin/sandbox-exec', ['-f', message.profile, message.binary, message.mode, message.marker, String(message.port)],
          { cwd: message.vault, env: cleanEnv(message.vault), detached: true, stdio: 'ignore' });
        shell.on('error', () => stop('shell-launch-error'));
        shell.on('exit', (code, signal) => { send({type:'shell-exit',code,signal}); stop('leader-exit'); });
        shell.once('spawn', () => send({ type: 'started' }));
        timer = setTimeout(() => stop('timeout'), 1200);
      });
    } else if (message.type === 'worker-crash') worker?.kill('SIGKILL');
    else if (message.type === 'cancel') stop('user-cancel');
    else if (message.type === 'finish') { stop('observer-finish'); process.exit(0); }
  });
  process.on('disconnect', () => { stop('observer-disconnect'); process.exit(1); });
  setTimeout(() => { stop('supervisor-expiry'); process.exit(1); }, 6500);
}

async function scenario(directory, binary, mode, trigger, allowNetwork = false, approved = true) {
  const vault = join(directory, `${mode}-${trigger}-${allowNetwork}-${approved}`);
  await mkdir(vault);
  // Executable must be inside this scenario's authorized Vault.
  const localBinary = join(vault, 'fixture');
  await copyFile(binary, localBinary); await chmod(localBinary, 0o700);
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const profile = join(directory, `profile-${mode}-${trigger}-${allowNetwork}-${approved}.sb`);
  // Explicit diagnostic control only; never used as the default policy.
  await writeFile(profile, candidateProfile(vault) + (allowNetwork ? '(allow network-outbound (remote tcp "localhost:*"))\n(allow system-socket (socket-domain AF_INET))\n' : ''));
  const marker = join(vault, 'activity');
  const activity = () => readFile(marker, 'utf8').catch(() => '');
  const supervisor = fork(self, ['supervisor'], { env: { ...cleanEnv(vault), NIDUS_FIXTURE_SECRET: 'synthetic-only' }, stdio: ['ignore','ignore','ignore','ipc'] });
  const messages = [];
  supervisor.on('message', m => messages.push(m));
  supervisor.on('error', () => messages.push({ type: 'launch-error' }));
  const startedAt = Date.now();
  const send = type => { if (supervisor.connected) supervisor.send({ type }); };
  try {
    supervisor.send({ type:'start', approved, vault, profile, binary:localBinary, mode, marker, port:server.address().port });
    for (let i = 0; i < 150 && !(await activity()).length && !messages.some(m => m.type === 'launch-error' || m.reason === 'approval-denied'); i++) await delay(10);
    const initial = await activity();
    // Require an active workload, not just successful spawn, before triggering shutdown.
    if (trigger === 'supervisor-crash') supervisor.kill('SIGKILL');
    else if (trigger === 'worker-crash') send('worker-crash');
    else if (trigger === 'cancel') send('cancel');
    if (trigger !== 'supervisor-crash') {
      for (let i = 0; i < 200 && !messages.some(m => m.type === 'stopped'); i++) await delay(10);
    }
    // Allow signals and already-queued connections to settle before measuring continuing activity.
    await delay(150);
    const before = (await activity()).length, networkBefore = connections;
    await delay(600);
    const afterText = await activity(), after = afterText.length, networkAfter = connections;
    const stopped = messages.find(m => m.type === 'stopped');
    const triggered = trigger === 'supervisor-crash' ? supervisor.signalCode === 'SIGKILL' : Boolean(stopped);
    const status = approved ? observationStatus({ started: initial.length > 0 && triggered && Date.now() - startedAt < 3500, before, after, networkBefore, networkAfter })
      : stopped?.reason === 'approval-denied' && after === 0 && connections === 0 ? 'PASS' : 'FAIL';
    return { name: `${mode}/${trigger}/${allowNetwork ? 'loopback-approved' : 'network-denied'}/${approved ? 'approved' : 'denied'}`, status,
      evidence: { activeBeforeStop: initial.length > 0, stopReason: stopped?.reason ?? (triggered ? 'supervisor-sigkill' : null),
        signalSent: stopped?.signalSent ?? false, shellExit: messages.find(m => m.type === 'shell-exit') ?? null, observationMs:600, writesAfterStop:after-before, connectionsAfterStop:networkAfter-networkBefore,
        totalConnections: connections, secretLeaked: afterText.includes('S'), networkAllowed:allowNetwork } };
  } finally {
    send('finish');
    // No kill of recorded descendant PIDs. Wait past the synthetic workload's hard expiry.
    await delay(Math.max(0, 5600 - (Date.now() - startedAt)));
    supervisor.kill('SIGKILL');
    await new Promise(r => server.close(r));
  }
}

export async function lifecycleProbe() {
  const report = { schemaVersion:1, phase:'M0', generatedAt:new Date().toISOString(), platform:process.platform, kernel:release(), arch:process.arch,
    node:process.version, backend:'sandbox-exec-independent-pgid-supervisor-prototype', eligible:false, checks:[],
    limitations:['Finite synthetic observation is not a universal process-tree termination guarantee.', 'No signed XPC, VM or product runtime activated.', 'PID reuse has no atomic identity-bound kill in this prototype.'] };
  if (process.platform !== 'darwin') { report.checks.push({name:'macos',status:'NOT_RUN'}); return report; }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nidus-lifecycle-')));
  try {
    const binary = join(directory,'fixture');
    const build = await command('/usr/bin/clang', ['-Wall','-Wextra','-Werror',fileURLToPath(new URL('./lifecycle.c', import.meta.url)),'-o',binary], directory);
    const version = await command('/usr/bin/sw_vers', [], directory); report.osVersion = version.output.trim();
    if (build.code !== 0) { report.checks.push({name:'fixture-build',status:'NOT_RUN',evidence:build}); return report; }
    const startupVault = join(directory,'startup'); await mkdir(startupVault);
    const profile = join(directory,'startup.sb'); await writeFile(profile,candidateProfile(startupVault));
    const startup = await command('/usr/bin/sandbox-exec',['-f',profile,'/usr/bin/true'],startupVault);
    report.checks.push({name:'sandbox-start',status:startup.code===0?'PASS':'FAIL',evidence:{code:startup.code}});
    if (startup.code !== 0) return report;
    const cases = [['ordinary','cancel'],['setsid','cancel'],['double-fork','parent-exit'],['nested','cancel'],
      ['ordinary','worker-crash'],['setsid','worker-crash'],['ordinary','supervisor-crash'],['ordinary','timeout'],['setsid','timeout']];
    for (const [mode, trigger] of cases) report.checks.push(await scenario(directory,binary,mode,trigger));
    // A live network control is mandatory before absence of network traffic means anything.
    report.checks.push(await scenario(directory,binary,'setsid','cancel',true));
    report.checks.push(await scenario(directory,binary,'ordinary','cancel',false,false));
    const observations = report.checks.filter(c => c.evidence?.activeBeforeStop);
    const control = observations.find(c => c.evidence.networkAllowed);
    const denied = observations.filter(c => !c.evidence.networkAllowed);
    report.checks.push({name:'network-default-deny', status:!control?.evidence.totalConnections || !denied.length ? 'NOT_RUN'
      : denied.every(c => c.evidence.totalConnections === 0) ? 'PASS' : 'FAIL',
      evidence:'Independent loopback listener; successful explicitly allowed control required. Not an external-network qualification.'});
    report.checks.push({name:'shell-environment-secret-not-inherited', status:observations.length ? observations.some(c => c.evidence.secretLeaked) ? 'FAIL' : 'PASS' : 'NOT_RUN',
      evidence:'Synthetic parent-only sentinel absent from workload heartbeat; Shell receives only PATH/HOME/TMPDIR.'});
    report.checks.push({name:'pid-reuse-atomic-termination',status:'NOT_RUN',evidence:'No safe atomic identity-bound tree termination primitive; no destructive PID exhaustion test.'});
    for (const name of ['signed-xpc-lifecycle','vm-lifecycle','native-build-in-sandbox','browser-isolation','production-approval-protocol'])
      report.checks.push({name,status:'NOT_RUN',evidence:'Not implemented or qualified; not inferred from prototype results.'});
    return report;
  } finally { await rm(directory,{recursive:true,force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'supervisor') supervise();
  else if (process.argv[2] === 'worker') { process.send?.({type:'ready'}); setTimeout(()=>process.exit(0),5500); }
  else { console.log(JSON.stringify(await lifecycleProbe(),null,2)); process.exitCode=1; }
}
