import { randomUUID } from 'node:crypto';
import { bytes, result, ToolError, fail, type InvocationContext, type ToolCall, type ToolResult } from './contracts.js';
import { HostFileGateway } from './files.js';
import { PermissionGateway } from './permission.js';
import { ToolRegistry, matches } from './registry.js';
export class ToolDispatcher {
  private used=new Map<string,Set<string>>();
  /** Host-owned task scopes. Completed scopes must never be resumed. */
  finishExecution(executionId:string){this.used.delete(executionId);this.readReserved.delete(executionId);}
  get retainedExecutions(){return this.used.size;}
  private readReserved=new Map<string,number>();
  readonly mode:'product'|'test';
  constructor(readonly registry:ToolRegistry,private readonly files:HostFileGateway,private readonly permissions=new PermissionGateway(),options:{mode?:'product'|'test'}={}){this.mode=options.mode??'product';}
  validateVault(vaultId:string){return this.files.validateVault(vaultId);}
  available(){return this.registry.available(this.mode==='test' && this.permissions.adapter.source==='mock').filter(d=>this.permissions.policy(d)!=='DENY');}
  async invoke(ctx:InvocationContext,call:ToolCall):Promise<ToolResult>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const d=this.registry.validate(call.name,call.arguments);let calls=this.used.get(ctx.executionId);
      if(!calls){if(this.used.size>=128)fail('execution_scope_limit');calls=new Set();this.used.set(ctx.executionId,calls);}
      if(calls.has(call.id))fail('duplicate_invocation');if(calls.size>=100)fail('tool_limit');calls.add(call.id);
      if(ctx.signal.aborted)fail('cancelled');if(!this.available().some(t=>t.name===d.name))fail('tool_disabled');
      const policy=this.permissions.policy(d);if(policy==='DENY')fail('permission_denied');if(!d.sideEffect && policy==='REQUIRE_APPROVAL')fail('read_approval_unsupported');
      const abort=new AbortController();timer=setTimeout(()=>abort.abort(),d.timeoutMs);const work={...ctx,signal:AbortSignal.any([ctx.signal,abort.signal])};
      const a=call.arguments as Record<string,string>;let data:unknown;
      if(!d.sideEffect){const used=this.readReserved.get(ctx.executionId)??0,cost=d.name==='search_files'?262144:d.name==='read_file'?65536:131072;if(used+cost>1048576)fail('total_read_limit');this.readReserved.set(ctx.executionId,used+cost);}
      if(d.sideEffect){
        const plan=await this.files.prepare(work,call.id,d.name,a);
        try{const token=await this.permissions.approve(plan,d,work.signal);const file=await this.files.applyApproved(work,plan,this.permissions,token);data={path:file.path,hash:file.hash,version:file.version,approvalSource:this.permissions.adapter.source};}
        finally{this.files.discard(plan);}
      }else if(d.name==='read_file')data=await this.files.read(work,a.path!);
      else if(d.name==='list_files')data=await this.files.list(work,a.path!);
      else if(d.name==='search_files')data=await this.files.search(work,a.path!,a.query!);
      else fail('tool_disabled');
      const r=result(call.id,'succeeded','ok',JSON.stringify(data));if(bytes(r)>d.maxOutputBytes || !matches(d.outputSchema,r.content))fail('output_limit');return r;
    }catch(e){const code=e instanceof ToolError?e.code:ctx.signal.aborted?'cancelled':'tool_failed';return result(call.id,code==='outcome_unknown'?'unknown':code==='cancelled'?'cancelled':['permission_denied','tool_disabled'].includes(code)?'denied':'failed',code);}
    finally{if(timer)clearTimeout(timer);}
  }
  /** Trusted Host entry point for proposal preview; product mutation remains disabled. */
  async preview(ctx:InvocationContext,name:string,args:unknown){this.registry.validate(name,args);return this.files.prepare(ctx,randomUUID(),name,args as Record<string,string>);}
}
