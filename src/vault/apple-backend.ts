import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {VaultError} from './types.js';
export interface BackendResult {exitCode:number;stdout:string;stderr:string;cleanupConfirmed:boolean;reason:string;memoryPeakBytes:number}
export interface SharedBackend {onFailure?(handler:()=>void):void;start():Promise<void>;execute(id:string,command:string,seconds:number):Promise<BackendResult>;cancel(id:string):void;stop():Promise<void>}
/** Only this adapter can produce actual Framework stop evidence. Mock implementations are test-only. */
export class AppleOfflineBackend implements SharedBackend {
 private child:ChildProcessWithoutNullStreams|null=null;
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
 async start(){
  if(this.child)throw new VaultError('vm_duplicate_start');
  const manifest=JSON.parse(await readFile(join(this.assets,'manifest.json'),'utf8'));
  for(const name of ['Image','initrd']){const path=join(this.assets,name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>64*1024*1024)throw new VaultError('vm_asset_invalid');const hash=createHash('sha256').update(await readFile(path)).digest('hex');if(hash!==manifest[name])throw new VaultError('vm_asset_hash');}
  const ready=this.wait(e=>e.event==='ready',35000);
  const child=this.child=spawn(fileURLToPath(new URL('../nidus-vault-vm',import.meta.url)),[join(this.assets,'Image'),join(this.assets,'initrd')],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
  child.stdin.on('error',()=>{});child.stderr.resume();
  const lines=createInterface({input:child.stdout});let size=0;
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>8*1024*1024){void this.stop().catch(()=>{});this.event({event:'lost'});}});
  lines.on('line',line=>{try{if(line.length>262144)throw Error();const e=JSON.parse(line);if(e.event==='STOP_CONFIRMED'&&e.frameworkState===0)this.stopped=true;this.event(e);}catch{this.event({event:'lost'});}});
  child.on('error',()=>this.event({event:'lost'}));child.on('close',()=>{this.closed=true;this.event({event:this.stopped?'closed':'lost'});});
  await ready;
 }
 async execute(id:string,command:string,seconds:number):Promise<BackendResult>{
  if(!this.child||this.closed||this.stopped)throw new VaultError('vm_not_running');
  const pending=this.wait(e=>e.event==='guest'&&typeof e.line==='string'&&e.line.startsWith(`NIDUS_RESULT ${id} `),(seconds+12)*1000);
  this.child.stdin.write(`execute ${id} ${Buffer.from(command).toString('base64')} ${seconds}\n`);
  const e=await pending,parts=e.line.split(' ');
  if(parts.length!==8||!/^\d+$/.test(parts[2])||!['0','1'].includes(parts[3])||!['completed','cancelled','timeout'].includes(parts[4])||!/^\d+$/.test(parts[5]))throw new VaultError('vm_protocol_invalid');
  const decode=(v:string)=>{if(v==='-')return '';if(!/^[A-Za-z0-9+/]*={0,2}$/.test(v)||v.length>87384)throw new VaultError('vm_output_invalid');return Buffer.from(v,'base64').toString('utf8');};
  return {exitCode:Number(parts[2]),cleanupConfirmed:parts[3]==='1',reason:parts[4],memoryPeakBytes:Number(parts[5]),stdout:decode(parts[6]),stderr:decode(parts[7])};
 }
 cancel(id:string){if(!/^[a-zA-Z0-9-]+$/.test(id))throw new VaultError('vm_invalid_session');this.child?.stdin.write(`cancel ${id}\n`);}
 async stop(){
  if(!this.child)return;if(this.closed){if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');return;}
  const closed=this.wait(e=>e.event==='closed',12000);this.child.stdin.write('stop\n');await closed;
  if(!this.stopped)throw new VaultError('STOP_UNCONFIRMED');
 }
}
