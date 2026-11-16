import {directoryVolumeIdentity} from './volume-identity.js';
import {constants} from 'node:fs';
import {mkdir,open,lstat,rename,unlink,rmdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeVMDirectory,readVMFile,durableFile} from './vm-journal.js';
import {VaultError} from './types.js';
const SIZE=512*1024*1024;
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(s);
export interface CacheAttachment {path:string;fresh:boolean;diskId:string}
interface Metadata {schemaVersion:1;vaultId:string;environmentId:string;diskId:string;bytes:number;state:'new'|'dirty'|'clean';inode:string;device:string;birthtime:string;volumeUuid?:string}
/** Exclusive ownership is never reclaimed by PID or expiry. Uncertain writes remain dirty. */
export class CacheDiskStore {
 private held=new Map<string,{directory:string;metadata:Metadata}>();
 constructor(readonly directory:string, private readonly volumeIdentity: ((path:string)=>Promise<string>) | undefined = process.platform==='darwin' ? directoryVolumeIdentity : undefined){}
 private async location(vaultId:string,environmentId:string){
  if(!uuid(vaultId)||!uuid(environmentId))throw new VaultError('cache_identity_invalid');
  await mkdir(this.directory,{mode:0o700,recursive:true});await safeVMDirectory(this.directory);
  const path=join(this.directory,vaultId+'-'+environmentId);await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await safeVMDirectory(path);return path;
 }
 private async save(path:string,m:Metadata){const pending=join(path,'pending-'+randomUUID());await durableFile(pending,JSON.stringify(m));await rename(pending,join(path,'metadata.json'));const d=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);try{await d.sync();}finally{await d.close();}}
 private async read(path:string,vaultId:string,environmentId:string,rebind=false):Promise<Metadata>{
  if((await readdir(path)).some(n=>n.startsWith('pending-')))throw new VaultError('cache_write_interrupted');
  let m:Metadata;try{m=JSON.parse(await readVMFile(join(path,'metadata.json')));}catch{throw new VaultError('cache_metadata_invalid');}
  if(m.schemaVersion!==1||m.vaultId!==vaultId||m.environmentId!==environmentId||!uuid(m.diskId)||m.bytes!==SIZE||!['new','dirty','clean'].includes(m.state))throw new VaultError('cache_metadata_invalid');
  if(m.volumeUuid!==undefined&&(typeof m.volumeUuid!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(m.volumeUuid)))throw new VaultError('cache_metadata_invalid');
  const volumeUuid=await this.volumeIdentity?.(path);
  if(m.volumeUuid&&m.volumeUuid!==volumeUuid)throw new VaultError('cache_disk_changed');
  const parent=await lstat(path,{bigint:true});
  const s=await lstat(join(path,'cache.raw'),{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.uid!==BigInt(process.getuid!())||(s.mode&0o077n)!==0n||s.size!==BigInt(SIZE)||s.ino.toString()!==m.inode||s.dev!==parent.dev||(!m.volumeUuid&&!rebind&&s.dev.toString()!==m.device)||s.birthtimeNs.toString()!==m.birthtime)throw new VaultError('cache_disk_changed');return {...m,device:s.dev.toString()};
 }
 async acquire(vaultId:string,environmentId:string):Promise<CacheAttachment>{
  const directory=await this.location(vaultId,environmentId);
  await mkdir(join(directory,'owner'),{mode:0o700}).catch(()=>{throw new VaultError('cache_owned_or_unconfirmed');});
  try{
   let m:Metadata;
   const entries=await readdir(directory);
   if(!entries.includes('metadata.json')){
    if(entries.some(n=>n!=='owner'))throw new VaultError('cache_partial_creation');
    const f=await open(join(directory,'cache.raw'),constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
    try{await f.truncate(SIZE);await f.sync();const s=await f.stat({bigint:true});m={schemaVersion:1,vaultId,environmentId,diskId:randomUUID(),bytes:SIZE,state:'new',inode:s.ino.toString(),device:s.dev.toString(),birthtime:s.birthtimeNs.toString()};}finally{await f.close();}
    const volumeUuid=await this.volumeIdentity?.(directory);if(volumeUuid)m.volumeUuid=volumeUuid;
    await this.save(directory,m);
   }else m=await this.read(directory,vaultId,environmentId);
   if(m.state==='dirty')throw new VaultError('cache_dirty');const fresh=m.state==='new';m.state='dirty';await this.save(directory,m);this.held.set(m.diskId,{directory,metadata:m});
   return {path:join(directory,'cache.raw'),fresh,diskId:m.diskId};
  }catch(e){await rmdir(join(directory,'owner'));throw e;}
 }
 async release(diskId:string,clean:boolean){const held=this.held.get(diskId);if(!held)throw new VaultError('cache_not_owned');this.held.delete(diskId);const m=await this.read(held.directory,held.metadata.vaultId,held.metadata.environmentId);if(m.diskId!==diskId||m.state!=='dirty')throw new VaultError('cache_state_changed');m.state=clean?'clean':'dirty';await this.save(held.directory,m);await rmdir(join(held.directory,'owner'));this.held.delete(diskId);}
 async status(vaultId:string,environmentId:string){const path=await this.location(vaultId,environmentId);const entries=await readdir(path);if(!entries.includes('metadata.json')){if(entries.length)throw new VaultError('cache_partial_creation');return {state:'absent',capacityBytes:SIZE};}const m=await this.read(path,vaultId,environmentId);const s=await lstat(join(path,'cache.raw'));return {state:m.state,diskId:m.diskId,capacityBytes:SIZE,allocatedBytes:s.blocks*512,owned:(await readdir(path)).includes('owner')};}
 /** Explicit repair of mount-local device numbers; caller must establish VM STOP_CONFIRMED. */
 async rebindDevice(vaultId:string,environmentId:string){
  if(!this.volumeIdentity)throw new VaultError('volume_identity_unavailable');
  const path=await this.location(vaultId,environmentId);
  await mkdir(join(path,'owner'),{mode:0o700}).catch(()=>{throw new VaultError('cache_owned_or_unconfirmed');});
  try{
   const m=await this.read(path,vaultId,environmentId,true);
   if(m.state==='dirty')throw new VaultError('cache_dirty');
   const volumeUuid=await this.volumeIdentity(path);
   const again=await this.read(path,vaultId,environmentId,true);
   if(JSON.stringify(m)!==JSON.stringify(again))throw new VaultError('cache_state_changed');
   await this.save(path,{...m,volumeUuid});
  }finally{await rmdir(join(path,'owner'));}
 }
 /** Caller must first establish VM STOP_CONFIRMED. Active/unconfirmed owners cannot be bypassed. */
 async clear(vaultId:string,environmentId:string){const path=await this.location(vaultId,environmentId);await mkdir(join(path,'owner'),{mode:0o700}).catch(()=>{throw new VaultError('cache_owned_or_unconfirmed');});try{await this.read(path,vaultId,environmentId);await unlink(join(path,'cache.raw'));await unlink(join(path,'metadata.json'));}finally{await rmdir(join(path,'owner'));}}
}
