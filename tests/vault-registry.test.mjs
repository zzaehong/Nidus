import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, rename, cp, symlink, link, realpath, chmod, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { VaultRegistry } from '../dist/vault/registry.js';
const code = expected => e => e.code === expected;
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nidus-vault-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'vault'), host = join(base, 'host'); await mkdir(root);
  return { base, root, host, registry: new VaultRegistry(host), descriptor: join(root, '.nidus', 'vault.json'), file: join(host, 'registry.json') };
}
test('new registration, schema, listing, resolve, reload and stable re-registration', async t => {
  const f = await fixture(t), v = await f.registry.registerVault(f.root);
  assert.match(v.vaultId, /^[0-9a-f-]{36}$/); assert.notEqual(v.vaultId, v.environmentId);
  const d = JSON.parse(await readFile(f.descriptor));
  assert.deepEqual(Object.keys(d).sort(), ['schemaVersion','vaultId','displayName','createdAt','environmentId'].sort());
  assert.equal((await stat(f.descriptor)).mode & 0o777, 0o600);
  const next = new VaultRegistry(f.host);
  assert.equal((await next.listVaults())[0].lastValidation.result, 'valid');
  assert.equal((await next.resolveVault(v.vaultId)).canonicalRoot, f.root);
  assert.equal((await next.registerVault(f.root)).vaultId, v.vaultId);
  assert.equal(JSON.parse(await readFile(f.file)).revision, 2);
  assert.deepEqual(JSON.parse(await readFile(f.descriptor)), d);
});
test('unregister preserves descriptor and user contents; later registration reuses IDs', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'notes.md'), 'original');
  const v = await f.registry.registerVault(f.root), before = await readFile(f.descriptor, 'utf8');
  await f.registry.unregisterVault(v.vaultId); assert.deepEqual(await f.registry.listVaults(), []);
  await assert.rejects(f.registry.resolveVault(v.vaultId), code('not_registered'));
  assert.equal(await readFile(f.descriptor, 'utf8'), before);
  assert.equal(await readFile(join(f.root, 'notes.md'), 'utf8'), 'original');
  assert.equal((await f.registry.registerVault(f.root)).environmentId, v.environmentId);
});
test('same-object move accepted only after old path disappears', async t => {
  const f = await fixture(t), v = await f.registry.registerVault(f.root), moved = join(f.base, 'moved');
  await rename(f.root, moved); await assert.rejects(f.registry.resolveVault(v.vaultId));
  assert.equal((await f.registry.listVaults())[0].lastValidation.result, 'invalid');
  assert.equal((await f.registry.registerVault(moved)).vaultId, v.vaultId);
  assert.equal((await f.registry.resolveVault(v.vaultId)).canonicalRoot, moved);
});
test('copy collision and missing-original copy are never automatically adopted', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root); const copy = join(f.base, 'copy');
  await cp(f.root, copy, { recursive: true });
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(f.registry.registerVault(copy), code('identity_clone'));
  await rm(f.root, { recursive: true });
  await assert.rejects(f.registry.registerVault(copy), code('identity_unconfirmed'));
  assert.equal(await readFile(f.file, 'utf8'), before);
});
test('nested registered and unregistered descriptors rejected in both directions', async t => {
  const f = await fixture(t), child = join(f.root, 'child'); await mkdir(child);
  const v = await f.registry.registerVault(child);
  await assert.rejects(f.registry.registerVault(f.root), code('nested_vault'));
  await f.registry.unregisterVault(v.vaultId);
  await assert.rejects(f.registry.registerVault(f.root), code('nested_vault'));
  const grand = join(child, 'grand'); await mkdir(grand);
  await assert.rejects(f.registry.registerVault(grand), code('nested_vault'));
});
test('root, home, nonexistent paths, files, host storage and symlink components rejected', async t => {
  const f = await fixture(t); const file = join(f.base, 'file'); await writeFile(file, 'data');
  for (const p of ['/', homedir(), join(f.base, 'missing'), file, f.host]) await assert.rejects(f.registry.registerVault(p));
  const alias = join(f.base, 'alias'); await symlink(f.root, alias);
  await assert.rejects(f.registry.registerVault(alias));
  await mkdir(join(f.root, 'child')); await assert.rejects(f.registry.registerVault(join(alias, 'child')));
  await assert.rejects(f.registry.registerVault(alias + '/../vault'));
});
test('descriptor corruption, unknown schema and extra secret fields preserved', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  const original = JSON.parse(await readFile(f.descriptor));
  for (const text of ['{', JSON.stringify({...original, schemaVersion: 2}), JSON.stringify({...original, secret: 'test-only'})]) {
    await writeFile(f.descriptor, text); await assert.rejects(f.registry.registerVault(f.root));
    assert.equal(await readFile(f.descriptor, 'utf8'), text);
  }
});
test('descriptor symlinks and hardlinks and metadata symlinks rejected', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  const backup = join(f.base, 'descriptor'); await rename(f.descriptor, backup);
  await symlink(backup, f.descriptor); await assert.rejects(f.registry.registerVault(f.root)); await rm(f.descriptor);
  await link(backup, f.descriptor); await assert.rejects(f.registry.registerVault(f.root)); await rm(f.descriptor);
  await rm(join(f.root, '.nidus'), { recursive: true }); await symlink(f.base, join(f.root, '.nidus'));
  await assert.rejects(f.registry.registerVault(f.root));
});
test('registry corruption, unsupported schema, duplicate records and unsafe links block all APIs', async t => {
  const f = await fixture(t), v = await f.registry.registerVault(f.root);
  const original = JSON.parse(await readFile(f.file));
  for (const text of ['{', JSON.stringify({...original, schemaVersion: 2}), JSON.stringify({...original, vaults:[v,v]})]) {
    await writeFile(f.file, text);
    for (const action of [() => f.registry.listVaults(), () => f.registry.resolveVault(v.vaultId), () => f.registry.unregisterVault(v.vaultId), () => f.registry.registerVault(f.root)]) await assert.rejects(action());
    assert.equal(await readFile(f.file, 'utf8'), text);
  }
  const other = join(f.base, 'other'); await rename(f.file, other); await symlink(other, f.file);
  await assert.rejects(f.registry.listVaults());
});
test('same path filesystem object replacement rejected', async t => {
  const f = await fixture(t), v = await f.registry.registerVault(f.root), old = join(f.base, 'old');
  await rename(f.root, old); await cp(old, f.root, { recursive: true });
  await assert.rejects(f.registry.resolveVault(v.vaultId), code('root_replaced'));
  await assert.rejects(f.registry.registerVault(f.root), code('identity_unconfirmed'));
});
test('same environment across distinct vault IDs is rejected', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  const copy = join(f.base, 'copy'); await cp(f.root, copy, {recursive:true});
  const path = join(copy, '.nidus', 'vault.json'), d = JSON.parse(await readFile(path));
  d.vaultId = '00000000-0000-4000-8000-000000000000'; await writeFile(path, JSON.stringify(d));
  await assert.rejects(f.registry.registerVault(copy), code('environment_conflict'));
});
test('concurrent processes encounter exclusive host lock', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  let release, entered;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const original = f.registry.load.bind(f.registry);
  f.registry.load = async () => { entered(); await gate; return original(); };
  const held = f.registry.listVaults(); await ready;
  const script = `import {VaultRegistry} from ${JSON.stringify(new URL('../dist/vault/registry.js', import.meta.url).href)}; try { await new VaultRegistry(process.argv[1]).registerVault(process.argv[2]); process.exit(2); } catch(e) { console.log(e.code); process.exit(e.code === 'registry_locked' ? 0 : 3); }`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.host, f.root]); let out = '';
    child.stdout.on('data', d => out += d); child.on('error', reject); child.on('exit', c => resolve({c,out}));
  });
  release(); await held; assert.equal(result.c, 0); assert.match(result.out, /registry_locked/);
});
test('descriptor-only partial completion can be retried without changing identity', async t => {
  const f = await fixture(t); f.registry.save = async () => { throw new Error('injected pre-write failure'); };
  await assert.rejects(f.registry.registerVault(f.root)); const d = JSON.parse(await readFile(f.descriptor));
  const recovered = await new VaultRegistry(f.host).registerVault(f.root); assert.equal(recovered.vaultId, d.vaultId);
});
test('pending registry and stale locks fail closed after restart', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  await writeFile(join(f.host, 'registry.pending-test'), '{');
  await assert.rejects(new VaultRegistry(f.host).listVaults(), code('registry_interrupted'));
  await rm(join(f.host, 'registry.pending-test'));
  await assert.rejects(new VaultRegistry(f.host).listVaults(), code('registry_locked'));
});
test('interrupted descriptor publication is not overwritten', async t => {
  const f = await fixture(t); await mkdir(join(f.root, '.nidus')); const pending = join(f.root, '.nidus', 'vault.pending-test');
  await writeFile(pending, '{'); await assert.rejects(f.registry.registerVault(f.root), code('descriptor_interrupted'));
  assert.equal(await readFile(pending, 'utf8'), '{');
});
test('revision conflict preserves external change', async t => {
  const f = await fixture(t); const v = await f.registry.registerVault(f.root);
  const original = f.registry.save.bind(f.registry); const external = await readFile(f.file, 'utf8') + '\n';
  f.registry.save = async (s, raw, verify) => { await writeFile(f.file, external); return original(s, raw, verify); };
  await assert.rejects(f.registry.unregisterVault(v.vaultId), code('registry_revision_conflict'));
  assert.equal(await readFile(f.file, 'utf8'), external);
});
test('root replacement during registration prevents registry commit', async t => {
  const f = await fixture(t); const original = f.registry.save.bind(f.registry);
  f.registry.save = async (...args) => { await rename(f.root, join(f.base, 'old')); await mkdir(f.root); return original(...args); };
  await assert.rejects(f.registry.registerVault(f.root), code('root_replaced'));
  assert.deepEqual(await new VaultRegistry(f.host).listVaults(), []);
});
test('permission denied is propagated without descriptor overwrite', async t => {
  const f = await fixture(t); await chmod(f.root, 0o500);
  try { await assert.rejects(f.registry.registerVault(f.root), code('EACCES')); }
  finally { await chmod(f.root, 0o700); }
});
test('failure after staging registry retains old snapshot, pending bytes and lock', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root); const before = await readFile(f.file, 'utf8');
  const original = f.registry.save.bind(f.registry);
  f.registry.save = async (s, raw, verify) => {
    let calls = 0;
    return original(s, raw, async () => { await verify(); if (++calls === 2) throw new Error('injected interruption after fsync'); });
  };
  await assert.rejects(f.registry.registerVault(f.root)); assert.equal(await readFile(f.file, 'utf8'), before);
  await assert.rejects(new VaultRegistry(f.host).listVaults(), code('registry_locked'));
});
test('killed lock owner is not mistaken for successful recovery', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root);
  const script = `import {VaultRegistry} from ${JSON.stringify(new URL('../dist/vault/registry.js', import.meta.url).href)}; const r = new VaultRegistry(process.argv[1]); r.load = async () => { console.log('locked'); await new Promise(() => { setInterval(() => {}, 1000); }); }; await r.listVaults();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.host]);
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('early exit'))); });
  const exited = new Promise(r => child.once('exit', r)); child.kill('SIGKILL'); await exited;
  await assert.rejects(new VaultRegistry(f.host).listVaults(), code('registry_locked'));
});
test('old location returning during move blocks registry update', async t => {
  const f = await fixture(t); await f.registry.registerVault(f.root); const moved = join(f.base, 'moved'); await rename(f.root, moved);
  const before = await readFile(f.file, 'utf8'), original = f.registry.save.bind(f.registry);
  f.registry.save = async (...args) => { await cp(moved, f.root, { recursive: true }); return original(...args); };
  await assert.rejects(f.registry.registerVault(moved), code('identity_clone'));
  assert.equal(await readFile(f.file, 'utf8'), before);
});
test('host registry symlink and permissive storage directory rejected', async t => {
  const f = await fixture(t); const target = join(f.base, 'target'); await mkdir(target); await symlink(target, f.host);
  await assert.rejects(f.registry.listVaults()); await rm(f.host); await mkdir(f.host, {mode:0o755});
  await assert.rejects(f.registry.listVaults(), code('registry_permissions'));
});

const volumeA = '11111111-1111-4111-8111-111111111111';
const volumeB = '22222222-2222-4222-8222-222222222222';
async function alterRegistration(f, change) {
  const s = JSON.parse(await readFile(f.file)); change(s.vaults[0]); await writeFile(f.file, JSON.stringify(s));
}
test('stable volume UUID bridges device renumbering and returns current identity for native tools', async t => {
  const f = await fixture(t); const r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root);
  await alterRegistration(f, entry => { entry.identity.device = '999999'; });
  const before = await readFile(f.file, 'utf8');
  assert.deepEqual((await r.resolveVault(v.vaultId)).identity, v.identity);
  assert.equal((await r.listVaults())[0].lastValidation.result, 'valid');
  assert.equal(await readFile(f.file, 'utf8'), before, 'reads do not rewrite stored identity');
  assert.deepEqual((await r.registerVault(f.root)).identity, v.identity);
});
test('different volume UUID is rejected even if device/inode/birthtime match', async t => {
  const f = await fixture(t); const r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root), other = new VaultRegistry(f.host, async () => volumeB);
  for (const operation of [() => other.resolveVault(v.vaultId), () => other.registerVault(f.root), () => other.rebindVaultDevice(v.vaultId)]) {
    await assert.rejects(operation(), code('root_replaced'));
  }
});
test('legacy device drift requires explicit rebind and preserves descriptor and IDs', async t => {
  const f = await fixture(t); const r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root), descriptor = await readFile(f.descriptor, 'utf8');
  await alterRegistration(f, entry => { delete entry.volumeUuid; entry.identity.device = '999999'; });
  await assert.rejects(r.resolveVault(v.vaultId), code('root_replaced'));
  await assert.rejects(r.registerVault(f.root), code('identity_unconfirmed'));
  const repaired = await r.rebindVaultDevice(v.vaultId);
  assert.equal(repaired.volumeUuid, volumeA); assert.equal(repaired.environmentId, v.environmentId);
  assert.deepEqual(repaired.identity, v.identity);
  assert.equal(await readFile(f.descriptor, 'utf8'), descriptor);
  assert.equal((await r.resolveVault(v.vaultId)).vaultId, v.vaultId);
});
test('explicit device rebind rejects changed inode, birthtime or descriptor', async t => {
  const f = await fixture(t), r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root), original = await readFile(f.file, 'utf8');
  for (const field of ['inode', 'birthtimeNs']) {
    await writeFile(f.file, original);
    await alterRegistration(f, entry => { entry.identity[field] = '999999'; });
    const before = await readFile(f.file, 'utf8');
    await assert.rejects(r.rebindVaultDevice(v.vaultId), code('root_replaced'));
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
  await writeFile(f.file, original);
  const d = JSON.parse(await readFile(f.descriptor)); d.environmentId = volumeB;
  await writeFile(f.descriptor, JSON.stringify(d));
  await assert.rejects(r.rebindVaultDevice(v.vaultId), code('descriptor_identity_changed'));
  assert.equal(await readFile(f.file, 'utf8'), original);
});
test('unavailable volume identity and malformed persisted UUID fail closed', async t => {
  const f = await fixture(t), r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root);
  const unavailable = new VaultRegistry(f.host, async () => { throw new Error('unavailable'); });
  await assert.rejects(unavailable.resolveVault(v.vaultId));
  await assert.rejects(unavailable.rebindVaultDevice(v.vaultId));
  await alterRegistration(f, entry => { entry.volumeUuid = 'invalid'; });
  await assert.rejects(r.resolveVault(v.vaultId), code('registry_corrupt'));
});
test('root replacement during explicit rebind cannot publish updated registration', async t => {
  const f = await fixture(t), r = new VaultRegistry(f.host, async () => volumeA);
  const v = await r.registerVault(f.root), before = await readFile(f.file, 'utf8');
  const save = r.save.bind(r);
  r.save = async (...args) => { await rename(f.root, join(f.base, 'old')); await cp(join(f.base, 'old'), f.root, {recursive: true}); return save(...args); };
  await assert.rejects(r.rebindVaultDevice(v.vaultId), code('root_replaced'));
  assert.equal(await readFile(f.file, 'utf8'), before);
});
