import {randomUUID} from 'node:crypto';
import {HostFileGateway,digest,type FileView} from '../tools/files.js';
import {fail,type InvocationContext} from '../tools/contracts.js';
import {VaultRegistry} from './registry.js';
export interface WorkspaceSnapshot {
 schemaVersion:1; snapshotId:string; vaultId:string; environmentId:string; executionId:string;
 createdAt:number; expiresAt:number; files:FileView[]; hash:string;
}
export interface WorkspaceReview {path:string;kind:'modify'|'delete';conflict:boolean;diff:string;hostApplyEnabled:false}
/** Host-owned staging only. No VM transfer or Host mutation is implicit in preparation. */
export class WorkspaceGateway {
 private snapshots=new Map<string,WorkspaceSnapshot>();
 private preparing=0;
 private transferred=new Set<string>();
 constructor(private registry:VaultRegistry,private files:HostFileGateway,private now=Date.now){}
 discard(id:string){this.snapshots.delete(id);this.transferred.delete(id);}
 finishExecution(executionId:string){for(const [id,s] of this.snapshots)if(s.executionId===executionId){this.snapshots.delete(id);this.transferred.delete(id);}}
 async prepare(ctx:InvocationContext,paths:string[]):Promise<WorkspaceSnapshot>{
  ctx.signal.throwIfAborted();
  for(const [id,s] of this.snapshots)if(s.expiresAt<=this.now()){this.snapshots.delete(id);this.transferred.delete(id);}
  if(this.snapshots.size+this.preparing>=16)fail('workspace_capacity');
  if(!Array.isArray(paths)||!paths.length||paths.length>32||new Set(paths).size!==paths.length||paths.some(p=>typeof p!=='string'))fail('workspace_selection');
  this.preparing++;try{
  const vault=await this.registry.resolveVault(ctx.vaultId),views:FileView[]=[];let bytes=0;
  for(const path of [...paths].sort()){
   ctx.signal.throwIfAborted();const view=await this.files.read(ctx,path);bytes+=Buffer.byteLength(view.content);
   if(bytes>524288)fail('workspace_size_limit');views.push(view);
  }
  // Detect changes during preparation. Transfer requires a second validation after approval.
  for(const view of views)if(digest(await this.files.read(ctx,view.path))!==digest(view))fail('workspace_source_changed');
  const current=await this.registry.resolveVault(ctx.vaultId);
  if(digest(current.identity)!==digest(vault.identity)||current.environmentId!==vault.environmentId)fail('workspace_vault_changed');
  const snapshot:WorkspaceSnapshot={schemaVersion:1,snapshotId:randomUUID(),vaultId:ctx.vaultId,environmentId:vault.environmentId,executionId:ctx.executionId,createdAt:this.now(),expiresAt:this.now()+300000,files:views,hash:''};
  snapshot.hash=digest({...snapshot,hash:undefined});this.snapshots.set(snapshot.snapshotId,structuredClone(snapshot));return structuredClone(snapshot);
  }finally{this.preparing--;}
 }
 private get(ctx:InvocationContext,proposal:WorkspaceSnapshot){
  ctx.signal.throwIfAborted();const snapshot=this.snapshots.get(proposal.snapshotId);
  if(!snapshot||digest(snapshot)!==digest(proposal)||snapshot.vaultId!==ctx.vaultId||snapshot.executionId!==ctx.executionId)return fail('workspace_mismatch');
  if(snapshot.expiresAt<=this.now())fail('workspace_expired');return snapshot;
 }
 /** Only a trusted Host adapter may call this; model arguments cannot grant transfer permission. */
 async transferApproved(ctx:InvocationContext,proposal:WorkspaceSnapshot,approve:(summary:Readonly<WorkspaceSnapshot>,signal:AbortSignal)=>Promise<boolean>):Promise<string>{
  this.get(ctx,proposal);if(this.transferred.has(proposal.snapshotId))fail('workspace_already_transferred');
  const allowed=await new Promise<boolean>((resolve,reject)=>{
   const abort=()=>finish(false,new Error('cancelled'));
   const timer=setTimeout(()=>finish(false,new Error('workspace_expired')),Math.max(1,proposal.expiresAt-this.now()));
   const finish=(value:boolean,error?:Error)=>{clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
   ctx.signal.addEventListener('abort',abort,{once:true});
   Promise.resolve().then(()=>approve(structuredClone(proposal),ctx.signal)).then(value=>finish(value),error=>finish(false,error));
   if(ctx.signal.aborted)abort();
  });
  if(!allowed)fail('permission_denied');
  const snapshot=this.get(ctx,proposal);
  const vault=await this.registry.resolveVault(ctx.vaultId);if(vault.environmentId!==snapshot.environmentId)fail('workspace_vault_changed');
  for(const view of snapshot.files)if(digest(await this.files.read(ctx,view.path))!==digest(view))fail('workspace_source_changed');
  this.get(ctx,proposal);if(this.transferred.has(snapshot.snapshotId))fail('workspace_already_transferred');this.transferred.add(snapshot.snapshotId); // Retain trusted baseline for review; never retry unknown transfer outcomes.
  return JSON.stringify({schemaVersion:1,snapshotId:snapshot.snapshotId,vaultId:snapshot.vaultId,environmentId:snapshot.environmentId,files:snapshot.files.map(({path,content,hash})=>({path,content,hash}))});
 }
 /** VM outputs remain untrusted. Only selected existing paths are reviewable in this first contract. */
 async review(ctx:InvocationContext,snapshot:WorkspaceSnapshot,returned:{path:string;content:string|null}[]):Promise<WorkspaceReview[]>{
  ctx.signal.throwIfAborted();
  this.get(ctx,snapshot);
  if(!Array.isArray(returned)||returned.length>32||new Set(returned.map(f=>f.path)).size!==returned.length)fail('workspace_result_invalid');
  const changes:WorkspaceReview[]=[];let size=0;
  for(const file of returned){
   const before=snapshot.files.find(f=>f.path===file.path);if(!before)return fail('workspace_unselected_path');
   if(file.content!==null&&(typeof file.content!=='string'||file.content.includes('\0')||Buffer.byteLength(file.content)>65536))fail('workspace_result_invalid');
   size+=Buffer.byteLength(file.content??'');if(size>524288)fail('workspace_size_limit');
   if(file.content===before.content)continue;
   let conflict=true;try{conflict=digest(await this.files.read(ctx,file.path))!==digest(before);}catch{/* Missing/replaced/protected paths are conflicts, never authority to delete. */}
   changes.push({path:file.path,kind:file.content===null?'delete':'modify',conflict,diff:`--- ${file.path}\n+++ ${file.content===null?'/dev/null':file.path}\n`+before.content.split('\n').map(s=>'-'+s).join('\n')+'\n'+(file.content??'').split('\n').map(s=>'+'+s).join('\n'),hostApplyEnabled:false});
  }
  return changes;
 }
}
