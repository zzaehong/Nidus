import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile, rename, readdir, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { ExecutionAdmissionController, MockVMBackend, VaultRegistry } from '../dist/index.js';
import { ExecutionStore } from '../dist/vault/execution-store.js';
const code = c => e => e.code === c;
const request = () => ({ executionId: randomUUID(), requestedBy: 'worker:mock' });
const completed = { outcome: 'COMPLETED', resultId: 'result:test' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, behavior = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nidus-admission-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const host = join(base, 'host'), a = join(base, 'a'), b = join(base, 'b'); await mkdir(a); await mkdir(b);
  const registry = new VaultRegistry(host), va = await registry.registerVault(a), vb = await registry.registerVault(b);
  const backend = new MockVMBackend(behavior), controller = new ExecutionAdmissionController(registry, backend, { backendTimeoutMs: 100 });
  return { base, host, a, b, registry, va, vb, backend, controller, file: join(host, 'execution', 'state.json') };
}
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(5); }
  throw new Error('condition not reached');
}
async function queued(f, id) {
  await until(async () => {
    try { return JSON.parse(await readFile(f.file)).executions.some(e => e.executionId === id && e.state === 'QUEUED'); } catch { return false; }
  });
}
function child(t, f, vaultId, mode = 'normal') {
  const p = fork(new URL('./helpers/admission-child.mjs', import.meta.url), [f.host, vaultId, mode], { stdio: ['ignore','ignore','pipe','ipc'] });
  t.after(() => p.kill('SIGKILL'));
  return p;
}
function message(p) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('child timeout')); }, 5000);
    const cleanup = () => { clearTimeout(timer); p.off('message', got); p.off('exit', exit); };
    const got = x => { cleanup(); resolve(x); }, exit = c => { cleanup(); reject(new Error(`child exited ${c}`)); };
    p.once('message', got); p.once('exit', exit);
  });
}
async function kill(p) { const exited = new Promise(r => p.once('exit', r)); p.kill('SIGKILL'); await exited; }

test('Environment uses descriptor ID and separate versioned Host configuration', async t => {
  const f = await fixture(t), before = await readFile(join(f.a,'.nidus','vault.json'),'utf8');
  const env = await f.controller.getEnvironment(f.va.vaultId);
  assert.equal(env.environmentId, f.va.environmentId); assert.equal((await f.controller.getEnvironment(f.va.vaultId)).environmentId, env.environmentId);
  assert.notEqual((await f.controller.getEnvironment(f.vb.vaultId)).environmentId, env.environmentId);
  const updated = await f.controller.configureEnvironment(f.va.vaultId, {expectedVersion:1,enabled:false}); assert.equal(updated.configVersion,2);
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('environment_disabled'));
  await assert.rejects(f.controller.configureEnvironment(f.va.vaultId,{expectedVersion:1,enabled:true}),code('environment_revision_conflict'));
  assert.equal(await readFile(join(f.a,'.nidus','vault.json'),'utf8'),before); await f.controller.close();
});
test('execution, confirmed stop, reload and monotonic generation', async t => {
  const f = await fixture(t), l = await f.controller.acquire(f.va.vaultId,request());
  const status = await f.controller.getStatus(f.va.vaultId); assert.equal(status.instances[0].state,'RUNNING'); assert.equal(status.executions[0].state,'RUNNING');
  await f.controller.release(l,completed); await f.controller.close();
  const next = new ExecutionAdmissionController(f.registry,new MockVMBackend());
  const l2 = await next.acquire(f.va.vaultId,request()); assert.equal(l2.generation,l.generation+1); assert.notEqual(l2.vmInstanceId,l.vmInstanceId);
  const s = await next.getStatus(f.va.vaultId); assert.equal(s.instances[0].state,'STOP_CONFIRMED'); assert.equal(s.instances[0].stopEvidence.source,'mock');
  await next.release(l2,completed); await next.close();
});
test('same-owner FIFO prevents overlapping VM instances and waits for actual stop', async t => {
  const f = await fixture(t,{stopDelayMs:30}), ra = request(), rb = request(), rc = request();
  const a = await f.controller.acquire(f.va.vaultId,ra), order=[];
  const pb = f.controller.acquire(f.va.vaultId,rb).then(l => {order.push('b');return l;});
  const pc = f.controller.acquire(f.va.vaultId,rc).then(l => {order.push('c');return l;});
  await queued(f,rc.executionId); assert.equal(f.backend.events.filter(e=>e.operation==='start').length,1);
  const releasing = f.controller.release(a,completed); await sleep(5); assert.deepEqual(order,[]); await releasing;
  const b = await pb; assert.deepEqual(order,['b']); await f.controller.release(b,completed);
  const c = await pc; assert.deepEqual(order,['b','c']); await f.controller.release(c,completed); await f.controller.close();
});
test('global slot queues other Vault and stops previous VM before transfer', async t => {
  const f = await fixture(t), a = await f.controller.acquire(f.va.vaultId,request()), r = request();
  const pending = f.controller.acquire(f.vb.vaultId,r); await queued(f,r.executionId);
  assert.equal(f.backend.events.length,1); await f.controller.release(a,completed); const b = await pending;
  assert.notEqual(a.environmentId,b.environmentId); assert.deepEqual(f.backend.events.map(e=>e.operation),['start','stop','start']);
  await f.controller.release(b,completed); await f.controller.close();
});
test('queued cancellation preserves FIFO for remaining requests', async t => {
  const f=await fixture(t),a=await f.controller.acquire(f.va.vaultId,request()),rb=request(),rc=request();
  const pb=f.controller.acquire(f.va.vaultId,rb); const rejected=assert.rejects(pb,code('execution_cancelled'));
  const pc=f.controller.acquire(f.va.vaultId,rc); await queued(f,rc.executionId); await f.controller.cancel(rb.executionId); await rejected;
  await f.controller.release(a,completed); const c=await pc; await f.controller.release(c,completed);
  assert.equal((await f.controller.getStatus(f.va.vaultId)).executions[1].state,'CANCELLED'); await f.controller.close();
});
test('duplicate, foreign Vault, stale generation and tampered token leases rejected', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request());
  for(const bad of [{...l,vaultId:f.vb.vaultId},{...l,generation:l.generation-1},{...l,token:'wrong'},{...l,ownerId:randomUUID()}]) await assert.rejects(f.controller.release(bad,completed),code('invalid_lease'));
  await assert.rejects(f.controller.release(l,{...completed,stopConfirmed:true}),code('invalid_completion'));
  await f.controller.release(l,completed); await assert.rejects(f.controller.release(l,completed),code('invalid_lease'));
  const next=await f.controller.acquire(f.va.vaultId,request()); await assert.rejects(f.controller.release(l,completed),code('invalid_lease')); await f.controller.release(next,completed); await f.controller.close();
});
test('duplicate execution ID and environment changes during execution rejected', async t => {
  const f=await fixture(t),r=request(),l=await f.controller.acquire(f.va.vaultId,r);
  await assert.rejects(f.controller.acquire(f.va.vaultId,r),code('duplicate_execution'));
  await assert.rejects(f.controller.configureEnvironment(f.va.vaultId,{expectedVersion:1,enabled:false}),code('environment_busy'));
  await assert.rejects(f.controller.close(),code('admission_not_quiescent')); await f.controller.release(l,completed); await f.controller.close();
});
test('unregistered or moved-without-registration Vault cannot acquire', async t => {
  const f=await fixture(t); await f.registry.unregisterVault(f.va.vaultId);
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('not_registered'));
  await rename(f.b,join(f.base,'moved')); await assert.rejects(f.controller.acquire(f.vb.vaultId,request())); await f.controller.close();
});
test('queued Vault is revalidated before start; invalid request does not block healthy next request', async t => {
  const f=await fixture(t),a=await f.controller.acquire(f.va.vaultId,request()),r=request();
  const pending=f.controller.acquire(f.vb.vaultId,r), rejected=assert.rejects(pending,code('not_registered')); await queued(f,r.executionId);
  await f.registry.unregisterVault(f.vb.vaultId); await f.controller.release(a,completed); await rejected;
  assert.equal(f.backend.events.filter(e=>e.operation==='start').length,1); await f.controller.close();
});
test('start failure releases slot only after independent stop evidence', async t => {
  const f=await fixture(t,{start:'fail'}); await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('mock_start_failed'));
  const s=await f.controller.getStatus(f.va.vaultId); assert.equal(s.instances[0].state,'STOP_CONFIRMED'); assert.equal(s.executions[0].state,'FAILED');
  f.backend.behavior.start='success'; const l=await f.controller.acquire(f.va.vaultId,request()); await f.controller.release(l,completed); await f.controller.close();
});
test('start timeout cannot be reclaimed even if late start eventually succeeds', async t => {
  const f=await fixture(t,{startDelayMs:150}); await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('backend_timeout'));
  await sleep(80); const s=await f.controller.getStatus(f.va.vaultId); assert.equal(s.instances[0].state,'STOP_UNCONFIRMED');
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_quarantined'));
});
test('stop timeout keeps lease and global slot despite completed result', async t => {
  const f=await fixture(t,{stop:'hang'}),l=await f.controller.acquire(f.va.vaultId,request());
  await assert.rejects(f.controller.release(l,completed),code('execution_unconfirmed'));
  const raw=JSON.parse(await readFile(f.file)); assert.equal(raw.executions[0].completion.outcome,'COMPLETED'); assert.equal(raw.executions[0].state,'UNCONFIRMED'); assert.equal(raw.leases[0].released,false);
  await assert.rejects(f.controller.acquire(f.vb.vaultId,request()),code('admission_quarantined'));
});
test('running cancellation with uncertain stop never becomes CANCELLED', async t => {
  const f=await fixture(t,{stop:'fail'}),r=request(); await f.controller.acquire(f.va.vaultId,r);
  await assert.rejects(f.controller.cancel(r.executionId),code('execution_unconfirmed'));
  const s=await f.controller.getStatus(f.va.vaultId); assert.equal(s.executions[0].cancelRequested,true); assert.equal(s.executions[0].state,'UNCONFIRMED');
});
test('running cancellation becomes CANCELLED only with confirmed stop', async t => {
  const f=await fixture(t),r=request(); await f.controller.acquire(f.va.vaultId,r); await f.controller.cancel(r.executionId);
  assert.equal((await f.controller.getStatus(f.va.vaultId)).executions[0].state,'CANCELLED'); await f.controller.close();
});
test('backend control loss does not imply VM stop', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()); f.backend.loseControl();
  await assert.rejects(f.controller.release(l,completed),code('execution_unconfirmed')); assert.equal((await f.controller.getStatus(f.va.vaultId)).instances[0].state,'STOP_UNCONFIRMED');
});
test('Mock rejects duplicate starts/stops and cloned stop evidence', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()),v=(await f.controller.getStatus(f.va.vaultId)).instances[0];
  await assert.rejects(f.backend.start(v),code('mock_duplicate_start')); await f.controller.release(l,completed);
  await assert.rejects(f.backend.stop(v),code('mock_duplicate_stop')); assert.equal(f.backend.verifyStop(v,{...(await f.controller.getStatus(f.va.vaultId)).instances[0].stopEvidence}),false); await f.controller.close();
});
test('stale generation backend response is quarantined', async t => {
  const f=await fixture(t),start=f.backend.start.bind(f.backend); f.backend.start=async v=>({...await start(v),generation:0});
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('backend_identity_mismatch'));
  assert.equal((await f.controller.getStatus(f.va.vaultId)).instances[0].state,'STOP_UNCONFIRMED');
});
test('forged stop evidence cannot return slot', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()),stop=f.backend.stop.bind(f.backend);
  f.backend.stop=async v=>({...await stop(v),generation:0}); await assert.rejects(f.controller.release(l,completed),code('execution_unconfirmed'));
});
test('restart view does not adopt active state or accept previous leases', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()),other=new ExecutionAdmissionController(f.registry,new MockVMBackend());
  const s=await other.getStatus(f.va.vaultId); assert.equal(s.recordedInstances[0].state,'RUNNING'); assert.equal(s.instances[0].state,'STOP_UNCONFIRMED'); assert.equal(s.executions[0].state,'UNCONFIRMED');
  await assert.rejects(other.release(l,completed),code('admission_busy')); await f.controller.release(l,completed); await f.controller.close();
});
test('separate OS process cannot acquire either Vault while owner is active', async t => {
  const f=await fixture(t),p=child(t,f,f.va.vaultId),a=await message(p); assert.equal(a.kind,'acquired');
  for(const id of [f.va.vaultId,f.vb.vaultId]) { const q=child(t,f,id); const result=await message(q); assert.equal(result.code,'admission_busy'); }
  const done=message(p); p.send('release'); assert.equal((await done).kind,'closed');
  const l=await f.controller.acquire(f.vb.vaultId,request()); await f.controller.release(l,completed); await f.controller.close();
});
test('OS owner SIGKILL leaves durable active records and blocks restart', async t => {
  const f=await fixture(t),p=child(t,f,f.va.vaultId); assert.equal((await message(p)).kind,'acquired'); await kill(p);
  const s=await f.controller.getStatus(f.va.vaultId); assert.equal(s.instances[0].state,'STOP_UNCONFIRMED'); assert.equal(s.admissionBlocked,true);
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_busy')); assert.equal(JSON.parse(await readFile(f.file)).leases[0].released,false);
});
test('OS kill after staging leaves pending bytes, preserved lock and no auto recovery', async t => {
  const f=await fixture(t),p=child(t,f,f.va.vaultId,'crash-staging'); const staged=await message(p); assert.deepEqual(staged,{kind:'staged',pending:true}); await kill(p);
  assert.ok((await readdir(join(f.host,'execution'))).some(n=>n.startsWith('state.pending-')));
  await assert.rejects(f.controller.getStatus(f.va.vaultId),code('execution_write_interrupted'));
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_busy'));
});
test('corrupt state blocks fresh owner and preserves bytes', async t => {
  const f=await fixture(t); await f.controller.getEnvironment(f.va.vaultId); await f.controller.close(); await writeFile(f.file,'{');
  const next=new ExecutionAdmissionController(f.registry,new MockVMBackend()); await assert.rejects(next.acquire(f.va.vaultId,request()),code('execution_state_corrupt')); assert.equal(await readFile(f.file,'utf8'),'{');
});
test('environment mismatch with M1a and generation tampering block admission', async t => {
  const f=await fixture(t); await f.controller.getEnvironment(f.va.vaultId); await f.controller.close();
  const raw=JSON.parse(await readFile(f.file)); raw.environments[0].environmentId=randomUUID(); await writeFile(f.file,JSON.stringify(raw));
  const next=new ExecutionAdmissionController(f.registry,new MockVMBackend()); await assert.rejects(next.acquire(f.va.vaultId,request()),code('environment_mismatch')); await next.close();
  raw.ownerId=null; raw.environments[0].environmentId=f.va.environmentId; raw.environments[0].generation=7; await writeFile(f.file,JSON.stringify(raw));
  const last=new ExecutionAdmissionController(f.registry,new MockVMBackend()); await assert.rejects(last.acquire(f.va.vaultId,request()),code('execution_state_corrupt'));
});
test('deleted state with initialization marker and active record without lock cannot reset runtime', async t => {
  const f=await fixture(t); await f.controller.getEnvironment(f.va.vaultId); await f.controller.close(); await rm(f.file);
  const next=new ExecutionAdmissionController(f.registry,new MockVMBackend()); await assert.rejects(next.acquire(f.va.vaultId,request()),code('execution_state_missing'));
});
test('missing owner lock alone never frees a recorded active slot', async t => {
  const f=await fixture(t); await f.controller.acquire(f.va.vaultId,request()); await rm(join(f.host,'execution','admission.owner'),{recursive:true});
  const next=new ExecutionAdmissionController(f.registry,new MockVMBackend()); await assert.rejects(next.acquire(f.va.vaultId,request()),code('execution_recovery_required'));
});
test('external revision edit prevents backend stop and retains slot', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()); await writeFile(f.file,(await readFile(f.file,'utf8'))+'\n');
  await assert.rejects(f.controller.release(l,completed),code('execution_revision_conflict')); assert.equal(f.backend.events.filter(e=>e.operation==='stop').length,0);
});
test('state save failure before backend start never starts mock and preserves quarantine', async t => {
  const f=await fixture(t),save=ExecutionStore.prototype.save;
  ExecutionStore.prototype.save=async function(s){ if(s.instances.length) throw new Error('injected storage failure'); return save.call(this,s); };
  try { await assert.rejects(f.controller.acquire(f.va.vaultId,request()),/injected storage failure/); }
  finally { ExecutionStore.prototype.save=save; }
  assert.equal(f.backend.events.length,0); await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_quarantined'));
});
test('execution files reject symlink and hardlink substitution', async t => {
  const f=await fixture(t); await f.controller.getEnvironment(f.va.vaultId); await f.controller.close(); const original=join(f.base,'saved'); await rename(f.file,original);
  await symlink(original,f.file); await assert.rejects(f.controller.getStatus(f.va.vaultId)); await rm(f.file); await link(original,f.file);
  await assert.rejects(f.controller.getStatus(f.va.vaultId),code('execution_unsafe_file'));
});
test('simultaneous OS contenders produce exactly one owner; busy caller can retry after clean close', async t => {
  const f=await fixture(t),p=child(t,f,f.va.vaultId),q=child(t,f,f.vb.vaultId);
  const outcomes=await Promise.all([message(p),message(q)]);
  assert.equal(outcomes.filter(x=>x.kind==='acquired').length,1); assert.equal(outcomes.filter(x=>x.code==='admission_busy').length,1);
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_busy'));
  const winner=outcomes[0].kind==='acquired'?p:q,done=message(winner); winner.send('release'); assert.equal((await done).kind,'closed');
  const l=await f.controller.acquire(f.va.vaultId,request()); await f.controller.release(l,completed); await f.controller.close();
});
test('stop failure rejects pending acquisitions without resuming their durable queue', async t => {
  const f=await fixture(t,{stop:'fail'}),l=await f.controller.acquire(f.va.vaultId,request()),r=request();
  const pending=f.controller.acquire(f.vb.vaultId,r),rejected=assert.rejects(pending,code('execution_unconfirmed')); await queued(f,r.executionId);
  await assert.rejects(f.controller.release(l,completed),code('execution_unconfirmed')); await rejected;
  const raw=JSON.parse(await readFile(f.file)); assert.equal(raw.executions[1].state,'QUEUED'); assert.equal(f.backend.events.filter(e=>e.operation==='start').length,1);
});
test('failed start and failed stop preserve uncertain instance and lease', async t => {
  const f=await fixture(t,{start:'fail',stop:'fail'}); await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('mock_start_failed'));
  const s=await f.controller.getStatus(f.va.vaultId); assert.equal(s.instances[0].state,'STOP_UNCONFIRMED'); assert.equal(s.executions[0].state,'UNCONFIRMED');
});
test('save failure while recording start failure still settles acquire promise', {timeout:3000}, async t => {
  const f=await fixture(t,{start:'fail'}),save=ExecutionStore.prototype.save;
  ExecutionStore.prototype.save=async function(s){ if(s.instances.some(v=>v.state==='FAILED')) throw new Error('failure record unavailable'); return save.call(this,s); };
  try { await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('mock_start_failed')); }
  finally { ExecutionStore.prototype.save=save; }
  await assert.rejects(f.controller.acquire(f.va.vaultId,request()),code('admission_quarantined'));
});
test('stop confirmation that cannot be persisted does not release durable slot', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()),save=ExecutionStore.prototype.save;
  ExecutionStore.prototype.save=async function(s){ if(s.instances.some(v=>v.state==='STOP_CONFIRMED')) throw new Error('stop commit unavailable'); return save.call(this,s); };
  try { await assert.rejects(f.controller.release(l,completed),/stop commit unavailable/); }
  finally { ExecutionStore.prototype.save=save; }
  const raw=JSON.parse(await readFile(f.file)); assert.equal(raw.instances[0].state,'STOPPING'); assert.equal(raw.leases[0].released,false);
  assert.equal((await f.controller.getStatus(f.va.vaultId)).instances[0].state,'STOP_UNCONFIRMED');
  await assert.rejects(new ExecutionAdmissionController(f.registry,new MockVMBackend()).acquire(f.vb.vaultId,request()),code('admission_busy'));
});
test('late stop success after timeout never clears quarantine', async t => {
  const f=await fixture(t,{stopDelayMs:150}),l=await f.controller.acquire(f.va.vaultId,request());
  await assert.rejects(f.controller.release(l,completed),code('execution_unconfirmed')); await sleep(80);
  assert.equal(JSON.parse(await readFile(f.file)).leases[0].released,false); await assert.rejects(f.controller.close(),code('admission_quarantined'));
});
test('lease bearer token is never persisted and cancellation does not accept a different execution ID', async t => {
  const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request());
  assert.equal((await readFile(f.file,'utf8')).includes(l.token),false);
  await assert.rejects(f.controller.cancel(randomUUID()),code('execution_not_found')); await f.controller.release(l,completed); await f.controller.close();
});
test('unsupported policy and mismatched lease ownership are rejected on reload', async t => {
  for(const mutate of [s=>{s.policy.maxActiveVMs=2;},s=>{s.leases[0].generation=0;},s=>{s.instances[0].stopEvidence=null;}]) {
    const f=await fixture(t),l=await f.controller.acquire(f.va.vaultId,request()); await f.controller.release(l,completed); await f.controller.close();
    const s=JSON.parse(await readFile(f.file)); mutate(s); await writeFile(f.file,JSON.stringify(s));
    await assert.rejects(new ExecutionAdmissionController(f.registry,new MockVMBackend()).acquire(f.va.vaultId,request()),code('execution_state_corrupt'));
  }
});
