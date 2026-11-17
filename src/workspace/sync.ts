// Workspace sync on the host: the Vault's Git repository in and out of the VM.
//
// In:  the committed state (HEAD) as a git bundle. Uncommitted changes, ignored files and
//      .nidus/local/ never leave the Vault.
// Out: the work branch as a bundle from the VM. It is fetched into a hidden ref
//      (refs/nidus/incoming/<task>, not a branch) with object checks on, and shown to the user.
//      Only on approval does it become the branch nidus/<task>. The user's working tree and
//      current branch are never touched; merging is the user's call.
//
// Everything from the VM is untrusted: hooks are off for every git call, objects are checked,
// the branch must continue from the commit the task started at, and sizes are bounded.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const TASK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_IMPORT = 256 * 1024 * 1024;
export const MAX_EXPORT = 128 * 1024 * 1024;
const MAX_DIFF = 200 * 1024;

export class SyncError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

export interface ReviewFile { path: string; added: number | null; removed: number | null }
export interface Review {
  task: string;
  base: string;
  head: string;
  commits: { hash: string; subject: string; author: string }[];
  files: ReviewFile[];
  diff: string;
  diffTruncated: boolean;
  /** Changed paths that alter Nidus settings in the Vault (.nidus/), such as network rules. */
  sensitive: string[];
}

async function git(vault: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', vault, '-c', 'core.hooksPath=/dev/null', ...args], {
      maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    return stdout;
  } catch (error: any) {
    throw new SyncError('git_failed', `${args[0]}: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
  }
}

/** The first `limit` bytes of a git command's output; the rest is never read. `more` says it was cut. */
function headOf(vault: string, args: string[], limit: number): Promise<{ text: string; more: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', vault, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    const chunks: Buffer[] = [];
    let size = 0, more = false;
    child.stdout.on('data', (chunk: Buffer) => { if (more) return; chunks.push(chunk); size += chunk.length; if (size > limit) { more = true; child.kill(); } });
    child.on('error', reject);
    child.on('close', code => code === 0 || more ? resolve({ text: Buffer.concat(chunks).toString('utf8').slice(0, limit), more }) : reject(new SyncError('git_failed', `${args[0]}: exit ${code}`)));
  });
}

function checkTask(task: string): void {
  if (!TASK_NAME.test(task)) throw new SyncError('workspace_task_invalid');
}

const incoming = (task: string) => `refs/nidus/incoming/${task}`;
export const branchOf = (task: string) => `nidus/${task}`;

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-sync-'));
  try { return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The Vault's committed state for a new task: its HEAD commit and a bundle of it. */
export async function snapshot(vault: string): Promise<{ base: string; bundle: Buffer }> {
  let base: string;
  try { base = (await git(vault, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); }
  catch { throw new SyncError('vault_no_commits', 'the Vault needs at least one commit'); }
  return withTemp(async dir => {
    const file = join(dir, 'in.bundle');
    await git(vault, ['bundle', 'create', '--quiet', file, 'HEAD']);
    const bundle = await readFile(file);
    if (bundle.length > MAX_IMPORT) throw new SyncError('workspace_too_large', `${bundle.length} bytes`);
    return { base, bundle };
  });
}

/** Brings the VM's work into a hidden ref and describes it for the user. Nothing becomes a branch yet. */
export async function receive(vault: string, task: string, base: string, bundle: Buffer): Promise<Review> {
  const head = await fetchWork(vault, task, base, bundle);
  return review(vault, task, base, head);
}

/**
 * One workspace's work from the VM into its hidden ref, checked like everything from the VM
 * (objects verified, must continue from the commit it started at). Returns the head; nothing is
 * shown to the user yet.
 */
export async function fetchWork(vault: string, task: string, base: string, bundle: Buffer): Promise<string> {
  checkTask(task);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new SyncError('workspace_base_invalid');
  if (bundle.length > MAX_EXPORT) throw new SyncError('workspace_too_large');
  await withTemp(async dir => {
    const file = join(dir, 'out.bundle');
    await writeFile(file, bundle);
    await git(vault, ['bundle', 'verify', '--quiet', file]);
    await git(vault, ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', file, `+HEAD:${incoming(task)}`]);
  });
  const head = (await git(vault, ['rev-parse', '--verify', `${incoming(task)}^{commit}`])).trim();
  try { await git(vault, ['merge-base', '--is-ancestor', base, head]); }
  catch {
    await discard(vault, task);
    throw new SyncError('workspace_history_rewritten', 'the work does not continue from the commit the task started at');
  }
  return head;
}

const COMMIT = /^[0-9a-f]{40}$/;
const isAncestor = (vault: string, a: string, b: string) => git(vault, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);

/**
 * Several workspaces' work as one commit on top of `base`, merged in the Vault's object store
 * without a working tree (git merge-tree): the user's files and branches are not touched. The
 * result goes to the hidden ref of `name`, for review like a single workspace's work. A conflict
 * is an error naming the files; nothing is half merged.
 */
export async function combine(vault: string, name: string, base: string, heads: string[]): Promise<string> {
  checkTask(name);
  if (!COMMIT.test(base) || !heads.every(h => COMMIT.test(h))) throw new SyncError('workspace_base_invalid');
  let current = base;
  for (const head of heads) {
    if (await isAncestor(vault, head, current)) continue;
    if (await isAncestor(vault, current, head)) { current = head; continue; }
    let tree: string;
    try {
      const { stdout } = await run('git', ['-C', vault, '-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree', '--name-only', '--no-messages', current, head], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 4 * 1024 * 1024 });
      tree = stdout.split('\n')[0]!.trim();
    } catch (error: any) {
      // Exit status 1: the merge has conflicts; the lines after the tree name the files.
      if (error?.code === 1 && typeof error.stdout === 'string') {
        const files = error.stdout.split('\n').slice(1).map((l: string) => l.trim()).filter(Boolean);
        throw new SyncError('workspace_merge_conflict', [...new Set(files)].slice(0, 20).join(', '));
      }
      throw new SyncError('git_failed', `merge-tree: ${String(error?.stderr ?? error?.message).trim().slice(0, 300)}`);
    }
    if (!COMMIT.test(tree)) throw new SyncError('git_failed', 'merge-tree gave no tree');
    const { stdout } = await run('git', ['-C', vault, 'commit-tree', tree, '-p', current, '-p', head, '-m', `nidus: ${name} 작업 합치기`], {
      env: { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 'Nidus', GIT_AUTHOR_EMAIL: 'nidus@nidus.invalid', GIT_COMMITTER_NAME: 'Nidus', GIT_COMMITTER_EMAIL: 'nidus@nidus.invalid' },
    });
    current = stdout.trim();
  }
  await git(vault, ['update-ref', '-m', 'nidus: combined workspace results', incoming(name), current]);
  return current;
}

/**
 * A bundle whose HEAD is `commit`, to start a workspace from work that is not the Vault's HEAD
 * (a task that builds on earlier tasks). Made in a throwaway repository that borrows the Vault's
 * objects, so the Vault's HEAD, branches and refs are not touched.
 */
export async function snapshotAt(vault: string, commit: string): Promise<Buffer> {
  if (!COMMIT.test(commit)) throw new SyncError('workspace_base_invalid');
  await git(vault, ['cat-file', '-e', `${commit}^{commit}`]);
  const objects = (await git(vault, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).trim();
  return withTemp(async dir => {
    const repo = join(dir, 'start.git');
    await run('git', ['init', '--quiet', '--bare', repo]);
    await writeFile(join(repo, 'objects', 'info', 'alternates'), `${objects}\n`);
    await git(repo, ['update-ref', 'refs/heads/start', commit]);
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/start']);
    const file = join(dir, 'in.bundle');
    await git(repo, ['bundle', 'create', '--quiet', file, 'HEAD', 'refs/heads/start']);
    const bundle = await readFile(file);
    if (bundle.length > MAX_IMPORT) throw new SyncError('workspace_too_large', `${bundle.length} bytes`);
    return bundle;
  });
}

async function review(vault: string, task: string, base: string, head: string): Promise<Review> {
  const log = await git(vault, ['log', '--max-count=200', '--format=%H%x00%s%x00%an', `${base}..${head}`]);
  const commits = log.split('\n').filter(Boolean).map(line => { const [hash, subject, author] = line.split('\0'); return { hash: hash!, subject: subject ?? '', author: author ?? '' }; });
  const numstat = await git(vault, ['diff', '--numstat', '-z', '--no-renames', base, head]);
  const files: ReviewFile[] = [];
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const [added, removed, ...rest] = entry.split('\t');
    files.push({ path: rest.join('\t'), added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
  }
  const diff = await headOf(vault, ['diff', '--no-color', '--no-ext-diff', base, head], MAX_DIFF);
  return {
    task, base, head, commits, files,
    diff: diff.text,
    diffTruncated: diff.more,
    sensitive: files.map(f => f.path).filter(path => path === '.nidus' || path.startsWith('.nidus/')),
  };
}

/** The work waiting for the user's decision, if any. */
export async function pending(vault: string, task: string, base: string): Promise<Review | null> {
  checkTask(task);
  let head: string;
  try { head = (await git(vault, ['rev-parse', '--verify', '--quiet', `${incoming(task)}^{commit}`])).trim(); } catch { return null; }
  return review(vault, task, base, head);
}

/** The user approved: the work becomes the branch nidus/<task>. An existing branch is never overwritten. */
export async function approve(vault: string, task: string, expectedHead: string): Promise<string> {
  checkTask(task);
  const head = (await git(vault, ['rev-parse', '--verify', `${incoming(task)}^{commit}`])).trim();
  // The user approved what they saw; anything else arriving since is not approved.
  if (head !== expectedHead) throw new SyncError('workspace_changed_since_review');
  const branch = branchOf(task);
  try { await git(vault, ['update-ref', '-m', 'nidus: approved workspace result', `refs/heads/${branch}`, head, '']); }
  catch { throw new SyncError('workspace_branch_exists', branch); }
  await git(vault, ['update-ref', '-d', incoming(task)]);
  return branch;
}

/** The user declined: the hidden ref goes; its objects are left for git's normal cleanup. */
export async function discard(vault: string, task: string): Promise<void> {
  checkTask(task);
  await git(vault, ['update-ref', '-d', incoming(task)]).catch(() => {});
}
