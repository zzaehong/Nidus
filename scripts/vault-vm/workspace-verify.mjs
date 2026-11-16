// Explicit real VM test; arguments: verified assets directory, new evidence output path.
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';import assert from 'node:assert/strict';
import {VaultRegistry} from '../../dist/vault/registry.js';
import {VMJournal} from '../../dist/vault/vm-journal.js';
import {SharedVMController} from '../../dist/vault/shared-vm.js';
import {AppleOfflineBackend} from '../../dist/vault/apple-backend.js';
const base=await realpath(await mkdtemp('/private/tmp/nidus-workspace-real-'));await mkdir(join(base,'vault'));await writeFile(join(base,'vault','main.py'),'print(1)\n');
const registry=new VaultRegistry(join(base,'registry')),vault=await registry.registerVault(join(base,'vault'));
const runtime=new SharedVMController(registry,new VMJournal(join(base,'runtime')),()=>new AppleOfflineBackend(process.argv[2]));
const evidence={scope:'Synthetic Vault, real Apple VM, programmatic test approval (not user approval)',results:[]};
try{
 await runtime.initialize();for(let i=0;i<2;i++){
 const p=await runtime.propose(vault.vaultId,'task'+i,'call','python3 main.py; printf "print(2)\\n" > main.py',['main.py']);const r=await runtime.executeApproved(p.approvalId);assert.equal(r.stdout,'1\n');assert.equal(r.workspaceReview[0].conflict,false);assert.equal(r.workspaceReview[0].hostApplyEnabled,false);assert.equal(await readFile(join(base,'vault','main.py'),'utf8'),'print(1)\n');evidence.results.push(r);
 }assert.equal(evidence.results[0].vmInstanceId,evidence.results[1].vmInstanceId);assert.equal(evidence.results[0].generation,evidence.results[1].generation);evidence.status='PASS';
}catch(e){evidence.status='FAIL';evidence.error=String(e);process.exitCode=1;}finally{try{await runtime.close();evidence.stop='STOP_CONFIRMED';}catch(e){evidence.stop=String(e);process.exitCode=1;}await writeFile(process.argv[3],JSON.stringify(evidence,null,2));if(evidence.stop==='STOP_CONFIRMED')await rm(base,{recursive:true,force:true});}
