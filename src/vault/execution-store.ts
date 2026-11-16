import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultError } from './types.js';
import { initialExecutionSnapshot, type ExecutionSnapshot } from './execution-types.js';
import { validateExecutionSnapshot } from './execution-state.js';
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
async function directory(path: string): Promise<string> {
  const full = resolve(path); let current = parse(full).root;
  for (const part of full.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part); const s = await lstat(current, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new VaultError('execution_unsafe_directory');
  }
  const s = await lstat(full, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
async function ensure(path: string): Promise<void> {
  try { await directory(path); } catch (e) {
    if (!absent(e)) throw e;
    await ensure(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await directory(path);
  }
}
async function sync(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await f.sync(); } finally { await f.close(); }
}
async function read(path: string): Promise<string | null> {
  let f;
  try { f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (absent(e)) return null; throw e; }
  try {
    const a = await f.stat({ bigint: true });
    if (!a.isFile() || a.nlink !== 1n || a.size > 8_388_608n || a.uid !== BigInt(process.getuid!()) || (a.mode & 0o077n)) throw new VaultError('execution_unsafe_file');
    const text = await f.readFile('utf8'), b = await f.stat({ bigint: true }), n = await lstat(path, { bigint: true });
    if (a.ino !== n.ino || a.dev !== n.dev || n.nlink !== 1n || n.isSymbolicLink() || a.ctimeNs !== b.ctimeNs || a.mtimeNs !== b.mtimeNs || a.size !== b.size) throw new VaultError('execution_file_changed');
    return text;
  } finally { await f.close(); }
}
async function write(path: string, text: string) {
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(text); await f.sync(); } finally { await f.close(); }
}
/** One Host admission owner, independent of the short-lived M1a Registry mutation lock. */
export class ExecutionStore {
  readonly directory: string;
  private identity: string | null = null;
  private lockIdentity: string | null = null;
  private raw: string | null = null;
  private held = false;
  constructor(path: string, readonly ownerId: string) { this.directory = resolve(path); }
  private get lock() { return join(this.directory, 'admission.owner'); }
  private async check() {
    if (!this.held || this.identity !== await directory(this.directory) || this.lockIdentity !== await directory(this.lock) ||
        await read(join(this.lock, 'owner.json')) !== JSON.stringify({ ownerId: this.ownerId })) throw new VaultError('admission_owner_changed');
  }
  async read(): Promise<ExecutionSnapshot> {
    try { await directory(this.directory); } catch (e) { if (absent(e)) return initialExecutionSnapshot(); throw e; }
    const stat = await lstat(this.directory);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new VaultError('execution_store_permissions');
    if ((await readdir(this.directory)).some(n => n.startsWith('state.pending-'))) throw new VaultError('execution_write_interrupted');
    const raw = await read(join(this.directory, 'state.json'));
    if (raw === null) {
      const files = await readdir(this.directory);
      if (files.includes('initialized')) throw new VaultError('execution_state_missing');
      return initialExecutionSnapshot();
    }
    try { return validateExecutionSnapshot(JSON.parse(raw)); } catch { throw new VaultError('execution_state_corrupt'); }
  }
  async claim(): Promise<ExecutionSnapshot> {
    await ensure(this.directory); this.identity = await directory(this.directory);
    const stat = await lstat(this.directory);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new VaultError('execution_store_permissions');
    try { await mkdir(this.lock, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultError('admission_busy'); throw e;
    }
    // Every failure after mkdir preserves the owner lock. No PID/TTL reclamation.
    this.lockIdentity = await directory(this.lock); this.held = true;
    await write(join(this.lock, 'owner.json'), JSON.stringify({ ownerId: this.ownerId }));
    await sync(this.lock); await sync(this.directory);
    const state = await this.read();
    if (state.ownerId !== null || state.leases.some(l => !l.released) || state.executions.some(e => !['COMPLETED','FAILED','CANCELLED'].includes(e.state))) throw new VaultError('execution_recovery_required');
    this.raw = await read(join(this.directory, 'state.json'));
    state.ownerId = this.ownerId; await this.save(state);
    try { await write(join(this.directory, 'initialized'), '1'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    await sync(this.directory); return state;
  }
  async save(state: ExecutionSnapshot): Promise<void> {
    await this.check();
    if (await read(join(this.directory, 'state.json')) !== this.raw) throw new VaultError('execution_revision_conflict');
    const next = { ...state, revision: state.revision + 1 }; validateExecutionSnapshot(next);
    const text = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(text) > 8_388_608) throw new VaultError('execution_store_full');
    const pending = join(this.directory, `state.pending-${randomUUID()}`);
    await write(pending, text); await this.check();
    if (await read(join(this.directory, 'state.json')) !== this.raw) throw new VaultError('execution_revision_conflict');
    await rename(pending, join(this.directory, 'state.json')); await sync(this.directory);
    this.raw = text; state.revision = next.revision;
  }
  async assertCurrent() {
    await this.check();
    if (await read(join(this.directory, 'state.json')) !== this.raw) throw new VaultError('execution_revision_conflict');
  }
  async release(state: ExecutionSnapshot) {
    if (state.executions.some(e => !['COMPLETED','FAILED','CANCELLED'].includes(e.state)) || state.leases.some(l => !l.released)) throw new VaultError('admission_not_quiescent');
    state.ownerId = null; await this.save(state); await this.check();
    await unlink(join(this.lock, 'owner.json')); await rmdir(this.lock); await sync(this.directory); this.held = false;
  }
  async hasOwner(): Promise<boolean> {
    try { await lstat(this.lock); return true; } catch (e) { if (absent(e)) return false; throw e; }
  }
}
