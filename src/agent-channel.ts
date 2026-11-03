import {readFile} from 'node:fs/promises';
import {providerId} from './adapters/index.js';
// Dedicated bounded NDJSON Host/UI channel; Provider responses never enter this input stream.
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {ConnectivityEngine} from './engine.js';
import {KeychainStore} from './credentials.js';
import {FileModelStore} from './storage.js';
import {VaultRegistry} from './vault/registry.js';
import {VMClient} from './vault/vm-client.js';
import {ToolRegistry,developmentTools,offlineShellTools} from './tools/registry.js';
import {ToolDispatcher} from './tools/dispatcher.js';
import {HostFileGateway} from './tools/files.js';
import {VMToolGateway} from './tools/vm.js';
import {SingleAgentRuntime,EngineAgentModel} from './agent/runtime.js';
import {NidusError} from './errors.js';
const emit=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
const abort=new AbortController();let started=false;let total=0;
const pending=new Map<string,(approved:boolean)=>void>();
process.stdin.on('data',b=>{total+=b.length;if(total>1048576)abort.abort();});
const input=createInterface({input:process.stdin});
input.on('close',()=>abort.abort());process.on('SIGTERM',()=>abort.abort());
input.on('line',line=>{
 if(line.length>131072){abort.abort();return;}
 let r:any;try{r=JSON.parse(line);}catch{abort.abort();return;}
 if(r.method==='cancel'){abort.abort();return;}
 if(r.method==='approval'){const resolve=pending.get(r.approvalId);if(resolve){pending.delete(r.approvalId);resolve(r.approved===true);}return;}
 if(started||!['run','direct-shell'].includes(r.method)||typeof r.vaultId!=='string'||(r.method==='run'&&(r.confirmDataSharing!==true||typeof r.provider!=='string'||typeof r.model!=='string'||typeof r.prompt!=='string'))||(r.method==='direct-shell'&&typeof r.command!=='string')){emit({event:'error',code:'invalid_agent_request'});return;}
 started=true;
 void (async()=>{
  const registry=new VaultRegistry(process.env.NIDUS_VAULT_REGISTRY),client=new VMClient(registry);
  const vm=new VMToolGateway(client,{request:(p,signal)=>new Promise(resolve=>{
   const answer=(yes:boolean)=>{signal.removeEventListener('abort',cancel);pending.delete(p.approvalId);resolve(yes);};
   const cancel=()=>answer(false);pending.set(p.approvalId,answer);signal.addEventListener('abort',cancel,{once:true});
   emit({event:'approval',proposal:p});if(signal.aborted)cancel();
  })});
  let development=false;try{development=JSON.parse(await readFile(new URL('./vm-assets/manifest.json',import.meta.url),'utf8')).profile==='development';}catch{}
  const definitions=development?developmentTools():offlineShellTools();
  const tools=new ToolDispatcher(new ToolRegistry(definitions),new HostFileGateway(registry),undefined,{},vm);
  if(r.method==='direct-shell'){
   const call={id:randomUUID(),name:r.paths?'run_project':'run_shell',arguments:r.paths?{command:r.command,paths:r.paths}:{command:r.command}};new ToolRegistry(definitions).validate(call.name,call.arguments);
   emit({event:'tool',name:call.name});const context={vaultId:r.vaultId,executionId:randomUUID(),signal:abort.signal};const result=await tools.invoke(context,call);tools.finishExecution(context.executionId);
   emit({event:'tool-result',name:call.name,result});emit({event:'completed',task:{status:result.status,code:result.code,text:'직접 Shell 검토 — Provider 호출 없음'}});return;
  }
  const engine=new ConnectivityEngine(new KeychainStore(),new FileModelStore());
  const runtime=new SingleAgentRuntime(new EngineAgentModel(engine,providerId(r.provider)),tools);
  const task=await runtime.run({vaultId:r.vaultId,model:r.model,prompt:r.prompt,requiresWeb:r.requiresWeb===true,signal:abort.signal,onEvent:emit});emit({event:'completed',task});
 })().catch(e=>emit({event:'error',code:e instanceof NidusError?e.code:'agent_failed'})).finally(()=>{abort.abort();pending.clear();input.close();process.stdin.destroy();});
});
