// Real-VM check of stage 2d: a Vault's Git repository into the VM's /workspace and back as a branch.
// Usage: node scripts/vault-vm/workspace-sync-verify.mjs <vm-assets-dir> <evidence.json>
// The Vault is a throwaway repository made here; the "AI" is Shell commands sent by this script.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppleOfflineBackend } from '../../dist/vault/apple-backend.js';
import { CacheDiskStore } from '../../dist/vault/cache-disk.js';
import { EgressProxy, EgressRules } from '../../dist/workspace/egress.js';
import { CDPClient } from '../../dist/workspace/cdp.js';
import { WorkspaceBrowser } from '../../dist/workspace/browser.js';
import { snapshot, receive, approve } from '../../dist/workspace/sync.js';

const [assets, output] = process.argv.slice(2);
if (!assets || !output) { console.error('usage: workspace-sync-verify.mjs <vm-assets-dir> <evidence.json>'); process.exit(2); }

const work = await mkdtemp(join(await realpath(tmpdir()), 'nidus-sync-verify-'));
const vault = join(work, 'vault');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: vault, encoding: 'utf8' }).trim();
await mkdir(join(vault, '.nidus/local'), { recursive: true });
git('init', '-q');
await writeFile(join(vault, 'README.md'), '# 테스트 Vault\n');
await writeFile(join(vault, 'index.html'), '<title>Workspace page</title><h1>작업 공간 파일</h1>');
await writeFile(join(vault, '.gitignore'), '.nidus/local/\n');
git('add', '.'); git('commit', '-qm', '처음');
await writeFile(join(vault, '.nidus/local/usage.sqlite'), 'local only');
await writeFile(join(vault, 'README.md'), '# 테스트 Vault\n사용자가 아직 고치는 중\n');

const evidence = { at: new Date().toISOString(), scope: 'real Apple Virtualization VM; throwaway Vault repository; AI work simulated by Shell commands', checks: [] };
const check = async (name, body) => {
  const started = Date.now(), entry = { name };
  try { Object.assign(entry, await body()); entry.pass ??= true; } catch (error) { entry.pass = false; entry.error = String(error?.message ?? error); }
  entry.ms = Date.now() - started;
  evidence.checks.push(entry);
  console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${name} (${entry.ms} ms)${entry.pass ? '' : ' ' + entry.error}`);
};
const expect = (condition, detail) => { if (!condition) throw new Error('expectation failed: ' + JSON.stringify(detail)); };

const proxy = new EgressProxy({ rules: EgressRules.empty(), approve: async () => 'deny' });
const disks = new CacheDiskStore(join(work, 'disks'));
const vaultId = randomUUID(), environmentId = randomUUID();
let backend, disk;
const boot = async () => { disk = await disks.acquire(vaultId, environmentId); backend = new AppleOfflineBackend(assets, proxy); await backend.start(disk); };
const halt = async () => { await backend.stop(); await disks.release(disk.diskId, backend.cacheClean); };
const shell = async command => {
  const r = await backend.execute(randomUUID(), command, 60, { profile: 'shell' });
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.exitCode };
};

const task = 'readme-update';
let base, head;
try {
  await boot();

  await check('the Vault\'s committed state goes into the VM', async () => {
    const snap = await snapshot(vault);
    base = snap.base;
    const commit = await backend.importWorkspace(task, snap.bundle);
    expect(commit === base, { commit, base });
    return { bundleBytes: snap.bundle.length };
  });

  await check('the Shell works in /workspace on the task branch; uncommitted and ignored files stayed out', async () => {
    const r = await shell('pwd; git branch --show-current; cat README.md; test -e .nidus/local/usage.sqlite && echo LEAK || echo no-local; git log --oneline | wc -l; id -u');
    expect(r.out === '/workspace\nnidus/readme-update\n# 테스트 Vault\nno-local\n1\n1000', r);
    return { output: r.out.split('\n') };
  });

  await check('the AI changes, commits, runs a script from the workspace and leaves one change uncommitted', async () => {
    const r = await shell([
      'printf "# 테스트 Vault\\nAI가 설명을 보탰습니다\\n" > README.md',
      'printf "#!/bin/sh\\necho script ran\\n" > tool.sh && chmod +x tool.sh && ./tool.sh',
      'git add README.md tool.sh && git commit -qm "README 보강, 도구 추가"',
      'echo "draft" > notes.txt',
      'git status --porcelain',
    ].join(' && '));
    expect(r.code === 0 && r.out.includes('script ran') && r.out.includes('?? notes.txt'), r);
    return { output: r.out.split('\n') };
  });

  await check('the browser opens workspace files read-only', async () => {
    const browser = new WorkspaceBrowser(new CDPClient(await backend.openBrowser(300)));
    await browser.start();
    const page = await browser.act({ op: 'navigate', url: 'file:///workspace/index.html' });
    await browser.close(); await backend.closeBrowser();
    expect(page.title === 'Workspace page' && /작업 공간 파일/.test(page.text), { title: page.title });
    return { title: page.title };
  });

  await check('the workspace survives a VM restart and is selected again', async () => {
    await halt(); await boot();
    const selected = await backend.selectWorkspace(task);
    const r = await shell('git log --oneline | wc -l; cat notes.txt');
    expect(selected && r.out === '2\ndraft', { selected, r });
    return { selected };
  });

  await check('the work comes back to a hidden ref with uncommitted changes committed; nothing is a branch yet', async () => {
    const out = await backend.exportWorkspace(task, base);
    expect(out.bundle, 'no bundle');
    const review = await receive(vault, task, base, out.bundle);
    head = review.head;
    const branches = git('branch', '--list', 'nidus/*');
    expect(review.commits.length === 2 && review.files.map(f => f.path).sort().join() === 'README.md,notes.txt,tool.sh' && branches === '' && review.sensitive.length === 0, { commits: review.commits, files: review.files, branches });
    return { commits: review.commits.map(c => c.subject), files: review.files, bundleBytes: out.bundle.length };
  });

  await check('approval makes the branch nidus/<task>; the user\'s branch and edits are untouched', async () => {
    const branch = await approve(vault, task, head);
    const current = git('branch', '--show-current');
    const readme = await readFile(join(vault, 'README.md'), 'utf8');
    const onBranch = git('show', `${branch}:README.md`);
    expect(branch === 'nidus/readme-update' && current === 'main' && readme === '# 테스트 Vault\n사용자가 아직 고치는 중\n' && /AI가 설명을 보탰습니다/.test(onBranch), { branch, current, readme });
    return { branch, currentBranch: current };
  });

  await check('a task without changes brings nothing back', async () => {
    const snap = await snapshot(vault);
    await backend.importWorkspace('no-change', snap.bundle);
    const out = await backend.exportWorkspace('no-change', snap.base);
    expect(out.bundle === null && out.head === snap.base, out);
    return {};
  });

  await check('a second import with the same task name is refused (work is never overwritten)', async () => {
    const snap = await snapshot(vault);
    try { await backend.importWorkspace(task, snap.bundle); } catch (error) { expect(/workspace exists/.test(error.message), error.message); return { refused: error.message }; }
    throw new Error('not refused');
  });
} catch (error) {
  evidence.fatal = String(error?.message ?? error);
  console.log('FATAL', evidence.fatal);
} finally {
  try { await halt(); evidence.stopped = 'STOP_CONFIRMED'; } catch (error) { evidence.stopped = String(error?.code ?? error?.message ?? error); }
  await proxy.close();
  await rm(work, { recursive: true, force: true });
}
evidence.pass = !evidence.fatal && evidence.checks.length > 0 && evidence.checks.every(c => c.pass) && evidence.stopped === 'STOP_CONFIRMED';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(evidence.pass ? 'ALL PASS' : 'NOT ALL PASS', '| stop:', evidence.stopped);
process.exit(evidence.pass ? 0 : 1);
