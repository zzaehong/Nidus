import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {readFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {join} from 'node:path';
import type {Duplex} from 'node:stream';
import {EgressChannel,type Service} from '../workspace/egress-channel.js';
import type {CacheAttachment} from './cache-disk.js';
import {VaultError} from './types.js';
export interface ExecutionOptions {workspace?:string;profile?:'shell'|'browser'}
export interface BackendResult {workspace?:{path:string;content:string|null}[];workspaceStatus?:'complete'|'invalid';exitCode:number;stdout:string;stderr:string;cleanupConfirmed:boolean;reason:string;memoryPeakBytes:number}
export interface SharedBackend {onFailure?(handler:()=>void):void;start(disk?:CacheAttachment):Promise<void>;execute(id:string,command:string,seconds:number,options?:ExecutionOptions):Promise<BackendResult>;beginLive?(id:string,listener:(event:any)=>void):Promise<void>;sendLive?(value:unknown):Promise<void>;endLive?():Promise<void>;cancel(id:string):void;stop():Promise<void>;cacheClean?:boolean}
/** Only this adapter can produce actual Framework stop evidence. Mock implementations are test-only. */
export class AppleOfflineBackend implements SharedBackend {
 cacheClean=false;
 private child:ChildProcessWithoutNullStreams|null=null;
 private development=false;private browserWorkspace=false;
 private executing:string|null=null;
 private liveListener:((event:any)=>void)|undefined;private liveClosed:Promise<any>|undefined;private liveId:string|undefined;private liveWrites=Promise.resolve();
 private failureHandler:(()=>void)|undefined;
 onFailure(handler:()=>void){this.failureHandler=handler;}
 private listeners=new Set<(event:any)=>void>();private closed=false;private stopped=false;
 private egressLink:EgressChannel|undefined;
 private browserId:string|undefined;private browserWaiter:((link:Duplex)=>void)|undefined;private browserEnded:Promise<any>|undefined;
 /** With egress, guests built with egressVersion 1 reach the network only through this proxy.
  * Without it the link still carries the browser, and guest connections to the proxy are refused. */
 constructor(private readonly assets=fileURLToPath(new URL('../vm-assets',import.meta.url)),private readonly egress?:{accept(stream:Duplex):void}){}
 get egressConnected(){return this.egressLink!==undefined&&this.egress!==undefined;}
 get browserRunning(){return this.browserId!==undefined;}
 private transfers=new Map<string,(stream:Duplex)=>void>();
 private route(stream:Duplex,service:Service){
  if(service==='browser'){const take=this.browserWaiter;this.browserWaiter=undefined;if(take)take(stream);else stream.destroy();return;}
  if(service==='workspace'){this.routeTransfer(stream);return;}
  if(this.egress)this.egress.accept(stream);else stream.destroy();
 }
 private event(e:any){if(e.event==='lost')this.failureHandler?.();for(const listener of this.listeners)listener(e);}
 private wait(predicate:(e:any)=>boolean,ms:number):Promise<any>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.listeners.delete(listener);reject(new VaultError('vm_response_timeout'));},ms);
   const listener=(e:any)=>{if(predicate(e)){clearTimeout(timer);this.listeners.delete(listener);resolve(e);}else if(e.event==='lost'){clearTimeout(timer);this.listeners.delete(listener);reject(new VaultError('STOP_UNCONFIRMED'));}};this.listeners.add(listener);
  });
 }
 async start(disk?:CacheAttachment){
  if(this.child)throw new VaultError('vm_duplicate_start');
  const manifest=JSON.parse(await readFile(join(this.assets,'manifest.json'),'utf8'));
  if(manifest.profile!==undefined&&!['offline','development'].includes(manifest.profile))throw new VaultError('vm_asset_profile');
  this.development=manifest.profile==='development';this.browserWorkspace=manifest.browserWorkspaceVersion===1;
  for(const name of ['Image','initrd']){const path=join(this.assets,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>(this.development&&name==='initrd'?768:64)*1024*1024)throw new VaultError('vm_asset_invalid');const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==manifest[name])throw new VaultError('vm_asset_hash');}
  if(disk&&!this.development)throw new VaultError('cache_development_required');
  const ready=this.wait(e=>e.event==='ready',35000);
  const egress=manifest.egressVersion===1;
  const child=this.child=spawn(fileURLToPath(new URL('../nidus-vault-vm',import.meta.url)),[join(this.assets,'Image'),join(this.assets,'initrd'),...(this.development?['development']:[]),...(disk?[disk.path,disk.fresh?'new':'existing',disk.diskId]:[])],{stdio:['pipe','pipe','pipe',...(egress?['pipe' as const]:[])],env:{PATH:'/usr/bin:/bin',...(egress?{NIDUS_EGRESS_FD:'3'}:{})}}) as ChildProcessWithoutNullStreams;
  if(egress)this.egressLink=new EgressChannel(child.stdio[3] as unknown as Duplex,(stream,service)=>this.route(stream,service));
  child.stdin.on('error',()=>{});child.stderr.resume();
  const lines=createInterface({input:child.stdout});let windowBytes=0;
  const budgetTimer=setInterval(()=>{windowBytes=0;},1000);budgetTimer.unref();child.once('close',()=>clearInterval(budgetTimer));
  child.stdout.on('data',(b:Buffer)=>{windowBytes+=b.length;if(windowBytes>4*1024*1024){void this.stop().catch(()=>{});this.event({event:'lost'});}});
  lines.on('line',line=>{try{if(line.length>262144)throw Error();const e=JSON.parse(line);
   // Output is bounded per second (above) and per line; a resident VM has no lifetime cap.
   if(e.event==='guest'&&e.line==='NIDUS_CACHE_CLEAN')this.cacheClean=true;if(e.event==='STOP_CONFIRMED'&&e.frameworkState===0)this.stopped=true;this.event(e);}catch{this.event({event:'lost'});}});
  child.on('error',()=>this.event({event:'lost'}));child.on('close',()=>{this.closed=true;this.event({event:this.stopped?'closed':'lost'});});
  await ready;
 }
 async execute(id:string,command:string,seconds:number,options:ExecutionOptions={}):Promise<BackendResult>{
  if(this.executing)throw new VaultError('vm_execution_active');
  if(!/^[0-9a-f-]{36}$/.test(id))throw new VaultError('vm_invalid_session');
  this.executing=id;
  const chunks:Buffer[]=[];let workspaceDigest='',invalid=false,total=0;
  const listener=(e:any)=>{
   if(e.event!=='guest'||typeof e.line!=='string')return;const parts=e.line.split(' ');if(parts[1]!==id)return;
   if(parts[0]==='NIDUS_WORKSPACE_RESULT'){
    if(parts.length!==4||String(chunks.length)!==parts[2]||!/^[A-Za-z0-9+/]+={0,2}$/.test(parts[3])){invalid=true;return;}
    const chunk=Buffer.from(parts[3],'base64');total+=chunk.length;if(total>1048576){invalid=true;return;}chunks.push(chunk);
   }else if(parts[0]==='NIDUS_WORKSPACE_END')workspaceDigest=parts[2];
   else if(parts[0]==='NIDUS_WORKSPACE_INVALID')invalid=true;
  };
  this.listeners.add(listener);
  try{
  if(!this.child||this.closed||this.stopped)throw new VaultError('vm_not_running');
  let snapshot='';
  if(options.workspace){
   if(!this.development||Buffer.byteLength(options.workspace)>1048576)throw new VaultError('workspace_backend_unsupported');
   const value=JSON.parse(options.workspace);snapshot=value.snapshotId;
   if(typeof snapshot!=='string'||!/^[0-9a-f-]{36}$/.test(snapshot))throw new VaultError('workspace_invalid');
   const raw=Buffer.from(options.workspace);
   const transfer=async(action:string,payload:string)=>{
    const ack=this.wait(e=>e.event==='guest'&&e.line===`NIDUS_WORKSPACE_ACK ${snapshot} ${action}`,10000);
    this.child!.stdin.write(`workspace-${action} ${snapshot} ${payload}\n`);await ack;
   };
   await transfer('begin','-');
   for(let offset=0;offset<raw.length;offset+=12288)await transfer('chunk',raw.subarray(offset,offset+12288).toString('base64'));
   await transfer('seal',createHash('sha256').update(raw).digest('hex'));
  }
  const pending=this.wait(e=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_RESULT ${id} `),(seconds+12)*1000);
  this.child.stdin.write(`${options.profile==='browser'?'execute-browser':this.development?'execute-dev':'execute'} ${id} ${Buffer.from(command).toString('base64')} ${seconds}${snapshot?' '+snapshot:''}\n`);
  const e=await pending,parts=e.line.split(' ');
  if(parts.length!==8||!/^\d+$/.test(parts[2])||!['0','1'].includes(parts[3])||!['completed','cancelled','timeout'].includes(parts[4])||!/^\d+$/.test(parts[5]))throw new VaultError('vm_protocol_invalid');
  const decode=(v:string)=>{if(v==='-')return '';if(!/^[A-Za-z0-9+/]*={0,2}$/.test(v)||v.length>87384)throw new VaultError('vm_output_invalid');return Buffer.from(v,'base64').toString('utf8');};
  let workspace:BackendResult['workspace'];
  if(options.workspace&&options.profile!=='browser'){
   const raw=Buffer.concat(chunks);
   if(invalid||!workspaceDigest||createHash('sha256').update(raw).digest('hex')!==workspaceDigest)invalid=true;
   else{try{workspace=JSON.parse(raw.toString('utf8'));if(!Array.isArray(workspace))invalid=true;}catch{invalid=true;}}
  }
  return {...(options.workspace&&options.profile!=='browser'?{workspaceStatus:invalid?'invalid' as const:'complete' as const,...(!invalid?{workspace}:{})}:{}),exitCode:Number(parts[2]),cleanupConfirmed:parts[3]==='1',reason:parts[4],memoryPeakBytes:Number(parts[5]),stdout:decode(parts[6]),stderr:decode(parts[7])};
  }finally{this.listeners.delete(listener);this.executing=null;}
 }
 cancel(id:string){if(!/^[a-zA-Z0-9-]+$/.test(id))throw new VaultError('vm_invalid_session');this.child?.stdin.write(`cancel ${id}\n`);}
 async beginLive(id:string,listener:(event:any)=>void){
  if(this.executing||!this.child||this.closed||!this.development)throw new VaultError('vm_execution_active');
  if(!/^[0-9a-f-]{36}$/.test(id))throw new VaultError('vm_invalid_session');
  this.executing=id;this.liveId=id;
  this.liveListener=e=>{if(e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_LIVE ${id} `)){try{const value=JSON.parse(Buffer.from(e.line.split(' ')[2],'base64').toString('utf8'));listener(value);}catch{listener({event:'fatal',error:'browser_protocol_invalid'});}}};this.listeners.add(this.liveListener);
  this.liveClosed=this.wait(e=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_RESULT ${id} `),915000);void this.liveClosed.then(()=>listener({event:'ended'}),()=>listener({event:'fatal',error:'browser_cleanup_unconfirmed'}));
  const ready=this.wait(e=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_LIVE ${id} `)&&JSON.parse(Buffer.from(e.line.split(' ')[2],'base64').toString()).event==='ready',25000);
  this.child.stdin.write(`browser-open ${id} - 900\n`);await ready;
 }
 async sendLive(value:unknown){
  const raw=Buffer.from(JSON.stringify(value));if(raw.length>3*1024*1024)throw new VaultError('browser_message_limit');
  const run=this.liveWrites.then(async()=>{if(!this.liveId||!this.child||this.closed)throw new VaultError('browser_not_running');const key=randomUUID();for(let i=0;i<raw.length;i+=9000){const part=Buffer.from(JSON.stringify({id:key,data:raw.subarray(i,i+9000).toString('base64'),last:i+9000>=raw.length})).toString('base64');if(!this.child.stdin.write(`browser-input ${this.liveId} ${part}\n`))await once(this.child.stdin,'drain');}});this.liveWrites=run.catch(()=>{});return run;
 }
 async endLive(){
  if(!this.liveId)return;
  this.cancel(this.liveId);
  const e=await Promise.race([this.liveClosed!,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new VaultError('browser_cleanup_unconfirmed')),10000);timer.unref();})]);
  if(e.line.split(' ')[3]!=='1')throw new VaultError('browser_cleanup_unconfirmed');
  if(this.liveListener)this.listeners.delete(this.liveListener);this.liveListener=undefined;this.liveClosed=undefined;this.liveId=undefined;this.executing=null;
 }
 /** Starts the VM's resident browser and returns its DevTools link (see src/workspace/browser.ts).
  * It runs beside Shell sessions and keeps running until closeBrowser() or VM stop. */
 async openBrowser(seconds=86400):Promise<Duplex>{
  if(!this.child||this.closed||this.stopped||!this.development)throw new VaultError('vm_not_running');
  if(!this.egressLink||!this.browserWorkspace)throw new VaultError('browser_workspace_unsupported');
  if(this.browserId)throw new VaultError('browser_already_running');
  if(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400)throw new VaultError('browser_deadline_invalid');
  const id=randomUUID();this.browserId=id;
  const result=(e:any)=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_RESULT ${id} `);
  this.browserEnded=this.wait(e=>result(e)||(e.event==='guest'&&e.line===`NIDUS_REJECT browser ${id}`),seconds*1000+15000);
  const ended=this.browserEnded.then(e=>{throw new VaultError(result(e)?'browser_exited':'browser_rejected');});
  ended.catch(()=>{});
  const link=new Promise<Duplex>((resolve,reject)=>{const timer=setTimeout(()=>{this.browserWaiter=undefined;reject(new VaultError('browser_start_timeout'));},45000);this.browserWaiter=stream=>{clearTimeout(timer);resolve(stream);};});
  this.child.stdin.write(`browser-start ${id} - ${seconds}\n`);
  try{return await Promise.race([link,ended]);}
  catch(error){this.browserWaiter=undefined;await this.closeBrowser().catch(()=>{});throw error;}
 }
 /** Ends the resident browser and confirms its processes are gone. A browser closed through
  * its link exits by itself (and writes its profile); it is cancelled only after graceMs. */
 async closeBrowser(graceMs=3000){
  const id=this.browserId;if(!id)return;
  const within=(ms:number)=>Promise.race([this.browserEnded!,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new VaultError('browser_cleanup_unconfirmed')),ms);timer.unref();})]);
  try{
   const e=await within(graceMs).catch(()=>{this.cancel(id);return within(15000);});
   if(e.line.startsWith('NIDUS_RESULT')&&e.line.split(' ')[3]!=='1')throw new VaultError('browser_cleanup_unconfirmed');
  }finally{this.browserId=undefined;this.browserEnded=undefined;}
 }
 /** A workspace transfer stream starts with its one-time token line; anything else is dropped. */
 private routeTransfer(stream:Duplex){
  let head=Buffer.alloc(0);
  const timer=setTimeout(()=>stream.destroy(),10000);
  const onData=(chunk:Buffer)=>{
   head=Buffer.concat([head,chunk]);const end=head.indexOf(10);
   if(end<0){if(head.length>64){clearTimeout(timer);stream.destroy();}return;}
   clearTimeout(timer);stream.off('data',onData);stream.pause();
   const take=this.transfers.get(head.subarray(0,end).toString());
   if(!take){stream.destroy();return;}
   this.transfers.delete(head.subarray(0,end).toString());
   const rest=head.subarray(end+1);if(rest.length)stream.unshift(rest);
   take(stream);
  };
  stream.on('data',onData);stream.on('error',()=>{});
 }
 private workspaceLine(task:string,kind:string,ms:number){
  const prefix=(e:any)=>e.event==='guest'&&typeof e.line==='string';
  return this.wait(e=>prefix(e)&&(e.line.startsWith(`NIDUS_WORKSPACE_${kind} ${task} `)||e.line===`NIDUS_WORKSPACE_${kind} ${task}`||e.line.startsWith(`NIDUS_WORKSPACE_FAILED ${task} `)||e.line===`NIDUS_WORKSPACE_FAILED ${task} unavailable`),ms).then(e=>{
   if(e.line.startsWith('NIDUS_WORKSPACE_FAILED')){const error=new VaultError('workspace_transfer_failed');error.message+=` (${e.line.split(' ').slice(2).join(' ')})`;throw error;}
   return e.line.split(' ').slice(2) as string[];
  });
 }
 /** Copies a Vault bundle into the VM as /workspaces/<task> and makes it the current workspace. */
 async importWorkspace(task:string,bundle:Buffer):Promise<string>{
  if(!this.child||this.closed||!this.egressLink||!this.development)throw new VaultError('vm_not_running');
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(task))throw new VaultError('workspace_task_invalid');
  if(!bundle.length||bundle.length>256*1024*1024)throw new VaultError('workspace_too_large');
  const token=randomBytes(16).toString('hex');
  this.transfers.set(token,stream=>{stream.on('error',()=>{});stream.end(bundle);});
  try{
   const done=this.workspaceLine(task,'IMPORTED',60000+bundle.length/1000);
   this.child.stdin.write(`workspace-import ${task} ${token} ${bundle.length} ${createHash('sha256').update(bundle).digest('hex')}\n`);
   const [commit]=await done;
   if(!/^[0-9a-f]{40}$/.test(commit??''))throw new VaultError('vm_protocol_invalid');
   return commit!;
  }finally{this.transfers.delete(token);}
 }
 /** Makes an existing workspace current again (after a VM restart). False when the VM does not have it. */
 async selectWorkspace(task:string):Promise<boolean>{
  if(!this.child||this.closed||!this.development)throw new VaultError('vm_not_running');
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(task))throw new VaultError('workspace_task_invalid');
  const done=this.workspaceLine(task,'SELECTED',10000).then(()=>true,()=>false);
  this.child.stdin.write(`workspace-select ${task}\n`);
  return done;
 }
 /** Deletes a task's workspace in the VM (after its result was approved or discarded). */
 async removeWorkspace(task:string):Promise<void>{
  if(!this.child||this.closed||!this.development)throw new VaultError('vm_not_running');
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(task))throw new VaultError('workspace_task_invalid');
  const done=this.workspaceLine(task,'REMOVED',30000);
  this.child.stdin.write(`workspace-remove ${task}\n`);
  await done;
 }
 /** The task's work as a bundle of commits after base (uncommitted changes are committed first); null when nothing changed. */
 async exportWorkspace(task:string,base:string):Promise<{head:string;bundle:Buffer|null}>{
  if(!this.child||this.closed||!this.egressLink||!this.development)throw new VaultError('vm_not_running');
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(task)||!/^[0-9a-f]{40}$/.test(base))throw new VaultError('workspace_task_invalid');
  const limit=128*1024*1024,token=randomBytes(16).toString('hex');
  const received=new Promise<Buffer>((resolve,reject)=>{
   this.transfers.set(token,stream=>{const chunks:Buffer[]=[];let size=0;
    stream.on('data',(c:Buffer)=>{size+=c.length;if(size>limit){stream.destroy();reject(new VaultError('workspace_too_large'));}else chunks.push(c);});
    stream.on('end',()=>resolve(Buffer.concat(chunks)));stream.on('error',()=>reject(new VaultError('workspace_transfer_failed')));stream.resume();});
  });
  received.catch(()=>{});
  try{
   const done=this.workspaceLine(task,'EXPORTED',600000);
   this.child.stdin.write(`workspace-export ${task} ${token} - ${base}\n`);
   const [size,digest,head]=await done;
   if(!/^\d+$/.test(size??'')||!/^[0-9a-f]{40}$/.test(head??''))throw new VaultError('vm_protocol_invalid');
   if(size==='0')return {head:head!,bundle:null};
   const bundle=await Promise.race([received,new Promise<never>((_,reject)=>setTimeout(()=>reject(new VaultError('workspace_transfer_failed')),30000).unref())]);
   if(bundle.length!==Number(size)||createHash('sha256').update(bundle).digest('hex')!==digest)throw new VaultError('workspace_transfer_failed');
   return {head:head!,bundle};
  }finally{this.transfers.delete(token);}
 }
 private services=new Map<string,Promise<any>>();
 /** Starts a background command (a dev server) beside Shell sessions. It runs until stopService or VM stop. */
 async startService(id:string,command:string,seconds=86400):Promise<void>{
  if(!this.child||this.closed||this.stopped||!this.development)throw new VaultError('vm_not_running');
  if(!/^[0-9a-f-]{36}$/.test(id))throw new VaultError('vm_invalid_session');
  if(!command.trim()||Buffer.byteLength(command)>49152||command.includes('\0'))throw new VaultError('vm_invalid_request');
  const result=(e:any)=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_RESULT ${id} `);
  const ended=this.wait(e=>result(e)||(e.event==='guest'&&e.line===`NIDUS_REJECT service ${id}`),seconds*1000+15000);
  ended.catch(()=>{});
  this.services.set(id,ended);
  void ended.finally(()=>this.services.delete(id));
  this.child.stdin.write(`service-start ${id} ${Buffer.from(command).toString('base64')} ${seconds}\n`);
  // Refused, or exited at once (a typo): report it instead of a service that is not there.
  const early=await Promise.race([ended.then(e=>e,()=>null),new Promise(r=>setTimeout(()=>r(undefined),1500))]);
  if(early!==undefined){this.services.delete(id);throw new VaultError(early&&early.line.startsWith('NIDUS_REJECT')?'service_rejected':'service_exited');}
 }
 /** Stops a background command and confirms its processes are gone. */
 async stopService(id:string):Promise<void>{
  const ended=this.services.get(id);if(!ended)return;
  this.cancel(id);
  await Promise.race([ended,new Promise((_,reject)=>setTimeout(()=>reject(new VaultError('service_cleanup_unconfirmed')),15000).unref())]);
 }
 get runningServices(){return [...this.services.keys()];}
 async stop(){
  if(!this.child)return;if(this.closed){if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');return;}
  for(const id of [...this.services.keys()])await this.stopService(id).catch(()=>{});
  if(this.browserId)await this.closeBrowser();
  const closed=this.wait(e=>e.event==='closed',12000);this.child.stdin.write('stop\n');await closed;
  if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');
 }
}
