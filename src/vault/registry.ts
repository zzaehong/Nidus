import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, readdir, rename, unlink, link, rmdir } from 'node:fs/promises';
import { resolve, join, dirname, basename, parse, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VaultError, type FileIdentity, type VaultDescriptor, type VaultRegistration, type VaultRegistrySnapshot } from './types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code: string): never => { throw new VaultError(code); };
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const within = (a: string, b: string) => b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
const same = (a: FileIdentity, b: FileIdentity) => a.device === b.device && a.inode === b.inode && a.birthtimeNs === b.birthtimeNs;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function descriptor(v: unknown): VaultDescriptor {
  const d = v as VaultDescriptor;
  if (!d || d.schemaVersion !== 1) fail('unsupported_schema');
  if (Object.keys(d).sort().join() !== 'createdAt,displayName,environmentId,schemaVersion,vaultId' ||
      !uuid.test(d.vaultId) || !uuid.test(d.environmentId) || !date(d.createdAt) ||
      typeof d.displayName !== 'string' || !d.displayName.trim() || d.displayName.length > 255) fail('descriptor_corrupt');
  return d;
}
async function identity(path: string): Promise<FileIdentity> {
  const s = await lstat(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) fail('unsafe_directory');
  return { device: String(s.dev), inode: String(s.ino), birthtimeNs: String(s.birthtimeNs) };
}
// Reject symlinks in every input component, including components preceding '..'.
async function checkedPath(input: string): Promise<string> {
  if (!input || input.includes('\0') || input.split(sep).includes('..')) fail('unsafe_path');
  const path = resolve(input);
  let part = parse(path).root;
  for (const component of path.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, component); await identity(part);
  }
  if (await realpath(path) !== path) fail('unsafe_path');
  return path;
}
async function ensureDirectory(path: string): Promise<void> {
  try { await checkedPath(path); return; } catch (e) { if (!missing(e)) throw e; }
  await ensureDirectory(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  await checkedPath(path);
}
async function readSafe(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (missing(e)) return null; throw e; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4_194_304n) fail('unsafe_file');
    const data = await file.readFile('utf8');
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (before.dev !== named.dev || before.ino !== named.ino || named.isSymbolicLink() || named.nlink !== 1n ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('file_changed');
    return data;
  } finally { await file.close(); }
}
function json(raw: string): unknown { try { return JSON.parse(raw); } catch { return fail('invalid_json'); } }
async function syncDirectory(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await f.sync(); } finally { await f.close(); }
}
async function writeNew(path: string, text: string) {
  const f = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(text); await f.sync(); } finally { await f.close(); }
}

export type RegistrationRelation = 'same' | 'move' | 'clone' | 'unconfirmed';
export async function classifyVaultLocation(old: VaultRegistration, path: string, current: FileIdentity): Promise<RegistrationRelation> {
  if (old.canonicalRoot === path) return same(old.identity, current) ? 'same' : 'unconfirmed';
  try { await lstat(old.canonicalRoot); return 'clone'; }
  catch (e) { if (!missing(e)) return 'unconfirmed'; }
  return same(old.identity, current) ? 'move' : 'unconfirmed';
}

/** Host-only metadata. A stale lock is deliberately never stolen based on PID or age. */
export class VaultRegistry {
  readonly directory: string;
  private writeUncertain = false;
  constructor(directory = join(homedir(), '.local', 'share', 'nidus', 'vaults')) { this.directory = resolve(directory); }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await ensureDirectory(this.directory);
    await checkedPath(this.directory);
    const hostIdentity = await identity(this.directory);
    const host = await lstat(this.directory);
    if (host.uid !== process.getuid?.() || (host.mode & 0o077)) fail('registry_permissions');
    const lock = join(this.directory, 'registry.lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('registry_locked'); throw e;
    }
    this.writeUncertain = false;
    let clean = false;
    try {
      if ((await readdir(this.directory)).some(n => n.startsWith('registry.pending-'))) fail('registry_interrupted');
      const result = await action();
      await checkedPath(this.directory);
      if (!same(hostIdentity, await identity(this.directory))) fail('registry_replaced');
      clean = true; return result;
    } catch (e) {
      // A pending write must retain its lock for explicit recovery inspection.
      clean = !this.writeUncertain && !(await readdir(this.directory)).some(n => n.startsWith('registry.pending-'));
      throw e;
    } finally {
      if (clean && same(hostIdentity, await identity(this.directory))) await rmdir(lock);
    }
  }
  private async load(): Promise<{ snapshot: VaultRegistrySnapshot; raw: string | null }> {
    const raw = await readSafe(join(this.directory, 'registry.json'));
    if (raw === null) return { raw, snapshot: { schemaVersion: 1, revision: 0, vaults: [] } };
    const s = json(raw) as VaultRegistrySnapshot;
    if (!s || s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.vaults)) fail('registry_corrupt');
    const ids = new Set<string>(), envs = new Set<string>(), paths: string[] = [];
    for (const v of s.vaults) {
      if (!v) fail('registry_corrupt');
      descriptor({ schemaVersion: v.schemaVersion, vaultId: v.vaultId, environmentId: v.environmentId, displayName: v.displayName, createdAt: v.createdAt });
      if (v.status !== 'registered' || typeof v.canonicalRoot !== 'string' || resolve(v.canonicalRoot) !== v.canonicalRoot ||
          !v.identity || ![v.identity.device, v.identity.inode, v.identity.birthtimeNs].every(x => typeof x === 'string' && /^\d+$/.test(x)) ||
          !Number.isSafeInteger(v.revision) || v.revision < 1 || v.revision > s.revision || !v.lastValidation ||
          !date(v.lastValidation.checkedAt) || !['valid', 'invalid'].includes(v.lastValidation.result) ||
          ids.has(v.vaultId) || envs.has(v.environmentId) || paths.some(p => within(p, v.canonicalRoot) || within(v.canonicalRoot, p))) fail('registry_corrupt');
      ids.add(v.vaultId); envs.add(v.environmentId); paths.push(v.canonicalRoot);
    }
    return { raw, snapshot: s };
  }
  private async save(s: VaultRegistrySnapshot, expected: string | null, verify: () => Promise<void>) {
    const hostId = await identity(this.directory);
    const guard = async () => { await checkedPath(this.directory); if (!same(hostId, await identity(this.directory))) fail('registry_replaced'); await verify(); };
    const target = join(this.directory, 'registry.json');
    await guard();
    if (await readSafe(target) !== expected) fail('registry_revision_conflict');
    const payload = JSON.stringify(s, null, 2);
    if (Buffer.byteLength(payload) > 4_194_304) fail('registry_size_limit');
    const pending = join(this.directory, `registry.pending-${randomUUID()}`);
    this.writeUncertain = true;
    await writeNew(pending, payload);
    await guard();
    if (await readSafe(target) !== expected) fail('registry_revision_conflict');
    await rename(pending, target); await syncDirectory(this.directory);
    this.writeUncertain = false;
  }
  private async root(path: string) {
    const canonical = await checkedPath(path);
    if (canonical === parse(canonical).root || within(canonical, await realpath(homedir())) || within(canonical, this.directory) || within(this.directory, canonical)) fail('forbidden_root');
    if ((await identity(canonical)).device !== (await identity(dirname(canonical))).device) fail('forbidden_root');
    return canonical;
  }
  private async checkRoot(root: string, expected: FileIdentity) {
    await this.root(root);
    if (!same(expected, await identity(root))) fail('root_replaced');
  }
  private async readDescriptor(root: string): Promise<VaultDescriptor | null> {
    const meta = join(root, '.nidus');
    let metaId: FileIdentity;
    try { metaId = await identity(meta); } catch (e) { if (missing(e)) return null; throw e; }
    if ((await readdir(meta)).some(n => n.startsWith('vault.pending-'))) fail('descriptor_interrupted');
    const raw = await readSafe(join(meta, 'vault.json'));
    if (!same(metaId, await identity(meta))) fail('metadata_replaced');
    return raw === null ? null : descriptor(json(raw));
  }
  private async noNested(root: string) {
    for (let p = dirname(root); p !== dirname(p); p = dirname(p)) {
      try { await lstat(join(p, '.nidus', 'vault.json')); fail('nested_vault'); } catch (e) { if (!missing(e)) throw e; }
    }
    // Bounded traversal, no symlink following. Unreadable/oversized trees fail closed.
    const queue = [root]; let count = 0;
    while (queue.length) {
      const p = queue.pop()!;
      await checkedPath(p);
      for (const entry of await readdir(p, { withFileTypes: true })) {
        if (++count > 100_000) fail('scan_limit');
        if (entry.name === '.nidus') { if (p !== root) fail('nested_vault'); continue; }
        if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(join(p, entry.name));
      }
    }
  }
  async registerVault(path: string): Promise<VaultRegistration> {
    return this.locked(async () => {
      const { snapshot: s, raw } = await this.load();
      const root = await this.root(path), id = await identity(root);
      await this.noNested(root);
      let d = await this.readDescriptor(root);
      for (const old of s.vaults) {
        if (old.canonicalRoot !== root && (within(old.canonicalRoot, root) || within(root, old.canonicalRoot))) fail('nested_vault');
        if (old.canonicalRoot === root && (!d || old.vaultId !== d.vaultId)) fail('path_conflict');
      }
      if (!d) {
        await this.checkRoot(root, id);
        const meta = join(root, '.nidus');
        try { await mkdir(meta, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        const metaId = await identity(meta);
        d = { schemaVersion: 1, vaultId: randomUUID(), environmentId: randomUUID(), displayName: basename(root), createdAt: new Date().toISOString() };
        const pending = join(meta, `vault.pending-${randomUUID()}`);
        await writeNew(pending, JSON.stringify(d, null, 2));
        await this.checkRoot(root, id);
        if (!same(metaId, await identity(meta))) fail('metadata_replaced');
        // link is an atomic no-replace publish; a crash before unlink is detected on restart.
        await link(pending, join(meta, 'vault.json'));
        await unlink(pending); await syncDirectory(meta);
      }
      const old = s.vaults.find(v => v.vaultId === d.vaultId);
      if (old) {
        const relation = await classifyVaultLocation(old, root, id);
        if (relation === 'clone' || relation === 'unconfirmed') fail(`identity_${relation}`);
        if (old.environmentId !== d.environmentId || old.createdAt !== d.createdAt) fail('descriptor_identity_changed');
      }
      if (s.vaults.some(v => v.vaultId !== d.vaultId && v.environmentId === d.environmentId)) fail('environment_conflict');
      const entry: VaultRegistration = { ...d, canonicalRoot: root, identity: id, status: 'registered', revision: ++s.revision, lastValidation: { checkedAt: new Date().toISOString(), result: 'valid' } };
      s.vaults = s.vaults.filter(v => v.vaultId !== entry.vaultId).concat(entry);
      const expected = JSON.stringify(d);
      await this.save(s, raw, async () => {
        await this.checkRoot(root, id);
        if (old) {
          const relation = await classifyVaultLocation(old, root, id);
          if (relation !== 'same' && relation !== 'move') fail(`identity_${relation}`);
        }
        if (JSON.stringify(await this.readDescriptor(root)) !== expected) fail('descriptor_changed');
      });
      return entry;
    });
  }
  private async validate(v: VaultRegistration) {
    await this.checkRoot(v.canonicalRoot, v.identity);
    const d = await this.readDescriptor(v.canonicalRoot);
    if (!d || d.vaultId !== v.vaultId || d.environmentId !== v.environmentId || d.createdAt !== v.createdAt) fail('descriptor_identity_changed');
  }
  async listVaults(): Promise<VaultRegistration[]> {
    return this.locked(async () => {
      const { snapshot } = await this.load();
      for (const v of snapshot.vaults) {
        try { await this.validate(v); v.lastValidation = { checkedAt: new Date().toISOString(), result: 'valid' }; }
        catch (e) { v.lastValidation = { checkedAt: new Date().toISOString(), result: 'invalid', code: e instanceof VaultError ? e.code : 'filesystem_unavailable' }; }
      }
      return snapshot.vaults;
    });
  }
  async resolveVault(vaultId: string): Promise<VaultRegistration> {
    return this.locked(async () => {
      const v = (await this.load()).snapshot.vaults.find(v => v.vaultId === vaultId);
      if (!v) return fail('not_registered');
      await this.validate(v); v.lastValidation = { checkedAt: new Date().toISOString(), result: 'valid' }; return v;
    });
  }
  async unregisterVault(vaultId: string): Promise<void> {
    return this.locked(async () => {
      const { snapshot: s, raw } = await this.load();
      if (!s.vaults.some(v => v.vaultId === vaultId)) fail('not_registered');
      s.vaults = s.vaults.filter(v => v.vaultId !== vaultId); s.revision++;
      await this.save(s, raw, async () => {});
    });
  }
}
