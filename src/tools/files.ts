import type { PermissionGateway } from './permission.js';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VaultRegistry } from '../vault/registry.js';
import { fail, ToolError, type InvocationContext } from './contracts.js';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface FileView { path: string; content: string; hash: string; version: Record<string,string> }
export interface ChangePlan {
  id: string; vaultId: string; executionId: string; callId: string; tool: string; version: '1'; path: string;
  kind: 'create' | 'replace' | 'delete'; before: FileView | null; after: string | null;
  rootIdentity: Record<string,string>; diff: string; hash: string;
}
export class HostFileGateway {
  private plans = new Map<string,ChangePlan>();
  finishExecution(executionId:string){for(const [id,p] of this.plans)if(p.executionId===executionId)this.plans.delete(id);}
  constructor(private readonly registry: VaultRegistry) {}
  private async native(ctx: InvocationContext, operation: string, path: string, content?: string, beforeDispatch?: () => void): Promise<any> {
    if(process.platform!=='darwin') return fail('filesystem_platform_unsupported');
    ctx.signal.throwIfAborted(); const vault=await this.registry.resolveVault(ctx.vaultId);ctx.signal.throwIfAborted();
    beforeDispatch?.();
    const helper=fileURLToPath(new URL('../nidus-vault-files',import.meta.url));
    const data=await new Promise<any>((resolve,reject)=>{
      const child=spawn(helper,[],{stdio:['pipe','pipe','ignore']});const chunks:Buffer[]=[];let size=0;let interrupted=false;
      const abort=()=>{interrupted=true;child.kill('SIGKILL');};ctx.signal.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(abort,10000);
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>262144){abort();return;}chunks.push(chunk);});
      child.stdin.on('error',()=>{});
      child.on('error',()=>reject(new ToolError('helper_unavailable')));
      child.on('close',()=>{clearTimeout(timer);ctx.signal.removeEventListener('abort',abort);
        if(interrupted)return reject(new ToolError(operation==='create'?'outcome_unknown':'cancelled'));
        try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value.ok)reject(new ToolError(value.code));else resolve(value.data);}catch{reject(new ToolError(operation==='create'?'outcome_unknown':'helper_failed'));}
      });
      child.stdin.end(JSON.stringify({root:vault.canonicalRoot,identity:vault.identity,operation,path,content}));
      if(ctx.signal.aborted)abort();
    });
    try {const current=await this.registry.resolveVault(ctx.vaultId);if(digest(current.identity)!==digest(vault.identity)) fail('root_replaced');}
    catch(e){if(operation==='create')return fail('outcome_unknown');throw e;}
    return data;
  }
  async validateVault(vaultId:string){await this.registry.resolveVault(vaultId);}
  async read(ctx: InvocationContext,path:string):Promise<FileView>{return this.native(ctx,'read',path);}
  async list(ctx: InvocationContext,path:string):Promise<{entries:{path:string;kind:'file'|'directory'}[]}>{return this.native(ctx,'list',path);}
  async search(ctx: InvocationContext,path:string,query:string) {
    if(!query || query.length>256)fail('invalid_query');
    const directories=[path],matches:{path:string;line:number;text:string}[]=[];let count=0,total=0;
    while(directories.length){
      ctx.signal.throwIfAborted();const entries=(await this.list(ctx,directories.shift()!)).entries;
      for(const entry of entries){if(++count>200)fail('scan_limit');if(entry.kind==='directory'){directories.push(entry.path);continue;}
        if(total+65536>262144)fail('read_budget');
        const file=await this.read(ctx,entry.path);total+=Buffer.byteLength(file.content);if(total>262144)fail('read_budget');
        for(const [i,line] of file.content.split('\n').entries())if(line.includes(query)){matches.push({path:entry.path,line:i+1,text:line.slice(0,500)});if(matches.length>=100)return {matches,bytesRead:total,truncated:true};}
      }
    }
    return {matches,bytesRead:total,truncated:false};
  }
  async prepare(ctx: InvocationContext,callId:string,tool:string,args:Record<string,string>):Promise<ChangePlan>{
    const path=args.path!,view=await this.native(ctx,'inspect',path),before:FileView|null=view.exists?view.file:null;
    let after:string|null=args.content??null;
    if(tool==='apply_patch'){
      if(!before || !args.oldText || before.content.split(args.oldText).length!==2)fail('patch_context_mismatch');
      after=before!.content.replace(args.oldText!,args.newText!);
    }else if(tool==='delete_file'){if(!before)fail('file_not_found');after=null;}
    else if(tool!=='write_file')fail('unknown_tool');
    if(after!==null && Buffer.byteLength(after)>65536)fail('file_too_large');
    const v=await this.registry.resolveVault(ctx.vaultId);
    const plan:ChangePlan={id:randomUUID(),vaultId:ctx.vaultId,executionId:ctx.executionId,callId,tool,version:'1',path,kind:!before?'create':after===null?'delete':'replace',before,after,rootIdentity:{...v.identity},
      diff:`--- ${before?path:'/dev/null'}\n+++ ${after===null?'/dev/null':path}\n`+(before?.content.split('\n').map(x=>'-'+x).join('\n')??'')+'\n'+(after?.split('\n').map(x=>'+'+x).join('\n')??''),hash:''};
    plan.hash=digest({...plan,hash:undefined});this.plans.set(plan.id,structuredClone(plan));return structuredClone(plan);
  }
  discard(plan:ChangePlan){this.plans.delete(plan.id);}
  /** Trusted Host entry point; consumes a one-use grant before any change. */
  async applyApproved(ctx:InvocationContext,plan:ChangePlan,permissions:PermissionGateway,token:string):Promise<FileView>{
    if(!permissions || !token)fail('invalid_approval');
    permissions.consume(token,plan,ctx.signal);
    const revision=permissions.policyRevision;
    const original=this.plans.get(plan.id);this.plans.delete(plan.id);
    if(!original || digest(original)!==digest(plan) || plan.vaultId!==ctx.vaultId || plan.executionId!==ctx.executionId)fail('proposal_changed');
    ctx.signal.throwIfAborted();const current=await this.registry.resolveVault(ctx.vaultId);
    if(digest(current.identity)!==digest(plan.rootIdentity))fail('root_replaced');
    const view=await this.native(ctx,'inspect',plan.path);
    if(digest(view.exists?view.file:null)!==digest(plan.before))fail('file_changed');
    if(plan.kind!=='create')fail('existing_mutation_disabled');
    if(plan.path.includes('/'))fail('nested_create_disabled');
    return this.native(ctx,'create',plan.path,plan.after!,()=>{if(permissions.policyRevision!==revision)fail('policy_changed');});
  }
}
