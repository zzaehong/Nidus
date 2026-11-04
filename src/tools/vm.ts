import {VMClient} from '../vault/vm-client.js';
import {randomUUID} from 'node:crypto';
import {VaultError} from '../vault/types.js';
import type {ShellProposal} from '../vault/shared-vm.js';
import type {LiveApproval} from '../vault/live-browser.js';
import {result,type InvocationContext,type ToolCall,type ToolResult} from './contracts.js';
import type {VMToolPort} from './dispatcher.js';
export interface ShellApprovalChannel {request(proposal:ShellProposal|LiveApproval,signal:AbortSignal):Promise<boolean>}
/** No model-facing approval token or target override. UI approves the service's exact immutable proposal. */
export class VMToolGateway implements VMToolPort {
 private pages=new Map<string,{vaultId:string;executionId:string;page:unknown}>();
 private liveOwners=new Map<string,string>();
 finishExecution(executionId:string){for(const [id,p] of this.pages)if(p.executionId===executionId)this.pages.delete(id);const vaultId=this.liveOwners.get(executionId);if(vaultId){this.liveOwners.delete(executionId);return this.client.request('live-close',{vaultId,executionId}).then(()=>{});}}
 constructor(private readonly client:VMClient,private readonly approval:ShellApprovalChannel){}
 async invoke(ctx:InvocationContext,call:ToolCall):Promise<ToolResult>{
  let dispatched=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>{void this.client.request('cancel',{executionId:ctx.executionId}).catch(()=>{});};
  try{
   if(ctx.signal.aborted)return result(call.id,'cancelled','cancelled');
   if(['browser_start','browser_observe','browser_click','browser_type','browser_scroll','browser_back','browser_close'].includes(call.name))return await this.invokeLive(ctx,call);
   if(call.name==='browser_read_page'){
    const pageId=(call.arguments as {pageId:string}).pageId,p=this.pages.get(pageId);
    return p&&p.vaultId===ctx.vaultId&&p.executionId===ctx.executionId?result(call.id,'succeeded','ok',JSON.stringify({pageId,...p.page as object})):result(call.id,'failed','browser_page_unavailable');
   }
   if(!['run_shell','run_project','browser_search','browser_navigate'].includes(call.name))return result(call.id,'denied','tool_disabled');
   const browser=call.name.startsWith('browser_');
   if(browser&&this.pages.size>=20)return result(call.id,'failed','browser_page_limit');
   const p:ShellProposal=await this.client.request(browser?'propose-browser':'propose',{vaultId:ctx.vaultId,executionId:ctx.executionId,callId:call.id,...(browser?{tool:call.name,value:(call.arguments as Record<string,string>)[call.name==='browser_search'?'query':'url']}:{command:(call.arguments as {command:string}).command,...(call.name==='run_project'?{paths:(call.arguments as {paths:string}).paths.split('\n')}: {})})},true);
   const deadline=new AbortController(),signal=AbortSignal.any([ctx.signal,deadline.signal]);timer=setTimeout(()=>deadline.abort(),Math.max(0,p.expiresAt-Date.now()));
   let onAbort:(()=>void)|undefined;
   let approved=false;
   try{approved=await Promise.race([this.approval.request(p,signal),new Promise<boolean>(resolve=>{onAbort=()=>resolve(false);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();})]);}
   finally{if(onAbort)signal.removeEventListener('abort',onAbort);deadline.abort();}
   if(ctx.signal.aborted){abort();return result(call.id,'cancelled','cancelled');}
   if(!approved||Date.now()>=p.expiresAt)return result(call.id,'denied','permission_denied');
   ctx.signal.addEventListener('abort',abort,{once:true});if(ctx.signal.aborted){abort();return result(call.id,'cancelled','cancelled');}
   dispatched=true;
   const value=await this.client.request('executeApproved',{approvalId:p.approvalId,executionId:ctx.executionId});
   if(!value.cleanupConfirmed)return result(call.id,'unknown','session_cleanup_unconfirmed');
   if(browser){
    if(value.reason==='cancelled')return result(call.id,'cancelled','cancelled');
    if(value.exitCode!==0&&value.stderr==='browser_search_unrelated')return result(call.id,'failed','browser_search_unrelated','검색 결과 본문이 검색어의 핵심 단어와 맞지 않아 사용하지 않았습니다. 해당 결과를 근거로 답변하지 마세요. 검색어를 바꾸거나 공식 출처 URL을 별도로 승인받아 읽을 수 있습니다. 이 검사는 단순 어휘 검사이며 의미상 관련성을 보증하지 않습니다.');
    if(value.exitCode!==0||!value.browser)return result(call.id,'failed',value.reason==='timeout'?'tool_timeout':'browser_render_failed');
    const pageId=randomUUID();this.pages.set(pageId,{vaultId:ctx.vaultId,executionId:ctx.executionId,page:value.browser});
    return result(call.id,'succeeded','ok',JSON.stringify({pageId,...value.browser}));
   }
   if(Buffer.byteLength(JSON.stringify(value))>120000)return result(call.id,'failed','output_limit');
   return result(call.id,value.reason==='cancelled'?'cancelled':value.reason==='timeout'?'failed':'succeeded',value.reason==='timeout'?'tool_timeout':value.reason==='cancelled'?'cancelled':'ok',JSON.stringify(value));
  }catch(e){const code=e instanceof VaultError?e.code:'vm_channel_failed';const known=code.startsWith('browser_')||code.startsWith('network_');return result(call.id,ctx.signal.aborted&&known?'cancelled':dispatched&&!known?'unknown':'failed',code);}
  finally{if(timer)clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);}
 }
 private async invokeLive(ctx:InvocationContext,call:ToolCall):Promise<ToolResult>{
  const start=call.name==='browser_start',close=call.name==='browser_close';
  if(!start&&this.liveOwners.get(ctx.executionId)!==ctx.vaultId)return result(call.id,'failed','browser_session_owner');
  if(start)this.liveOwners.set(ctx.executionId,ctx.vaultId);
  const abort=()=>{void this.client.request('cancel',{executionId:ctx.executionId}).catch(()=>{});};ctx.signal.addEventListener('abort',abort,{once:true});
  try{
   const value=await this.client.request(start?'live-open':close?'live-close':'live-action',{vaultId:ctx.vaultId,executionId:ctx.executionId,callId:call.id,...(!start&&!close?{action:{op:call.name.slice('browser_'.length),...call.arguments as object}}:{})},start,event=>{
    if(event.event!=='approval')return;
    void (async()=>{let approved=false;try{approved=await this.approval.request(event.proposal,ctx.signal);}finally{await this.client.request('live-answer',{executionId:ctx.executionId,approvalId:event.proposal.approvalId,approved}).catch(()=>{});}})().catch(()=>{});
   });
   if(close)this.liveOwners.delete(ctx.executionId);
   return result(call.id,'succeeded','ok',JSON.stringify(value));
  }catch(e){const code=e instanceof VaultError?e.code:'browser_channel_failed';return result(call.id,code==='STOP_UNCONFIRMED'||code.includes('cleanup_unconfirmed')||code==='browser_action_outcome_unknown'?'unknown':ctx.signal.aborted?'cancelled':code==='browser_permission_denied'?'denied':'failed',code);}
  finally{ctx.signal.removeEventListener('abort',abort);}
 }
}
