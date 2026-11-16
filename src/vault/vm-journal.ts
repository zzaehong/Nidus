import {constants} from 'node:fs';
import {open,lstat,mkdir,rename,readdir,rmdir,unlink} from 'node:fs/promises';
import {join,resolve,parse,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VaultError} from './types.js';
import {initialVMStatus,type SharedVMStatus} from './vm-protocol.js';
const fail=(code:string):never=>{throw new VaultError(code);};
export async function safeVMDirectory(path:string):Promise<void>{
 const full=resolve(path);let current=parse(full).root;
 for(const part of full.slice(current.length).split('/').filter(Boolean)){
  current=join(current,part);const s=await lstat(current);
  if(!s.isDirectory()||s.isSymbolicLink())fail('vm_unsafe_directory');
 }
 const s=await lstat(full);if(s.uid!==process.getuid!()||(s.mode&0o077))fail('vm_directory_permissions');
}
async function ensure(path:string):Promise<void>{
 try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await ensure(dirname(path));try{await mkdir(path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
}
export async function readVMFile(path:string):Promise<string>{
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const a=await f.stat();if(!a.isFile()||a.nlink!==1||a.uid!==process.getuid!()||(a.mode&0o077)||a.size>8*1024*1024)fail('vm_unsafe_file');
 const text=await f.readFile('utf8'),b=await f.stat(),n=await lstat(path);
 if(a.ino!==n.ino||a.dev!==n.dev||n.isSymbolicLink()||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs||a.size!==b.size)fail('vm_file_changed');return text;
 }finally{await f.close();}
}
export async function durableFile(path:string,text:string){
 const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await f.writeFile(text);await f.sync();}finally{await f.close();}
}
async function syncDir(path:string){const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}}
export class VMJournal {
 readonly ownerId=randomUUID();private held=false;private raw:string|null=null;private identity='';
 constructor(readonly directory:string){}
 async read():Promise<SharedVMStatus>{
  try{await safeVMDirectory(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return initialVMStatus();throw e;}
  if((await readdir(this.directory)).some(n=>n.startsWith('pending-')))fail('vm_write_interrupted');
  let raw:string;try{raw=await readVMFile(join(this.directory,'state.json'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){if((await readdir(this.directory)).includes('initialized'))fail('vm_state_missing');return initialVMStatus();}throw e;}
  let s:SharedVMStatus;try{s=JSON.parse(raw);}catch{return fail('vm_state_corrupt');}
  if(s.schemaVersion!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!Number.isSafeInteger(s.generation)||s.generation<0||!['STOPPED','STARTING','RUNNING','STOPPING','STOP_CONFIRMED','STOP_UNCONFIRMED'].includes(s.state)||!Array.isArray(s.sessions)||s.sessions.length>10000||s.backend!=='apple-virtualization-offline'||s.network!=='disabled'||s.originalVaultMounted!==false)fail('vm_state_corrupt');
  if(s.sessions.some(x=>!x||typeof x.id!=='string'||!['QUEUED','RUNNING','COMPLETED','CANCELLED','FAILED','UNCONFIRMED'].includes(x.state)||typeof x.cleanupConfirmed!=='boolean'))fail('vm_state_corrupt');
  if(!s.policy||s.policy.version!==1||s.policy.globalActiveVMs!==1||s.policy.vaultActiveVMs!==1||s.policy.activeSessionsPerVM!==1||s.policy.queue!=='host-service-fifo'||!Number.isSafeInteger(s.policy.idleMs)||s.policy.idleMs<100||s.policy.idleMs>3600000)fail('vm_state_corrupt');
  const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(v);
  const digest=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
  if(typeof s.ready!=='boolean'||!Number.isSafeInteger(s.queued)||s.queued<0||!Number.isFinite(Date.parse(s.updatedAt)))fail('vm_state_corrupt');
  if(s.generation===0){if(s.vaultId!==null||s.environmentId!==null||s.vmInstanceId!==null||s.state!=='STOPPED'||s.sessions.length)fail('vm_state_corrupt');}
  else if(!uuid(s.vaultId)||!uuid(s.environmentId)||!uuid(s.vmInstanceId))fail('vm_state_corrupt');
  const ids=new Set<string>(),keys=new Set<string>();
  for(const x of s.sessions){
   if(!uuid(x.id)||!uuid(x.vaultId)||!uuid(x.vmInstanceId)||!digest(x.invocationKey)||!digest(x.commandHash)||!Number.isSafeInteger(x.generation)||x.generation<1||x.generation>s.generation||!Number.isFinite(Date.parse(x.createdAt))||typeof x.executionId!=='string'||typeof x.callId!=='string'||ids.has(x.id)||keys.has(x.invocationKey))fail('vm_state_corrupt');
   if(['COMPLETED','FAILED'].includes(x.state)&&(!x.cleanupConfirmed||!digest(x.resultHash)||!x.completedAt))fail('vm_state_corrupt');
   if(x.generation===s.generation&&x.vmInstanceId!==s.vmInstanceId)fail('vm_state_corrupt');ids.add(x.id);keys.add(x.invocationKey);
  }
  if(s.activeSession!==null&&!s.sessions.some(x=>x.id===s.activeSession&&['RUNNING','UNCONFIRMED'].includes(x.state)))fail('vm_state_corrupt');
  return s;
 }
 async claim(){
  await ensure(this.directory);await safeVMDirectory(this.directory);const identityStat=await lstat(this.directory,{bigint:true});this.identity=`${identityStat.dev}:${identityStat.ino}:${identityStat.birthtimeNs}`;
  try{await mkdir(join(this.directory,'owner'),{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')fail('vm_manager_owned_or_unconfirmed');throw e;}
  this.held=true;await durableFile(join(this.directory,'owner','identity'),this.ownerId);await syncDir(this.directory);
  const s=await this.read();if(!['STOPPED','STOP_CONFIRMED'].includes(s.state)||s.activeSession||s.sessions.some(x=>!['COMPLETED','CANCELLED','FAILED'].includes(x.state)))fail('vm_recovery_forbidden');
  try{this.raw=await readVMFile(join(this.directory,'state.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await this.save(s);try{await durableFile(join(this.directory,'initialized'),'1');}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}return s;
 }
 async save(s:SharedVMStatus){
  await safeVMDirectory(this.directory);
  const stat=await lstat(this.directory,{bigint:true});
  if(!this.held||`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`!==this.identity||await readVMFile(join(this.directory,'owner','identity'))!==this.ownerId)fail('vm_owner_changed');
  let current=null;try{current=await readVMFile(join(this.directory,'state.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(current!==this.raw)fail('vm_revision_conflict');s.revision++;s.updatedAt=new Date().toISOString();const raw=JSON.stringify(s);
  const pending=join(this.directory,'pending-'+randomUUID());await durableFile(pending,raw);await syncDir(this.directory);await rename(pending,join(this.directory,'state.json'));await syncDir(this.directory);this.raw=raw;
 }
 async release(s:SharedVMStatus){
  if(!['STOPPED','STOP_CONFIRMED'].includes(s.state)||s.activeSession||s.queued)fail('vm_release_unconfirmed');
  await this.save(s);await unlink(join(this.directory,'owner','token')).catch(e=>{if(e.code!=='ENOENT')throw e;});await unlink(join(this.directory,'owner','identity'));await rmdir(join(this.directory,'owner'));await syncDir(this.directory);this.held=false;
 }
}
