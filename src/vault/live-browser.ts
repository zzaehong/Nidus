import {createHash,randomUUID} from 'node:crypto';
import type {SharedBackend} from './apple-backend.js';
import {liveRequest,validateLiveRequest,needsNetworkApproval,type LiveRequest} from './live-network.js';
import {VaultError} from './types.js';
export interface LiveAction {op:'observe'|'navigate'|'click'|'type'|'scroll'|'back';url?:string;snapshotId?:string;targetId?:string;text?:string;delta?:number}
export interface LiveApproval {approvalId:string;vaultId:string;executionId:string;command:string;commandHash:string;expiresAt:number;liveBrowser:true;scope:string}
export type LiveApprover=(p:LiveApproval,signal:AbortSignal)=>Promise<boolean>;
/** One task owns one persistent browser, including its transient cookies and DOM. */
export class LiveBrowser {
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private abort=new AbortController();private approve:LiveApprover|undefined;private approving=Promise.resolve();private requests=0;private bytes=0;private busy=false;private failed=false;private responses=0;private blocked=0;private observation:any;private observedId='';
 private framePending:{id:string;resolve:(v:any)=>void;timer:ReturnType<typeof setTimeout>}|undefined;private lastFrameAt=0;
 async frame(){
  if(this.failed||this.signal.aborted||this.framePending||Date.now()-this.lastFrameAt<900)return null;this.lastFrameAt=Date.now();
  return new Promise<any>(resolve=>{const id=randomUUID(),timer=setTimeout(()=>{this.framePending=undefined;resolve(null);},5000);this.framePending={id,resolve,timer};void this.backend.sendLive!({op:'frame',id}).catch(()=>{if(this.framePending?.id===id){clearTimeout(timer);this.framePending=undefined;resolve(null);}});});
 }
 readonly id=randomUUID();
 get signal(){return this.abort.signal;}
 cancel(){this.abort.abort();this.backend.cancel(this.id);}
 constructor(readonly vaultId:string,readonly executionId:string,private backend:SharedBackend,private transport=liveRequest){}
 async start(){if(!this.backend.beginLive||!this.backend.sendLive||!this.backend.endLive)throw new VaultError('browser_interactive_unsupported');await this.backend.beginLive(this.id,e=>this.event(e));}
 private event(e:any){
  if(e.event==='frame'){const p=this.framePending;if(!p||p.id!==e.id)return;clearTimeout(p.timer);this.framePending=undefined;const data=e.data;const valid=!e.error&&typeof data==='string'&&data.length<=90000&&/^[A-Za-z0-9+/]+={0,2}$/.test(data)&&Buffer.from(data,'base64').subarray(0,3).equals(Buffer.from([255,216,255]));p.resolve(valid?{data,capturedAt:new Date().toISOString()}:null);return;}
  if(e.event==='request'){void this.fetch(e);return;}
  if(e.event==='result'){const p=this.pending.get(e.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(e.id);e.error?p.reject(new VaultError(/^browser_[a-z_]+$/.test(e.error)?e.error:'browser_action_failed')):p.resolve(e.value);}
  if(e.event==='fatal'||e.event==='ended'){this.failed=true;this.abort.abort();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new VaultError('browser_session_ended'));}this.pending.clear();}
 }
 private async fetch(value:any){
  let request:LiveRequest|undefined;
  try{
   request=validateLiveRequest(value);if(this.abort.signal.aborted||++this.requests>300||this.bytes>=16*1024*1024)throw new VaultError('browser_network_budget');
   // Never authorize background sensitive traffic when no trusted Host action is waiting.
   if(needsNetworkApproval(request)){
    const approver=this.approve;if(!approver)throw new VaultError('browser_network_approval_required');
    const r=request;let allowed=false;
    const next=this.approving.then(async()=>{const proposal:LiveApproval={approvalId:randomUUID(),vaultId:this.vaultId,executionId:this.executionId,command:`${r.method} ${r.url}\n요청 본문 ${Buffer.byteLength(r.body)} bytes · 인증/쿠키 ${!!(r.headers.authorization||r.headers.cookie)}\n${r.body.slice(0,2048)}`,commandHash:createHash('sha256').update(JSON.stringify(r)).digest('hex'),expiresAt:Date.now()+60000,liveBrowser:true,scope:'network-sensitive'};allowed=await approver(proposal,this.abort.signal);allowed=allowed&&!this.abort.signal.aborted&&Date.now()<proposal.expiresAt;});this.approving=next.catch(()=>{});await next;if(!allowed)throw new VaultError('browser_network_denied');
   }
   const response=await this.transport(request,this.abort.signal);this.bytes+=Buffer.byteLength(response.body,'base64');if(this.bytes>16*1024*1024)throw new VaultError('browser_network_budget');this.responses++;
   await this.backend.sendLive!({op:'response',requestId:request.requestId,...response});
  }catch{this.blocked++;if(!this.abort.signal.aborted&&typeof value.requestId==='string')await this.backend.sendLive!({op:'response',requestId:value.requestId,error:true}).catch(()=>{});}
 }
 async action(action:LiveAction,approve:LiveApprover){
  if(this.failed||this.abort.signal.aborted)throw new VaultError('browser_session_ended');if(this.busy)throw new VaultError('browser_action_busy');
  if(!['observe','navigate','click','type','scroll','back'].includes(action.op))throw new VaultError('browser_action_invalid');
  if(['click','type'].includes(action.op)){
   if(action.snapshotId!==this.observedId||!this.observation?.elements?.some((e:any)=>e.id===action.targetId))throw new VaultError('browser_stale_observation');
   if(action.op==='type'&&(typeof action.text!=='string'||action.text.length>2048))throw new VaultError('browser_input_limit');
  }
  if(action.op==='scroll'&&(!Number.isSafeInteger(action.delta)||Math.abs(action.delta!)>1000))throw new VaultError('browser_action_invalid');
  this.busy=true;this.approve=approve;const id=randomUUID();
  try{
   const value=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);this.cancel();reject(new VaultError('browser_action_timeout'));},75000);this.pending.set(id,{resolve,reject,timer});void this.backend.sendLive!({...action,id}).catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});});
   if(!value||value.sandboxVerified!==true||typeof value.url!=='string'||typeof value.title!=='string'||typeof value.text!=='string'||!Array.isArray(value.elements)||value.elements.length>60||typeof value.snapshotId!=='string'||Buffer.byteLength(JSON.stringify(value))>60000)throw new VaultError('browser_observation_invalid');
   this.observation=structuredClone(value);this.observedId=value.snapshotId;return {...value,retrievedAt:new Date().toISOString(),networkResponses:this.responses,networkBlocked:this.blocked,mode:'interactive-browser'};
  }finally{this.busy=false;this.approve=undefined;}
 }
 preview(action:LiveAction){const e=this.observation?.elements?.find((e:any)=>e.id===action.targetId);return `${action.op} ${e?.tag??''} ${e?.name??''}\n대상 링크: ${e?.href??''}\n페이지: ${this.observation?.url??''}\n${action.op==='type'?`입력 ${action.text?.length??0}자: ${action.text??''}\n(입력 중에도 사이트 스크립트가 읽을 수 있음)`:''}`;}
 async close(){if(this.framePending){clearTimeout(this.framePending.timer);this.framePending.resolve(null);this.framePending=undefined;}this.abort.abort();await this.backend.endLive!();this.failed=true;}
}
