// M0 developer diagnostic only. Never enables a product backend or runs user code.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sandboxLiteral(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid sandbox path');
  return JSON.stringify(value);
}
export function candidateProfile(vault) {
  const root = sandboxLiteral(vault);
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/bin") (subpath "/private/var/db/dyld") (literal "/dev/null"))
(allow file-read* file-write* (subpath ${root}))
(deny file-read* file-write* (subpath ${sandboxLiteral(join(vault, '.nidus'))}) (subpath ${sandboxLiteral(join(vault, '.git'))}) (literal ${sandboxLiteral(join(vault, '.env'))}))
`;
}
export function command(executable, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', total = 0, timedOut = false;
    const collect = (chunk, stderr) => {
      total += chunk.length;
      if (total > 65536) { child.kill('SIGKILL'); return; }
      if (stderr) error += chunk.toString(); else output += chunk.toString();
    };
    child.stdout.on('data', c => collect(c, false)); child.stderr.on('data', c => collect(c, true));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, signal: null, launchError: true, timedOut, output: '', error: '' }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, launchError: false, timedOut, output, error }); });
  });
}
async function descendantCheck(profile, vault, directory) {
  const binary = join(vault, 'descendant');
  const source = fileURLToPath(new URL('./descendant.c', import.meta.url));
  const build = await command('/usr/bin/clang', [source, '-o', binary], directory);
  if (build.code !== 0) return { status: 'NOT_RUN', evidence: 'Could not compile synthetic lifecycle fixture' };
  const marker = join(vault, 'child.pid');
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, binary, marker], { cwd: vault, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: vault, TMPDIR: vault } });
  let launchError = false; child.on('error', () => { launchError = true; });
  const closed = new Promise(resolve => child.on('close', resolve));
  let descendant = null;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const raw = await readFile(marker, 'utf8').catch(() => '');
      const match = /^([1-9][0-9]*)\n/.exec(raw);
      if (match) { descendant = Number(match[1]); break; }
      if (launchError || child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(r => setTimeout(r, 20));
    }
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await closed;
    if (!descendant) return { status: 'NOT_RUN', evidence: 'Detached child did not start; cannot claim cleanup safety' };
    const before = await readFile(marker, 'utf8');
    await new Promise(r => setTimeout(r, 250));
    const survived = (await readFile(marker, 'utf8')).length > before.length;
    return { status: survived ? 'FAIL' : 'PASS', evidence: { strategy: 'terminate-process-group', detachedChildSurvived: survived } };
  } finally {
    // Only a PID emitted by our just-built fixture is used. The fixture also exits after 10s.
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
}
async function networkCheck(run, directory, vault) {
  let hits = 0;
  const server = createServer((_req, res) => { res.end('fixture-network'); });
  server.on('connection', () => { hits++; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const binary = join(vault, 'network');
    const build = await command('/usr/bin/clang', [fileURLToPath(new URL('./network.c', import.meta.url)), '-o', binary], directory);
    if (build.code !== 0) return { status: 'NOT_RUN', evidence: 'Could not compile local network fixture' };
    const args = [String(server.address().port)];
    const control = await command(binary, args, directory);
    if (control.code !== 0) return { status: 'NOT_RUN', evidence: 'Local network control failed' };
    const before = hits, result = await run(binary, args);
    return { status: result.code === 77 ? 'PASS' : result.code === 0 ? 'FAIL' : 'NOT_RUN', evidence: { code: result.code, connectionsReceived: hits - before, scope: 'loopback fixture only; EPERM/EACCES required; no external network tested' } };
  } finally { await new Promise(r => server.close(r)); }
}
export async function probe() {
  const report = { schemaVersion: 1, phase: 'M0', platform: process.platform, arch: process.arch, generatedAt: new Date().toISOString(), backend: 'sandbox-exec-candidate', eligible: false, checks: [], limitations: ['Diagnostic only; no backend activation', 'Browser isolation and descendant containment require independent verification'] };
  const add = (name, status, evidence) => report.checks.push({ name, status, evidence });
  if (process.platform !== 'darwin') { add('macos', 'NOT_RUN', 'macOS required'); return report; }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nidus-sandbox-probe-')));
  try {
    const vault = join(directory, 'vault'), outside = join(directory, 'outside.txt');
    await mkdir(vault); await mkdir(join(vault, '.nidus')); await mkdir(join(vault, '.git'));
    await writeFile(join(vault, 'input.txt'), 'fixture-inside'); await writeFile(outside, 'fixture-outside');
    await writeFile(join(vault, '.nidus', 'audit.txt'), 'fixture-protected');
    await writeFile(join(vault, '.env'), 'FIXTURE_ONLY=no-secret');
    await symlink(outside, join(vault, 'escape'));
    const profile = join(directory, 'candidate.sb'); await writeFile(profile, candidateProfile(vault));
    const run = (exe, args = []) => command('/usr/bin/sandbox-exec', ['-f', profile, exe, ...args], vault);
    const startup = await run('/usr/bin/true');
    add('minimal-process-start', startup.code === 0 ? 'PASS' : 'FAIL', { code: startup.code, signal: startup.signal, timedOut: startup.timedOut, launchError: startup.launchError });
    // A failed process launch is NOT proof that file/network isolation works.
    if (startup.code !== 0) {
      for (const name of ['vault-read', 'vault-write', 'outside-read-denied', 'outside-write-denied', 'metadata-protected', 'secret-protected', 'symlink-escape-denied', 'network-denied', 'descendant-cleanup', 'native-build', 'browser-isolation']) add(name, 'NOT_RUN', 'Startup gate failed');
      return report;
    }
    for (const [name, path, expected] of [['vault-read', join(vault, 'input.txt'), 'fixture-inside'], ['outside-read-denied', outside, null], ['metadata-protected', join(vault, '.nidus', 'audit.txt'), null], ['secret-protected', join(vault, '.env'), null], ['symlink-escape-denied', join(vault, 'escape'), null]]) {
      const r = await run('/bin/cat', [path]);
      add(name, expected === null ? (r.code === 1 && r.signal === null && !r.output ? 'PASS' : 'FAIL') : (r.code === 0 && r.output === expected ? 'PASS' : 'FAIL'), { code: r.code, signal: r.signal });
    }
    const insideWrite = await run('/bin/sh', ['-c', 'printf fixture-written > "$1"', 'probe', join(vault, 'result.txt')]);
    add('vault-write', insideWrite.code === 0 && await readFile(join(vault, 'result.txt'), 'utf8').catch(() => '') === 'fixture-written' ? 'PASS' : 'FAIL', { code: insideWrite.code });
    const outsideWrite = await run('/bin/sh', ['-c', 'printf changed > "$1"', 'probe', outside]);
    add('outside-write-denied', outsideWrite.code === 1 && outsideWrite.signal === null && await readFile(outside, 'utf8') === 'fixture-outside' ? 'PASS' : 'FAIL', { code: outsideWrite.code });
    const network = await networkCheck(run, directory, vault); add('network-denied', network.status, network.evidence);
    const descendants = await descendantCheck(profile, vault, directory); add('descendant-cleanup', descendants.status, descendants.evidence);
    for (const name of ['native-build', 'browser-isolation']) add(name, 'NOT_RUN', 'Separate security qualification required; not inferred from file tests');
    return report;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await probe(); console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.eligible ? 0 : 1;
}
