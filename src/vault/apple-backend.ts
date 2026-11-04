import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {readFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {join} from 'node:path';
import type {CacheAttachment} from './cache-disk.js';
import {VaultError} from './types.js';
export interface ExecutionOptions {workspace?:string;profile?:'shell'|'browser'}
export interface BackendResult {workspace?:{path:string;content:string|null}[];workspaceStatus?:'complete'|'invalid';exitCode:number;stdout:string;stderr:string;cleanupConfirmed:boolean;reason:string;memoryPeakBytes:number}
export interface SharedBackend {onFailure?(handler:()=>void):void;start(disk?:CacheAttachment):Promise<void>;execute(id:string,command:string,seconds:number,options?:ExecutionOptions):Promise<BackendResult>;beginLive?(id:string,listener:(event:any)=>void):Promise<void>;sendLive?(value:unknown):Promise<void>;endLive?():Promise<void>;cancel(id:string):void;stop():Promise<void>;cacheClean?:boolean}
/** Only this adapter can produce actual Framework stop evidence. Mock implementations are test-only. */
export class AppleOfflineBackend implements SharedBackend {
 cacheClean=false;
 private child:ChildProcessWithoutNullStreams|null=null;
 private development=false;
 private executing:string|null=null;
 private liveListener:((event:any)=>void)|undefined;private liveClosed:Promise<any>|undefined;private liveId:string|undefined;private liveWrites=Promise.resolve();
 private failureHandler:(()=>void)|undefined;
 onFailure(handler:()=>void){this.failureHandler=handler;}
 private listeners=new Set<(event:any)=>void>();private closed=false;private stopped=false;
 constructor(private readonly assets=fileURLToPath(new URL('../vm-assets',import.meta.url))){}
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
  this.development=manifest.profile==='development';
  for(const name of ['Image','initrd']){const path=join(this.assets,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>(this.development&&name==='initrd'?768:64)*1024*1024)throw new VaultError('vm_asset_invalid');const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==manifest[name])throw new VaultError('vm_asset_hash');}
  if(disk&&!this.development)throw new VaultError('cache_development_required');
  const ready=this.wait(e=>e.event==='ready',35000);
  const child=this.child=spawn(fileURLToPath(new URL('../nidus-vault-vm',import.meta.url)),[join(this.assets,'Image'),join(this.assets,'initrd'),...(this.development?['development']:[]),...(disk?[disk.path,disk.fresh?'new':'existing',disk.diskId]:[])],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
  child.stdin.on('error',()=>{});child.stderr.resume();
  const lines=createInterface({input:child.stdout});let size=0,frames=0,windowBytes=0;
  const budgetTimer=setInterval(()=>{windowBytes=0;},1000);budgetTimer.unref();child.once('close',()=>clearInterval(budgetTimer));
  child.stdout.on('data',(b:Buffer)=>{windowBytes+=b.length;if(windowBytes>4*1024*1024){void this.stop().catch(()=>{});this.event({event:'lost'});}});
  lines.on('line',line=>{try{if(line.length>262144)throw Error();const e=JSON.parse(line);let frame=false;if(this.liveId&&e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_LIVE ${this.liveId} `)){frame=JSON.parse(Buffer.from(e.line.split(' ')[2],'base64').toString()).event==='frame';}if(frame)frames+=line.length;else size+=line.length;if(size>8*1024*1024||frames>128*1024*1024){void this.stop().catch(()=>{});throw Error('output limit');}if(e.event==='guest'&&e.line==='NIDUS_CACHE_CLEAN')this.cacheClean=true;if(e.event==='STOP_CONFIRMED'&&e.frameworkState===0)this.stopped=true;this.event(e);}catch{this.event({event:'lost'});}});
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
 async stop(){
  if(!this.child)return;if(this.closed){if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');return;}
  const closed=this.wait(e=>e.event==='closed',12000);this.child.stdin.write('stop\n');await closed;
  if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');
 }
}
