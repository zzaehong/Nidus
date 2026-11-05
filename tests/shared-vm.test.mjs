import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,realpath,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {VaultRegistry} from '../dist/vault/registry.js';import {SharedVMController} from '../dist/vault/shared-vm.js';import {VMJournal} from '../dist/vault/vm-journal.js';
class Backend {
 starts=0;stops=0;commands=[];pending=[];auto=true;failStart=false;failStop=false;
 async start(){this.starts++;if(this.failStart)throw Error('start');}
 execute(id,command){this.commands.push(command);return new Promise(resolve=>{this.pending.push({id,resolve});if(this.auto)this.finish();});}
 finish(clean=true,reason='completed'){this.pending.shift().resolve({exitCode:0,stdout:'ok',stderr:'',cleanupConfirmed:clean,reason,memoryPeakBytes:123});}
 cancel(){this.finish(true,'cancelled');}
 async stop(){this.stops++;if(this.failStop)throw Error('stop');}
}
async function fixture(t){const base=await realpath(await mkdtemp(join(tmpdir(),'nidus-m4-')));t.after(()=>rm(base,{recursive:true,force:true}));await mkdir(join(base,'vault'));await mkdir(join(base,'other'));const registry=new VaultRegistry(join(base,'host')),v=await registry.registerVault(join(base,'vault')),other=await registry.registerVault(join(base,'other'));const journal=new VMJournal(join(base,'runtime')),backend=new Backend(),runtime=new SharedVMController(registry,journal,()=>backend);await runtime.initialize();return {base,registry,v,other,journal,backend,runtime};}
const propose=(f,task='task',call='call')=>f.runtime.propose(f.v.vaultId,task,call,'echo safe');
const wait=async p=>{for(let i=0;i<1000&&!p();i++)await new Promise(r=>setTimeout(r,1));assert.ok(p());};
test('M4 Host policy: same environment and VM reused across sessions; global limit',async t=>{const f=await fixture(t);const a=await f.runtime.start(f.v.vaultId),b=await f.runtime.start(f.v.vaultId);assert.equal(a.environmentId,f.v.environmentId);assert.equal(a.vmInstanceId,b.vmInstanceId);assert.equal(f.backend.starts,1);await assert.rejects(f.runtime.start(f.other.vaultId),/vm_global_limit/);const p=await propose(f),r=await f.runtime.executeApproved(p.approvalId);const q=await propose(f,'two'),s=await f.runtime.executeApproved(q.approvalId);assert.equal(r.vmInstanceId,s.vmInstanceId);assert.equal(f.backend.stops,0);await f.runtime.close();assert.equal(f.backend.stops,1);});
test('M4 Host policy: FIFO waits for cleanup and queued task cancellation',async t=>{const f=await fixture(t);f.backend.auto=false;const a=await propose(f,'a'),b=await propose(f,'b'),c=await propose(f,'c');const pa=f.runtime.executeApproved(a.approvalId);await wait(()=>f.backend.pending.length===1);const pb=f.runtime.executeApproved(b.approvalId),pc=f.runtime.executeApproved(c.approvalId);const rejected=assert.rejects(pb,/cancelled/);await wait(()=>f.runtime.status().queued===2);assert.equal(f.backend.commands.length,1);await f.runtime.cancel('b');await rejected;f.backend.finish();await pa;await wait(()=>f.backend.commands.length===2);f.backend.finish();await pc;assert.deepEqual(f.runtime.status().sessions.map(s=>s.state),['COMPLETED','CANCELLED','COMPLETED']);await f.runtime.close();});
test('M4 Host policy: one-use approval and persistent invocation replay rejection',async t=>{const f=await fixture(t),p=await propose(f);await f.runtime.executeApproved(p.approvalId);await assert.rejects(f.runtime.executeApproved(p.approvalId),/approval_invalid/);const q=await propose(f);await assert.rejects(f.runtime.executeApproved(q.approvalId),/duplicate_invocation/);await f.runtime.close();const next=new SharedVMController(f.registry,new VMJournal(f.journal.directory),()=>new Backend());await next.initialize();const r=await next.propose(f.v.vaultId,'task','call','echo safe');await assert.rejects(next.executeApproved(r.approvalId),/duplicate_invocation/);await next.close();});
test('M4 Host policy: cleanup uncertainty quarantines VM and prevents next execution',async t=>{const f=await fixture(t);f.backend.auto=false;const p=await propose(f),run=f.runtime.executeApproved(p.approvalId);const rejected=assert.rejects(run,/session_cleanup_unconfirmed/);await wait(()=>f.backend.pending.length===1);f.backend.finish(false);await rejected;assert.equal(f.runtime.status().state,'STOP_UNCONFIRMED');await assert.rejects(f.runtime.start(f.v.vaultId),/STOP_UNCONFIRMED/);await assert.rejects(f.runtime.close());});
test('M4 Host policy: cancellation confirms guest cleanup before releasing session',async t=>{const f=await fixture(t);f.backend.auto=false;const p=await propose(f),run=f.runtime.executeApproved(p.approvalId);await wait(()=>f.backend.pending.length===1);await f.runtime.cancel('task');assert.equal((await run).reason,'cancelled');assert.equal(f.runtime.status().activeSession,null);await f.runtime.close();});
test('M4 Host policy: start failure stops backend; unconfirmed stop remains blocked',async t=>{const f=await fixture(t);f.backend.failStart=true;await assert.rejects(f.runtime.start(f.v.vaultId));assert.equal(f.runtime.status().state,'STOP_CONFIRMED');await f.runtime.close();const g=await fixture(t);await g.runtime.start(g.v.vaultId);g.backend.failStop=true;await assert.rejects(g.runtime.stop());assert.equal(g.runtime.status().state,'STOP_UNCONFIRMED');await assert.rejects(g.runtime.start(g.v.vaultId));});
test('M4 Host journal: owner loss, corrupt bytes and interrupted records never reclaim',async t=>{const f=await fixture(t);await assert.rejects(new VMJournal(f.journal.directory).claim(),/owned_or_unconfirmed/);await writeFile(join(f.journal.directory,'state.json'),'bad',{mode:0o600});await assert.rejects(f.journal.read(),/vm_state_corrupt/);const g=await fixture(t);await writeFile(join(g.journal.directory,'pending-interrupted'),'partial',{mode:0o600});await assert.rejects(g.journal.read(),/vm_write_interrupted/);});
test('M4 Host policy: unregistered and cancelled proposals never start a session',async t=>{const f=await fixture(t);const p=await propose(f);await f.runtime.cancel('task');await assert.rejects(f.runtime.executeApproved(p.approvalId));await f.registry.unregisterVault(f.v.vaultId);await assert.rejects(f.runtime.start(f.v.vaultId));assert.equal(f.backend.commands.length,0);await f.runtime.close();});
test('M4 Host journal: revision conflict blocks dispatch before a side effect',async t=>{const f=await fixture(t);const p=await propose(f);const path=join(f.journal.directory,'state.json'),state=JSON.parse(await readFile(path,'utf8'));state.revision++;await writeFile(path,JSON.stringify(state),{mode:0o600});await assert.rejects(f.runtime.executeApproved(p.approvalId),/vm_revision_conflict/);assert.equal(f.backend.commands.length,0);});
test('M4 Host journal: second OS process cannot claim live manager ownership',async t=>{
 const f=await fixture(t);const {spawn}=await import('node:child_process');
 const code=`import {VMJournal} from './dist/vault/vm-journal.js';try{await new VMJournal(process.argv[1]).claim();process.exitCode=1;}catch(e){if(e.code!=='vm_manager_owned_or_unconfirmed')process.exitCode=2;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.journal.directory],{stdio:'ignore'});assert.equal(await new Promise(r=>child.once('exit',r)),0);await f.runtime.close();
});
test('M4 Host policy: configured idle stop never stops an active session',async t=>{
 const f=await fixture(t);await f.runtime.close();const backend=new Backend();backend.auto=false;const runtime=new SharedVMController(f.registry,new VMJournal(f.journal.directory),()=>backend,100);await runtime.initialize();const p=await runtime.propose(f.v.vaultId,'idle','call','echo test'),run=runtime.executeApproved(p.approvalId);await wait(()=>backend.pending.length===1);await new Promise(r=>setTimeout(r,150));assert.equal(backend.stops,0);backend.finish();await run;await wait(()=>backend.stops===1);await runtime.close();
});
test('M4 Host journal: old generation and instance mismatch are rejected',async t=>{const f=await fixture(t);await f.runtime.start(f.v.vaultId);const p=await propose(f);await f.runtime.executeApproved(p.approvalId);await f.runtime.close();const path=join(f.journal.directory,'state.json'),s=JSON.parse(await readFile(path,'utf8'));s.sessions[0].generation=s.generation+1;await writeFile(path,JSON.stringify(s),{mode:0o600});await assert.rejects(f.journal.read(),/vm_state_corrupt/);});
test('M4 Host policy: queued approval expiry blocks command dispatch',async t=>{
 const f=await fixture(t);f.backend.auto=false;const a=await propose(f,'first'),pa=f.runtime.executeApproved(a.approvalId);await wait(()=>f.backend.pending.length===1);
 const b=await propose(f,'expired');f.runtime.proposals.get(b.approvalId).expiresAt=Date.now()+150;const pb=f.runtime.executeApproved(b.approvalId);const rejected=assert.rejects(pb,/approval_expired/);await wait(()=>f.runtime.status().queued===1);await new Promise(r=>setTimeout(r,175));f.backend.finish();await pa;await rejected;assert.equal(f.backend.commands.length,1);await f.runtime.close();
});
test('M4 Host policy: stop cannot interleave between VM start and admission',async t=>{
 const f=await fixture(t);f.backend.auto=false;let ready;f.backend.start=()=>new Promise(r=>{ready=r;});const p=await propose(f),run=f.runtime.executeApproved(p.approvalId);await wait(()=>!!ready);const stopped=assert.rejects(f.runtime.stop(),/vm_execution_active/);ready();await stopped;await wait(()=>f.backend.pending.length===1);f.backend.finish();await run;await f.runtime.close();
});
test('Workspace approval binds selected files and returns review without Host mutation',async t=>{
 const f=await fixture(t);await writeFile(join(f.base,'vault','main.py'),'print(1)');
 let payload;f.backend.execute=async(id,command,seconds,options)=>{payload=JSON.parse(options.workspace);return {exitCode:0,stdout:'2',stderr:'',cleanupConfirmed:true,reason:'completed',memoryPeakBytes:1,workspaceStatus:'complete',workspace:[{path:'main.py',content:'print(2)'}]};};
 const p=await f.runtime.propose(f.v.vaultId,'project','call','python3 main.py',['main.py']);
 assert.deepEqual(p.workspace.paths,['main.py']);assert.equal(payload,undefined);
 const r=await f.runtime.executeApproved(p.approvalId);assert.equal(payload.files[0].content,'print(1)');assert.equal(r.workspace,undefined);assert.equal(r.workspaceReview[0].hostApplyEnabled,false);assert.equal(r.workspaceReview[0].conflict,false);
 assert.equal(await readFile(join(f.base,'vault','main.py'),'utf8'),'print(1)');await f.runtime.close();
});
test('Workspace changed after approval proposal is never dispatched',async t=>{
 const f=await fixture(t);await writeFile(join(f.base,'vault','main.py'),'print(1)');const p=await f.runtime.propose(f.v.vaultId,'project','call','python3 main.py',['main.py']);await writeFile(join(f.base,'vault','main.py'),'print(3)');
 await assert.rejects(f.runtime.executeApproved(p.approvalId),/workspace_source_changed/);assert.equal(f.backend.commands.length,0);assert.equal(f.runtime.status().state,'RUNNING');await f.runtime.close();
});
test('cache lifecycle: only verified guest flush plus VM stop permits reuse; deletion requires stopped VM',async t=>{
 const {CacheDiskStore}=await import('../dist/vault/cache-disk.js');const f=await fixture(t);await f.runtime.close();const cache=new CacheDiskStore(join(f.base,'disks'));const backend=new Backend();backend.cacheClean=false;const runtime=new SharedVMController(f.registry,new VMJournal(f.journal.directory),()=>backend,300000,cache);await runtime.initialize();await runtime.start(f.v.vaultId);await assert.rejects(runtime.clearCache(f.v.vaultId),/must_stop/);await runtime.stop();assert.equal((await runtime.cacheStatus(f.v.vaultId)).state,'dirty');await assert.rejects(runtime.start(f.v.vaultId),/cache_dirty/);assert.equal(runtime.status().state,'STOP_CONFIRMED');await runtime.clearCache(f.v.vaultId);backend.cacheClean=true;await runtime.start(f.v.vaultId);await runtime.stop();assert.equal((await runtime.cacheStatus(f.v.vaultId)).state,'clean');await runtime.close();
});

test('browser Host proposal: feature gate, immutable URL binding and cancellation before dispatch',async t=>{
 const f=await fixture(t);await assert.rejects(f.runtime.proposeBrowser(f.v.vaultId,'web','call','browser_navigate','https://example.com/'),/browser_unsupported/);await f.runtime.close();
 const runtime=new SharedVMController(f.registry,new VMJournal(f.journal.directory),()=>f.backend,300000,undefined,true);await runtime.initialize();
 const p=await runtime.proposeBrowser(f.v.vaultId,'web','call','browser_navigate','https://example.com/');
 assert.equal(p.cachePersistent,false);assert.equal(p.tool,'browser_navigate');assert.equal(f.backend.starts,0);assert.equal(runtime.status().sessions.length,0);
 p.browser.url='https://127.0.0.1/';assert.equal(runtime.proposals.get(p.approvalId).browser.url,'https://example.com/');
 await runtime.cancel('web');await assert.rejects(runtime.executeApproved(p.approvalId),/approval_invalid/);assert.equal(f.backend.commands.length,0);await runtime.close();
});

test('interactive browser reserves VM, binds task ownership and confirms cleanup',async t=>{
 const f=await fixture(t);await f.runtime.close();const b=f.backend;
 b.beginLive=async(id,listener)=>{b.liveListener=listener;};b.sendLive=async m=>{if(m.op!=='response')b.liveListener({event:'result',id:m.id,value:{snapshotId:'s',url:'https://www.bing.com/',title:'fixture',text:'',elements:[],sandboxVerified:true}});};b.endLive=async()=>{b.liveListener({event:'ended'});b.closed=true;};
 const runtime=new SharedVMController(f.registry,new VMJournal(f.journal.directory),()=>b,300000,undefined,true,true);await runtime.initialize();
 await assert.rejects(runtime.openLive(f.v.vaultId,'denied','call',async()=>false),/permission_denied/);assert.equal(b.starts,0);
 await runtime.openLive(f.v.vaultId,'live','call',async p=>p.scope==='session');
 await assert.rejects(runtime.liveAction(f.v.vaultId,'other',{op:'observe'},async()=>true),/session_owner/);
 await assert.rejects(runtime.liveFrame(f.other.vaultId,'live'),/session_owner/);
 await assert.rejects(runtime.stop(),/execution_active/);
 await assert.rejects(runtime.liveAction(f.v.vaultId,'live',{op:'navigate',url:'https://example.com/'},async()=>false),/permission_denied/);
 await runtime.closeLive(f.v.vaultId,'live');assert.equal(b.closed,true);assert.equal(runtime.status().sessions.at(-1).cleanupConfirmed,true);await runtime.close();
});
