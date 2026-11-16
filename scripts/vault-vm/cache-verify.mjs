// Real VM test: verified assets directory, new evidence destination. Synthetic data only.
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import assert from 'node:assert/strict';
import {VaultRegistry} from '../../dist/vault/registry.js';
import {VMJournal} from '../../dist/vault/vm-journal.js';
import {CacheDiskStore} from '../../dist/vault/cache-disk.js';
import {SharedVMController} from '../../dist/vault/shared-vm.js';
import {AppleOfflineBackend} from '../../dist/vault/apple-backend.js';
const base=await realpath(await mkdtemp('/private/tmp/nidus-cache-real-'));await mkdir(join(base,'vault'));await mkdir(join(base,'other'));
const registry=new VaultRegistry(join(base,'registry')),v=await registry.registerVault(join(base,'vault')),other=await registry.registerVault(join(base,'other'));
const events=[];
const cache=new CacheDiskStore(join(base,'disks'));let backend;
const runtime=new SharedVMController(registry,new VMJournal(join(base,'runtime')),()=>{backend=new AppleOfflineBackend(process.argv[2]);backend.listeners.add(e=>events.push(e));return backend;},300000,cache);
const evidence={scope:'Real Apple VM, synthetic per-Vault cache, programmatic test approvals only',cases:[],events};
async function run(vault,command){const p=await runtime.propose(vault.vaultId,crypto.randomUUID(),crypto.randomUUID(),command);const r=await runtime.executeApproved(p.approvalId);evidence.cases.push(r);assert.equal(r.exitCode,0);assert.equal(r.cleanupConfirmed,true);return r;}
try{
 await runtime.initialize();
 await run(v,'set -eu; test -d /cache; test ! -e /dev/vda; test ! -e /persistent; python3 -m pip cache dir; npm config get cache; mkdir -p /cache/npm /cache/pip; printf cached > /cache/pip/proof; printf temporary > /tmp/session-proof; printf synthetic > /home/session-auth');
 await run(v,`set -eu
mkdir -p /cache/artifacts /work/pkg
printf '{"name":"nidus-cache-fixture","version":"1.0.0","main":"index.js"}' > /work/pkg/package.json
printf 'module.exports = 42;' > /work/pkg/index.js
cd /work/pkg
npm pack --offline --pack-destination /cache/artifacts
npm cache add --offline /cache/artifacts/nidus-cache-fixture-1.0.0.tgz
python3 - <<'PYTHON'
import zipfile
with zipfile.ZipFile('/cache/artifacts/nidus_cache_fixture-1.0-py3-none-any.whl','w') as z:
 z.writestr('nidus_cache_fixture.py','value = 42\\n')
 z.writestr('nidus_cache_fixture-1.0.dist-info/METADATA','Metadata-Version: 2.1\\nName: nidus-cache-fixture\\nVersion: 1.0\\n')
 z.writestr('nidus_cache_fixture-1.0.dist-info/WHEEL','Wheel-Version: 1.0\\nGenerator: nidus-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
 z.writestr('nidus_cache_fixture-1.0.dist-info/RECORD','')
PYTHON`);
 await run(v,"setsid bash -c 'sleep 60 & wait' >/tmp/background.log 2>&1 &");
 const first=runtime.status();await runtime.stop();assert.equal((await runtime.cacheStatus(v.vaultId)).state,'clean');
 await run(v,'set -eu; test "$(cat /cache/pip/proof)" = cached; test ! -e /tmp/session-proof; test ! -e /home/session-auth; test ! -e /tmp/background.log; printf persisted');assert.notEqual(runtime.status().vmInstanceId,first.vmInstanceId);
 await run(v,`set -eu
npm cache verify
npm install --offline --ignore-scripts --no-audit --no-fund /cache/artifacts/nidus-cache-fixture-1.0.0.tgz
node -e "if(require('nidus-cache-fixture')!==42)process.exit(1)"
python3 -m pip install --no-index --no-deps --target /work/site /cache/artifacts/nidus_cache_fixture-1.0-py3-none-any.whl
PYTHONPATH=/work/site python3 -c 'import nidus_cache_fixture; assert nidus_cache_fixture.value == 42'
`);await runtime.stop();
 await run(other,'set -eu; test ! -e /cache/pip/proof; printf isolated');await runtime.stop();
 await runtime.clearCache(v.vaultId);assert.equal((await runtime.cacheStatus(v.vaultId)).state,'absent');
 await run(v,'set -eu; test ! -e /cache/pip/proof; printf cleared');await runtime.stop();
 await runtime.start(v.vaultId);
 const closed=backend.wait(e=>e.event==='closed',12000);backend.child.stdin.write('force-stop\n');await closed;await runtime.stop();
 assert.equal((await runtime.cacheStatus(v.vaultId)).state,'dirty');await assert.rejects(runtime.start(v.vaultId),/cache_dirty/);evidence.forceStopDirtyBlocked=true;
 await runtime.clearCache(v.vaultId);
 evidence.status='PASS';
}catch(e){evidence.status='FAIL';evidence.error=String(e);process.exitCode=1;}finally{try{await runtime.close();evidence.stop='STOP_CONFIRMED';}catch(e){evidence.stop=String(e);process.exitCode=1;}evidence.retainedTestDirectory=base;await writeFile(process.argv[3],JSON.stringify(evidence,null,2));if(evidence.stop==='STOP_CONFIRMED')await rm(base,{recursive:true,force:true});else evidence.retainedTestDirectory=base;}
