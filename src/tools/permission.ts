import { randomUUID } from 'node:crypto';
import { digest, type ChangePlan } from './files.js';
import { fail, type Permission, type ToolDefinition } from './contracts.js';
export interface ApprovalRequest {
  approvalId:string;vaultId:string;executionId:string;callId:string;tool:string;version:string;path:string;
  changeHash:string;beforeHash:string|null;fileVersion:Record<string,string>|null;policyRevision:number;
  requestedAt:number;expiresAt:number;diff:string;
}
export interface ApprovalAdapter { readonly source:'user'|'mock'|'none'; request(r:Readonly<ApprovalRequest>,signal:AbortSignal):Promise<boolean> }
export class DenyApprovalAdapter implements ApprovalAdapter {readonly source='none' as const;async request(){return false;}}
/** Callback must be wired to a trusted Host UI, never to model responses. */
export class HostApprovalAdapter implements ApprovalAdapter {
  readonly source='user' as const;
  constructor(private readonly displayAndWait:(r:Readonly<ApprovalRequest>,signal:AbortSignal)=>Promise<boolean>){}
  request(r:Readonly<ApprovalRequest>,signal:AbortSignal){return this.displayAndWait(r,signal);}
}
export class MockApprovalAdapter implements ApprovalAdapter {
  readonly source='mock' as const;
  constructor(private readonly answer:(r:Readonly<ApprovalRequest>,signal:AbortSignal)=>Promise<boolean>=async()=>false){}
  request(r:Readonly<ApprovalRequest>,signal:AbortSignal){return this.answer(r,signal);}
}
interface Grant { token:string;request:ApprovalRequest;approvedAt:number;source:'user'|'mock'|'none';binding:string }
export class PermissionGateway {
  private revision=1;private overrides=new Map<string,Permission>();private grants=new Map<string,Grant>();
  constructor(readonly adapter:ApprovalAdapter=new DenyApprovalAdapter(),private readonly now=()=>Date.now()){}
  finishExecution(executionId:string){for(const [token,g] of this.grants)if(g.request.executionId===executionId)this.grants.delete(token);}
  get policyRevision(){return this.revision;}
  setPolicy(tool:string,policy:Permission){if(!['ALLOW','DENY','REQUIRE_APPROVAL'].includes(policy))fail('invalid_policy');this.overrides.set(tool,policy);this.revision++;this.grants.clear();}
  policy(d:ToolDefinition):Permission{if(!d.implemented)return 'DENY';const policy=this.overrides.get(d.name)??d.approval;return d.sideEffect && policy==='ALLOW'?'REQUIRE_APPROVAL':policy;}
  async approve(plan:ChangePlan,d:ToolDefinition,signal:AbortSignal,ttlMs=60000):Promise<string>{
    if(plan.tool!==d.name || plan.version!==d.version)fail('approval_mismatch');
    if(signal.aborted)fail('cancelled');if(this.policy(d)==='DENY' || this.adapter.source==='none')fail('permission_denied');
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>300000)fail('invalid_approval_ttl');
    const r:ApprovalRequest={approvalId:randomUUID(),vaultId:plan.vaultId,executionId:plan.executionId,callId:plan.callId,tool:d.name,version:d.version,path:plan.path,changeHash:plan.hash,beforeHash:plan.before?.hash??null,fileVersion:plan.before?.version??null,policyRevision:this.revision,requestedAt:this.now(),expiresAt:this.now()+ttlMs,diff:plan.diff};
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
    let abort:(()=>void)|undefined;
    try{
      const approved=await Promise.race([this.adapter.request(structuredClone(r),combined),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('cancelled'));combined.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(),ttlMs);if(combined.aborted)abort();})]);
      if(signal.aborted)fail('cancelled');if(this.now()>=r.expiresAt)fail('approval_expired');if(this.revision!==r.policyRevision)fail('policy_changed');if(approved!==true)fail('permission_denied');
      const token=randomUUID();this.grants.set(token,{token,request:r,approvedAt:this.now(),source:this.adapter.source,binding:digest(plan)});return token;
    }catch(e){if(e instanceof Error && e.message==='cancelled')fail(signal.aborted?'cancelled':'approval_expired');throw e;}
    finally{if(timer)clearTimeout(timer);if(abort)combined.removeEventListener('abort',abort);controller.abort();}
  }
  consume(token:string,plan:ChangePlan,signal:AbortSignal):{source:string;approvedAt:number}{
    const grant=this.grants.get(token);this.grants.delete(token);
    if(!grant)fail('invalid_approval');if(signal.aborted)fail('cancelled');
    if(grant!.request.policyRevision!==this.revision)fail('policy_changed');if(this.now()>=grant!.request.expiresAt)fail('approval_expired');
    if(grant!.binding!==digest(plan))fail('approval_mismatch');return {source:grant!.source,approvedAt:grant!.approvedAt};
  }
}
