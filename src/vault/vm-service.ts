// Trusted, single-owner local service. No Provider keys; selected Vault contents enter only via the validated Workspace gateway.
import {createServer} from 'node:net';
import {chmod,unlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {VaultRegistry} from './registry.js';
import {CacheDiskStore} from './cache-disk.js';
import {SharedVMController} from './shared-vm.js';
import {VMJournal,durableFile} from './vm-journal.js';
import {VaultError} from './types.js';
import type {LiveApprover} from './live-browser.js';
export async function serve(registryPath:string){
 const registry=new VaultRegistry(registryPath),directory=join(registry.directory,'vm-runtime');
 let cache:CacheDiskStore|undefined,browser=false,interactive=false;try{const manifest=JSON.parse(await readFile(new URL('../vm-assets/manifest.json',import.meta.url),'utf8'));if(manifest.cacheDiskVersion===1)cache=new CacheDiskStore(join(directory,'cache-disks'));browser=manifest.profile==='development'&&manifest.browserSnapshotVersion===1;interactive=manifest.profile==='development'&&manifest.browserInteractiveVersion===1;}catch{}
 const controller=new SharedVMController(registry,new VMJournal(directory),undefined,Number(process.env.NIDUS_VM_IDLE_MS??300000),cache,browser,interactive);await controller.initialize();
 const approvals=new Map<string,{executionId:string;answer:(yes:boolean)=>void}>();
 const token=randomBytes(32).toString('hex');await durableFile(join(directory,'owner','token'),token);
 const path=join(directory,'control.sock');if(Buffer.byteLength(path)>=104)throw new VaultError('vm_socket_path_limit');
 // An old socket is removed only after an exclusive clean Journal claim, never after owner death.
 await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const server=createServer(socket=>{
  socket.setEncoding('utf8');let cancelExecution:string|null=null;socket.on('close',()=>{if(cancelExecution)void controller.cancel(cancelExecution).catch(()=>{});});
  let bytes=0,buffer='',accepted=false;socket.setTimeout(90000,()=>socket.destroy());
  const approve:LiveApprover=(p,signal)=>new Promise(resolve=>{
   if(socket.destroyed||signal.aborted||approvals.size>=128){resolve(false);return;}
   const done=(yes:boolean)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);socket.removeListener('close',cancel);approvals.delete(p.approvalId);resolve(yes&&Date.now()<p.expiresAt);};const cancel=()=>done(false),timer=setTimeout(cancel,Math.max(0,p.expiresAt-Date.now()));
   approvals.set(p.approvalId,{executionId:p.executionId,answer:done});signal.addEventListener('abort',cancel,{once:true});socket.once('close',cancel);socket.write(JSON.stringify({event:'approval',proposal:p})+'\n');
  });
  socket.on('error',()=>{});socket.on('data',chunk=>{
   bytes+=Buffer.byteLength(chunk);if(bytes>65536){socket.destroy();return;}buffer+=chunk.toString('utf8');if(!buffer.includes('\n')||accepted)return;accepted=true;
   void (async()=>{
    const r=JSON.parse(buffer),provided=Buffer.from(typeof r.token==='string'?r.token:'');
    if(provided.length!==64||!timingSafeEqual(provided,Buffer.from(token)))throw new VaultError('vm_unauthorized');
    switch(r.method){
     case 'live-answer':{const p=approvals.get(r.approvalId);if(!p||p.executionId!==r.executionId)throw new VaultError('browser_approval_invalid');p.answer(r.approved===true);return {accepted:true};}
     case 'live-open':cancelExecution=r.executionId;return controller.openLive(r.vaultId,r.executionId,r.callId,approve,r.url);
     case 'live-frame':return controller.liveFrame(r.vaultId,r.executionId);
     case 'live-action':cancelExecution=r.executionId;return controller.liveAction(r.vaultId,r.executionId,r.action,approve);
     case 'live-close':return controller.closeLive(r.vaultId,r.executionId);
     case 'cache-status':return controller.cacheStatus(r.vaultId);
     case 'cache-clear':return controller.clearCache(r.vaultId);
     case 'summary':return controller.summary();
     case 'status':return controller.status();
     case 'shutdown':await controller.close();await unlink(path);server.close();return {shutdownConfirmed:true};
     case 'start':return controller.start(r.vaultId);
     case 'stop':return controller.stop();
     case 'propose':return controller.propose(r.vaultId,r.executionId,r.callId,r.command,r.paths);
     case 'propose-browser':return controller.proposeBrowser(r.vaultId,r.executionId,r.callId,r.tool,r.value);
     case 'executeApproved':if(typeof r.executionId!=='string')throw new VaultError('vm_invalid_request');cancelExecution=r.executionId;return controller.executeApproved(r.approvalId,r.executionId);
     case 'cancel':await controller.cancel(r.executionId);return {cancelRequested:true};
     default:throw new VaultError('vm_unknown_method');
    }
   })().then(result=>{cancelExecution=null;socket.end(JSON.stringify({result})+'\n');},e=>{cancelExecution=null;socket.end(JSON.stringify({error:e instanceof VaultError?e.code:'vm_request_failed'})+'\n');});
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{void chmod(path,0o600).then(resolve,reject);});});
 let exiting=false;
 const close=async()=>{if(exiting)return;exiting=true;try{await controller.close();await unlink(join(directory,'owner','token')).catch(()=>{});await unlink(path).catch(()=>{});server.close();process.exit(0);}catch{process.exit(3);}};
 process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
 // Idle VM stop is separate from service lifetime. No recovery or automatic task resume.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){void serve(process.argv[2]!).catch(()=>process.exit(2));}
