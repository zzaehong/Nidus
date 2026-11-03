import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceGateway,type WorkspaceSnapshot} from './workspace.js';
import {HostFileGateway} from '../tools/files.js';
import type {InvocationContext} from '../tools/contracts.js';
import {VaultRegistry} from './registry.js';
import {VaultError} from './types.js';
import {VMJournal} from './vm-journal.js';
import {AppleOfflineBackend,type SharedBackend} from './apple-backend.js';
import {summarizeVMStatus,initialVMStatus,type SharedVMStatus,type ShellResult,type SessionRecord} from './vm-protocol.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw new VaultError(code);};
interface Pending {snapshot?:WorkspaceSnapshot;record:SessionRecord;command:string;seconds:number;expiresAt:number;resolve:(r:ShellResult)=>void;reject:(e:unknown)=>void}
export interface ShellProposal {approvalId:string;vaultId:string;executionId:string;callId:string;command:string;commandHash:string;policyRevision:1;expiresAt:number;environmentId:string;workspace?:{snapshotId:string;hash:string;paths:string[];bytes:number};tool:'run_shell'|'run_project';version:'1';requestedAt:number}
/** A single authenticated Host service owns FIFO across clients. No lease expiry or PID reclamation. */
export class SharedVMController {
 private workspace:WorkspaceGateway;private snapshots=new Map<string,WorkspaceSnapshot>();
 private state=initialVMStatus();private backend:SharedBackend|null=null;
 private writes:Promise<void>=Promise.resolve();private lifecycle:Promise<unknown>=Promise.resolve();
 private queue:Pending[]=[];private active:Pending|null=null;private proposals=new Map<string,ShellProposal>();private cancelled=new Set<string>();
 private idle:ReturnType<typeof setTimeout>|undefined;private shutdownRequested=false;private poisoned=false;
 constructor(private readonly registry:VaultRegistry,private readonly journal:VMJournal,private readonly factory:()=>SharedBackend=()=>new AppleOfflineBackend(),private readonly idleMs=300000){this.workspace=new WorkspaceGateway(registry,new HostFileGateway(registry));}
 private discardProposal(id:string){const s=this.snapshots.get(id);if(s)this.workspace.discard(s.snapshotId);this.snapshots.delete(id);this.proposals.delete(id);}
 private context(vaultId:string,executionId:string):InvocationContext{return {vaultId,executionId,signal:new AbortController().signal};}
 async initialize(){if(!Number.isSafeInteger(this.idleMs)||this.idleMs<100||this.idleMs>3600000)fail('vm_invalid_idle');this.state=await this.journal.claim();this.state.policy.idleMs=this.idleMs;await this.persist();}
 private persist(){this.writes=this.writes.then(()=>this.journal.save(this.state)).catch(e=>{this.poisoned=true;throw e;});return this.writes;}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.lifecycle.then(work);this.lifecycle=next.catch(()=>{});return next;}
 summary(){return summarizeVMStatus(this.state);}
 status():SharedVMStatus{return structuredClone(this.state);}
 private guard(){if(this.poisoned||this.state.state==='STOP_UNCONFIRMED')fail('STOP_UNCONFIRMED');if(this.shutdownRequested)fail('vm_shutting_down');}
 async start(vaultId:string){return this.serial(()=>this.ensureStarted(vaultId));}
 private async ensureStarted(vaultId:string){
  this.guard();const vault=await this.registry.resolveVault(vaultId);
  if(this.state.state==='RUNNING'){if(this.state.vaultId!==vaultId||this.state.environmentId!==vault.environmentId)fail('vm_global_limit');return this.status();}
  if(!['STOPPED','STOP_CONFIRMED'].includes(this.state.state)||this.backend)fail('vm_busy');
  this.state.vaultId=vaultId;this.state.environmentId=vault.environmentId;this.state.vmInstanceId=randomUUID();this.state.generation++;this.state.state='STARTING';this.state.ready=false;
  await this.persist();this.backend=this.factory();this.backend.onFailure?.(()=>{if(this.state.state==='STOP_UNCONFIRMED')return;this.state.state='STOP_UNCONFIRMED';this.state.ready=false;void this.persist().catch(()=>{});void this.backend?.stop().catch(()=>{});});
  try{await this.backend.start();this.guard();this.state.state='RUNNING';this.state.ready=true;await this.persist();this.armIdle();return this.status();}
  catch(e){await this.stopInternal();throw e;}
 }
 private armIdle(){if(this.idle)clearTimeout(this.idle);this.idle=setTimeout(()=>{if(!this.active&&!this.queue.length)void this.stop().catch(()=>{});},this.idleMs);this.idle.unref();}
 async propose(vaultId:string,executionId:string,callId:string,command:string,paths?:string[]):Promise<ShellProposal>{
  this.guard();if(this.cancelled.has(executionId))fail('cancelled');if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>16384||command.includes('\0')||![executionId,callId].every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(x)))fail('vm_invalid_request');
  const vault=await this.registry.resolveVault(vaultId);
  for(const [id,p] of this.proposals)if(p.expiresAt<Date.now())this.discardProposal(id);
  if(this.proposals.size>=100)fail('approval_limit');
  const p:ShellProposal={approvalId:randomUUID(),vaultId,executionId,callId,command,commandHash:hash(command),policyRevision:1,expiresAt:Date.now()+60000,environmentId:vault.environmentId,tool:'run_shell',version:'1',requestedAt:Date.now()};if(paths!==undefined){
   const snapshot=await this.workspace.prepare(this.context(vaultId,executionId),paths);
   if(this.cancelled.has(executionId)){this.workspace.discard(snapshot.snapshotId);fail('cancelled');}
   p.tool='run_project';
   p.workspace={snapshotId:snapshot.snapshotId,hash:snapshot.hash,paths:snapshot.files.map(f=>f.path),bytes:snapshot.files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)};
   p.commandHash=hash(JSON.stringify([command,snapshot.hash]));this.snapshots.set(p.approvalId,snapshot);
  }
  this.proposals.set(p.approvalId,p);return structuredClone(p);
 }
 async executeApproved(approvalId:string,executionId?:string):Promise<ShellResult>{
  this.guard();const p=this.proposals.get(approvalId);this.proposals.delete(approvalId);const snapshot=this.snapshots.get(approvalId);this.snapshots.delete(approvalId);
  if(!p||(executionId!==undefined&&executionId!==p.executionId)||p.expiresAt<=Date.now()){if(snapshot)this.workspace.discard(snapshot.snapshotId);return fail('approval_invalid_or_expired');}
  // Caller is the trusted Host approval adapter. IDs/tokens never appear in model tools/results.
  const pending=await this.serial(async()=>{
   this.guard();if(this.cancelled.has(p.executionId))fail('cancelled');await this.ensureStarted(p.vaultId);
   this.guard();if(this.cancelled.has(p.executionId))fail('cancelled');if(p.expiresAt<=Date.now())fail('approval_expired');const vault=await this.registry.resolveVault(p.vaultId);if(vault.environmentId!==p.environmentId||this.state.vaultId!==p.vaultId)fail('vm_environment_changed');
   const invocationKey=hash(JSON.stringify([p.vaultId,p.executionId,p.callId]));
   if(this.state.sessions.some(s=>s.invocationKey===invocationKey))fail('duplicate_invocation');if(this.state.sessions.length>=10000)fail('vm_audit_limit');
   const record:SessionRecord={id:randomUUID(),executionId:p.executionId,callId:p.callId,invocationKey,commandHash:p.commandHash,vaultId:p.vaultId,vmInstanceId:this.state.vmInstanceId!,generation:this.state.generation,state:'QUEUED',createdAt:new Date().toISOString(),completedAt:null,cleanupConfirmed:false,resultHash:null};
   this.state.sessions.push(record);this.state.queued++;await this.persist();
   let resolve!:(r:ShellResult)=>void,reject!:(e:unknown)=>void;const result=new Promise<ShellResult>((a,b)=>{resolve=a;reject=b;});
   this.queue.push({snapshot,record,command:p.command,seconds:30,expiresAt:p.expiresAt,resolve,reject});return {result};
  }).catch(e=>{if(snapshot)this.workspace.discard(snapshot.snapshotId);throw e;});
  void this.pump();return pending.result;
 }
 private async pump(){
  if(this.active||!this.queue.length||this.poisoned)return;
  const job=this.active=this.queue.shift()!;this.state.queued--;this.state.activeSession=job.record.id;job.record.state='RUNNING';let dispatched=false;if(this.idle)clearTimeout(this.idle);
  try{
   this.guard();await this.registry.resolveVault(job.record.vaultId);await this.persist();
   if(this.cancelled.has(job.record.executionId)||Date.now()>=job.expiresAt){job.record.state='CANCELLED';job.record.completedAt=new Date().toISOString();this.state.activeSession=null;await this.persist();job.reject(new VaultError(Date.now()>=job.expiresAt?'approval_expired':'cancelled'));return;}
   const ctx=this.context(job.record.vaultId,job.record.executionId);
   const payload=job.snapshot?await this.workspace.transferApproved(ctx,job.snapshot,async()=>true):undefined;
   if(this.cancelled.has(job.record.executionId))fail('cancelled');
   dispatched=true;
   const value=await this.backend!.execute(job.record.id,job.command,job.seconds,payload?{workspace:payload}:undefined);
   if(!value.cleanupConfirmed)fail('session_cleanup_unconfirmed');
   const result:ShellResult={sessionId:job.record.id,vmInstanceId:job.record.vmInstanceId,generation:job.record.generation,...value};
   if(job.snapshot){
    const {workspace:returned,...bounded}=value;Object.assign(result,bounded);delete (result as any).workspace;
    try{if(value.workspaceStatus!=='complete'||!returned)throw Error('workspace_result_invalid');result.workspaceReview=await this.workspace.review(ctx,job.snapshot,returned);if(Buffer.byteLength(JSON.stringify(result))>120000){delete result.workspaceReview;result.workspaceReviewError='workspace_review_output_limit';}}
    catch{result.workspaceReviewError='workspace_review_failed';}
   }
   job.record.cleanupConfirmed=true;job.record.state=value.reason==='cancelled'?'CANCELLED':value.exitCode===0?'COMPLETED':'FAILED';job.record.completedAt=new Date().toISOString();job.record.resultHash=hash(JSON.stringify(result));this.state.activeSession=null;
   await this.persist();job.resolve(result);
  }catch(e){
   if(!dispatched&&!this.poisoned&&this.state.state==='RUNNING'){job.record.state='FAILED';job.record.cleanupConfirmed=true;job.record.completedAt=new Date().toISOString();this.state.activeSession=null;await this.persist();job.reject(e);return;}
   job.record.state='UNCONFIRMED';this.state.state='STOP_UNCONFIRMED';this.state.ready=false;
   try{await this.persist();}catch{};try{await this.backend?.stop();}catch{};
   job.reject(e);for(const q of this.queue){q.record.state='UNCONFIRMED';q.reject(new VaultError('STOP_UNCONFIRMED'));}this.queue=[];this.state.queued=0;try{await this.persist();}catch{}
  }finally{if(job.snapshot)this.workspace.discard(job.snapshot.snapshotId);this.active=null;if(this.state.state==='RUNNING'){this.armIdle();void this.pump();}}
 }
 async cancel(executionId:string){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(executionId))fail('vm_invalid_request');
  if(this.cancelled.size>=10000)fail('vm_audit_limit');this.cancelled.add(executionId);
  for(const [id,p] of this.proposals)if(p.executionId===executionId)this.discardProposal(id);
  if(this.active?.record.executionId===executionId)this.backend?.cancel(this.active.record.id);
  for(const job of this.queue.filter(j=>j.record.executionId===executionId)){
   this.queue.splice(this.queue.indexOf(job),1);job.record.state='CANCELLED';job.record.completedAt=new Date().toISOString();this.state.queued--;
   await this.persist();if(job.snapshot)this.workspace.discard(job.snapshot.snapshotId);job.reject(new VaultError('cancelled'));
  }
 }
 async stop(){return this.serial(async()=>{if(this.active||this.queue.length)fail('vm_execution_active');await this.stopInternal();return this.status();});}
 private async stopInternal(){
  if(this.idle)clearTimeout(this.idle);if(!this.backend)return;if(this.state.state==='STOP_UNCONFIRMED')fail('STOP_UNCONFIRMED');
  this.state.state='STOPPING';this.state.ready=false;await this.persist();
  try{await this.backend.stop();this.state.state='STOP_CONFIRMED';this.backend=null;await this.persist();}
  catch(e){this.state.state='STOP_UNCONFIRMED';await this.persist();throw e;}
 }
 async close(){this.shutdownRequested=true;for(const id of this.proposals.keys())this.discardProposal(id);if(this.active||this.queue.length)fail('vm_execution_active');await this.stop();await this.journal.release(this.state);}
}
