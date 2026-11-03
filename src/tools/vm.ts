import {VMClient} from '../vault/vm-client.js';
import {VaultError} from '../vault/types.js';
import type {ShellProposal} from '../vault/shared-vm.js';
import {result,type InvocationContext,type ToolCall,type ToolResult} from './contracts.js';
import type {VMToolPort} from './dispatcher.js';
export interface ShellApprovalChannel {request(proposal:ShellProposal,signal:AbortSignal):Promise<boolean>}
/** No model-facing approval token or target override. UI approves the service's exact immutable proposal. */
export class VMToolGateway implements VMToolPort {
 constructor(private readonly client:VMClient,private readonly approval:ShellApprovalChannel){}
 async invoke(ctx:InvocationContext,call:ToolCall):Promise<ToolResult>{
  let dispatched=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>{void this.client.request('cancel',{executionId:ctx.executionId}).catch(()=>{});};
  try{
   if(ctx.signal.aborted)return result(call.id,'cancelled','cancelled');if(!['run_shell','run_project'].includes(call.name))return result(call.id,'denied','tool_disabled');
   const p:ShellProposal=await this.client.request('propose',{vaultId:ctx.vaultId,executionId:ctx.executionId,callId:call.id,command:(call.arguments as {command:string}).command,...(call.name==='run_project'?{paths:(call.arguments as {paths:string}).paths.split('\n')}: {})},true);
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
   if(Buffer.byteLength(JSON.stringify(value))>120000)return result(call.id,'failed','output_limit');
   return result(call.id,value.reason==='cancelled'?'cancelled':value.reason==='timeout'?'failed':'succeeded',value.reason==='timeout'?'tool_timeout':value.reason==='cancelled'?'cancelled':'ok',JSON.stringify(value));
  }catch(e){const code=e instanceof VaultError?e.code:'vm_channel_failed';return result(call.id,dispatched?'unknown':ctx.signal.aborted?'cancelled':'failed',code);}
  finally{if(timer)clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);}
 }
}
