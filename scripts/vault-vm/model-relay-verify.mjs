// Explicit real VM integration. Provider responses and approval decisions are synthetic fixtures.
import {mkdtemp,mkdir,realpath,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {ConnectivityEngine} from '../../dist/engine.js';import {UsageLedger} from '../../dist/ledger.js';import {VaultRegistry} from '../../dist/vault/registry.js';import {VMJournal} from '../../dist/vault/vm-journal.js';import {SharedVMController} from '../../dist/vault/shared-vm.js';import {SingleAgentRuntime,EngineAgentModel} from '../../dist/agent/runtime.js';import {HostFileGateway} from '../../dist/tools/files.js';import {ToolRegistry,offlineShellTools} from '../../dist/tools/registry.js';import {ToolDispatcher} from '../../dist/tools/dispatcher.js';import {VMToolGateway} from '../../dist/tools/vm.js';import {authorize} from '../../tests/helpers/permissions.mjs';
const base=await realpath(await mkdtemp('/private/tmp/nidus-relay-'));await mkdir(join(base,'vault'));const registry=new VaultRegistry(join(base,'host')),vault=await registry.registerVault(join(base,'vault'));const controller=new SharedVMController(registry,new VMJournal(join(base,'vm')));const checks=[];
const port={request:async(method,args)=>{if(method==='propose')return controller.propose(args.vaultId,args.executionId,args.callId,args.command);if(method==='executeApproved')return controller.executeApproved(args.approvalId,args.executionId);if(method==='cancel')return controller.cancel(args.executionId);throw Error(method);}};
async function run(provider,approved){
 const ledger=authorize(new UsageLedger(':memory:'),'fixture');let requests=0,approvals=0;
 const model={provider,id:'fixture-text',name:'Fixture',capabilities:{chat:'supported',tools:'unsupported'},details:{},limits:{}};
 const engine=new ConnectivityEngine({get:async p=>p===provider?'fixture':null},{load:async()=>({models:[model]})},{[provider]:{chat:async(_key,request)=>{
  requests++;const history=JSON.parse(request.messages[0].content).history;
  return {provider,model:model.id,finishReason:'stop',usage:{inputTokens:10,outputTokens:5,totalTokens:15,providerUsage:{}},text:JSON.stringify(history.length?{text:'finished',calls:[]}:{text:'proposed test',calls:[{name:'run_shell',arguments:{command:"python3 -c 'print(2+2)'"}}]})};
 }}},ledger);
 try{
  const tools=new ToolDispatcher(new ToolRegistry(offlineShellTools()),new HostFileGateway(registry),undefined,{},new VMToolGateway(port,{request:async()=>{approvals++;return approved;}}));
  const result=await new SingleAgentRuntime(new EngineAgentModel(engine,provider),tools).run({vaultId:vault.vaultId,model:model.id,prompt:'synthetic VM check'});
  assert.equal(result.status,'COMPLETED');assert.equal(requests,2);assert.equal(approvals,1);
  const tool=result.steps[0].invocations[0].result;
  if(approved){assert.equal(tool.status,'succeeded');const output=JSON.parse(tool.content.text);assert.equal(output.stdout,'4\n');assert.equal(output.cleanupConfirmed,true);}
  else assert.equal(tool.code,'permission_denied');
  checks.push({name:provider+(approved?'-approved':'-denied'),status:'PASS',requests,approval:'synthetic fixture',instance:controller.status().vmInstanceId,generation:controller.status().generation});
 }finally{ledger.close();}
}
try{
 await controller.initialize();await run('nvidia',false);assert.equal(controller.status().generation,0);
 await run('nvidia',true);const instance=controller.status().vmInstanceId;await run('gemini',true);assert.equal(controller.status().vmInstanceId,instance);checks.push({name:'different-models-reuse-one-VM',status:'PASS'});
 await controller.stop();assert.equal(controller.status().state,'STOP_CONFIRMED');checks.push({name:'confirmed-stop',status:'PASS'});
}catch(error){checks.push({name:'integration',status:'FAIL',error:String(error)});process.exitCode=1;}
finally{await controller.stop().catch(()=>{});await writeFile(resolve(process.argv[2]??'/private/tmp/nidus-model-relay.json'),JSON.stringify({scope:'Real development VM; synthetic text Provider adapters and approval fixtures. In-memory fixture Ledger only. Zero paid API calls.',checks},null,2));}
console.log(JSON.stringify(checks,null,2));process.exit(process.exitCode??0);
