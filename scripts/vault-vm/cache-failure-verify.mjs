// Deliberate failures on synthetic disks only; never reclaim unconfirmed ownership.
import {mkdtemp,mkdir,realpath,writeFile,open} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
import {VaultRegistry} from '../../dist/vault/registry.js';import {VMJournal} from '../../dist/vault/vm-journal.js';import {CacheDiskStore} from '../../dist/vault/cache-disk.js';import {SharedVMController} from '../../dist/vault/shared-vm.js';import {AppleOfflineBackend} from '../../dist/vault/apple-backend.js';
const base=await realpath(await mkdtemp('/private/tmp/nidus-cache-failure-'));await mkdir(join(base,'vault'));const registry=new VaultRegistry(join(base,'registry')),v=await registry.registerVault(join(base,'vault')),cache=new CacheDiskStore(join(base,'disks'));let backend;const events=[];
const runtime=new SharedVMController(registry,new VMJournal(join(base,'runtime')),()=>{backend=new AppleOfflineBackend(process.argv[2]);backend.listeners.add(e=>events.push(e));return backend;},300000,cache);
const evidence={scope:'Synthetic cache corruption and deliberately killed test Manager; no recovery',directory:base,events};
try{
 await runtime.initialize();await runtime.start(v.vaultId);await runtime.stop();
 const disk=join(cache.directory,v.vaultId+'-'+v.environmentId,'cache.raw');const f=await open(disk,'r+');try{await f.write(Buffer.from([0,0]),0,2,1080);await f.sync();}finally{await f.close();}
 await assert.rejects(runtime.start(v.vaultId));assert.ok(events.some(e=>e.line==='NIDUS_BLOCKED cache-filesystem'));assert.equal((await runtime.cacheStatus(v.vaultId)).state,'dirty');const check=await open(disk);try{const b=Buffer.alloc(2);await check.read(b,0,2,1080);assert.deepEqual([...b],[0,0]);}finally{await check.close();}evidence.corruptionBlockedWithoutRepair=true;
 await runtime.clearCache(v.vaultId);await runtime.start(v.vaultId);
 const lost=new Promise(resolve=>backend.listeners.add(e=>{if(e.event==='lost')resolve();}));backend.child.kill('SIGKILL');await lost;
 assert.equal(runtime.status().state,'STOP_UNCONFIRMED');await assert.rejects(runtime.start(v.vaultId),/STOP_UNCONFIRMED/);await assert.rejects(runtime.clearCache(v.vaultId),/STOP_UNCONFIRMED/);await assert.rejects(new CacheDiskStore(cache.directory).acquire(v.vaultId,v.environmentId),/owned_or_unconfirmed/);
 evidence.managerDeathBlocked=true;evidence.status='PASS';evidence.stop='STOP_UNCONFIRMED (expected; retained owner and disk)';
}catch(e){evidence.status='FAIL';evidence.error=String(e);process.exitCode=1;try{await runtime.close();}catch{}}
await writeFile(process.argv[3],JSON.stringify(evidence,null,2));
