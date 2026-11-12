import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, receive, approve, discard, pending } from '../dist/workspace/sync.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

/** A Vault with one commit, an uncommitted change and an ignored local file. */
async function vault(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-sync-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'vault');
  await mkdir(join(root, '.nidus/local'), { recursive: true });
  git(dir, 'init', '-q', 'vault');
  await writeFile(join(root, 'README.md'), 'hello\n');
  await writeFile(join(root, '.gitignore'), '.nidus/local/\n');
  await writeFile(join(root, '.nidus/network.json'), '{"version":1,"allow":[],"deny":[]}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  await writeFile(join(root, '.nidus/local/usage.sqlite'), 'secret-ish');
  await writeFile(join(root, 'README.md'), 'hello\nuser is still editing\n');
  return { dir, root };
}

/** What the VM does: clone the bundle, work on a branch, bundle the work. */
async function work(dir, inBundle, base, change) {
  const ws = join(dir, `ws-${Math.random().toString(36).slice(2)}`);
  await writeFile(join(dir, 'in.bundle'), inBundle);
  git(dir, 'clone', '-q', join(dir, 'in.bundle'), ws);
  git(ws, 'checkout', '-qb', 'nidus/task');
  await change(ws);
  git(ws, 'bundle', 'create', '-q', join(dir, 'out.bundle'), 'HEAD', `^${base}`);
  return { ws, bundle: await readFile(join(dir, 'out.bundle')) };
}

test('round trip: committed state goes in, work comes back hidden, approval makes a branch, the user is untouched', async t => {
  const { dir, root } = await vault(t);
  const { base, bundle } = await snapshot(root);
  assert.equal(base, git(root, 'rev-parse', 'HEAD'));

  const { ws, bundle: out } = await work(dir, bundle, base, async ws => {
    assert.equal(await readFile(join(ws, 'README.md'), 'utf8'), 'hello\n', 'uncommitted user edits stay in the Vault');
    await assert.rejects(readFile(join(ws, '.nidus/local/usage.sqlite')), 'ignored local data stays in the Vault');
    await writeFile(join(ws, 'feature.txt'), 'new\n');
    git(ws, 'add', '.'); git(ws, 'commit', '-qm', '기능 추가');
  });
  void ws;

  const review = await receive(root, 'add-feature', base, out);
  assert.equal(review.commits.length, 1);
  assert.equal(review.commits[0].subject, '기능 추가');
  assert.deepEqual(review.files, [{ path: 'feature.txt', added: 1, removed: 0 }]);
  assert.match(review.diff, /\+new/);
  assert.deepEqual(review.sensitive, []);
  assert.equal(git(root, 'branch', '--list', 'nidus/*'), '', 'not a branch before approval');
  assert.deepEqual((await pending(root, 'add-feature', base)).head, review.head);

  assert.equal(await approve(root, 'add-feature', review.head), 'nidus/add-feature');
  assert.equal(git(root, 'rev-parse', 'nidus/add-feature'), review.head);
  assert.equal(git(root, 'branch', '--show-current'), 'main', 'current branch unchanged');
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'hello\nuser is still editing\n', 'working tree unchanged');
  assert.equal(await pending(root, 'add-feature', base), null);
});

test('settings changes are flagged; an existing branch is never overwritten; approval is for what was reviewed', async t => {
  const { dir, root } = await vault(t);
  const { base, bundle } = await snapshot(root);
  const { bundle: out } = await work(dir, bundle, base, async ws => {
    await writeFile(join(ws, '.nidus/network.json'), '{"version":1,"allow":["*"],"deny":[]}\n');
    git(ws, 'commit', '-qam', 'allow everything');
  });
  const review = await receive(root, 'widen', base, out);
  assert.deepEqual(review.sensitive, ['.nidus/network.json']);
  await assert.rejects(approve(root, 'widen', base), /workspace_changed_since_review/);
  git(root, 'branch', 'nidus/widen');
  await assert.rejects(approve(root, 'widen', review.head), /workspace_branch_exists/);
  assert.equal(git(root, 'rev-parse', 'nidus/widen'), base, 'existing branch kept');
  await discard(root, 'widen');
  assert.equal(await pending(root, 'widen', base), null);
});

test('work that does not continue from the start commit, bad bundles and bad names are refused', async t => {
  const { dir, root } = await vault(t);
  const { base, bundle } = await snapshot(root);
  // History rewritten in the VM: a new root commit that does not contain the base.
  const { bundle: orphan } = await work(dir, bundle, base, async ws => {
    git(ws, 'checkout', '-q', '--orphan', 'rewritten');
    await writeFile(join(ws, 'x.txt'), 'x\n');
    git(ws, 'add', '.'); git(ws, 'commit', '-qm', 'orphan');
  });
  await assert.rejects(receive(root, 'orphan', base, orphan), /workspace_history_rewritten|git_failed/);
  assert.equal(await pending(root, 'orphan', base), null, 'nothing left behind');
  await assert.rejects(receive(root, 'junk', base, Buffer.from('not a bundle')), /git_failed/);
  await assert.rejects(receive(root, '../escape', base, Buffer.alloc(0)), /workspace_task_invalid/);
  await assert.rejects(receive(root, 'ok', 'HEAD', Buffer.alloc(0)), /workspace_base_invalid/);
});

test('a Vault without commits cannot start a workspace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-sync-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', 'empty');
  await assert.rejects(snapshot(join(dir, 'empty')), /vault_no_commits/);
});
