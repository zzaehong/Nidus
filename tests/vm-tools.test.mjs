import {test} from 'node:test';import assert from 'node:assert/strict';
import {VMToolGateway} from '../dist/tools/vm.js';import {ToolRegistry,offlineShellTools} from '../dist/tools/registry.js';
const call={id:'call',name:'run_shell',arguments:{command:'echo safe'}};
const ctx=()=>({vaultId:'vault',executionId:'execution',signal:new AbortController().signal});
function client(){const calls=[];return {calls,async request(method,args){calls.push({method,args});if(method==='propose')return {approvalId:'private-capability',command:'echo safe',expiresAt:Date.now()+500,executionId:'execution'};if(method==='executeApproved')return {cleanupConfirmed:true,reason:'completed',stdout:'safe',exitCode:0};return {};}};}
test('M4 tool exposure requires a VM port; browser and writes remain unavailable',()=>{const tools=new ToolRegistry(offlineShellTools());assert.deepEqual(tools.available().map(t=>t.name),['list_files','read_file','search_files']);assert.deepEqual(tools.available(false,true).map(t=>t.name),['list_files','read_file','search_files','run_shell']);assert.throws(()=>tools.validate('run_shell',{command:'x',approved:true}));});
test('M4 Shell denial and approval-channel error never dispatch',async()=>{for(const answer of [async()=>false,async()=>{throw Error('channel');}]){const c=client(),g=new VMToolGateway(c,{request:answer});const r=await g.invoke(ctx(),call);assert.notEqual(r.status,'succeeded');assert.equal(c.calls.filter(c=>c.method==='executeApproved').length,0);}});
test('M4 Shell trusted approval is one invocation and token never reaches result',async()=>{const c=client(),g=new VMToolGateway(c,{request:async()=>true});const r=await g.invoke(ctx(),call);assert.equal(r.status,'succeeded');assert.doesNotMatch(JSON.stringify(r),/private-capability/);assert.equal(c.calls.filter(x=>x.method==='executeApproved').length,1);});
test('M4 Shell cancellation during approval and unanswered approval do not dispatch',async()=>{const c=client(),a=new AbortController(),g=new VMToolGateway(c,{request:async()=>{a.abort();return new Promise(()=>{});}});assert.equal((await g.invoke({...ctx(),signal:a.signal},call)).status,'cancelled');assert.ok(!c.calls.some(x=>x.method==='executeApproved'));const d=client(),wait=new VMToolGateway(d,{request:()=>new Promise(()=>{})});assert.equal((await wait.invoke(ctx(),call)).status,'denied');assert.ok(!d.calls.some(x=>x.method==='executeApproved'));});
test('M4 Shell result-channel loss is uncertain and never automatically retried',async()=>{const c=client(),original=c.request;c.request=async(...args)=>{if(args[0]==='executeApproved'){c.calls.push({method:args[0]});throw Error('disconnect');}return original(...args);};const r=await new VMToolGateway(c,{request:async()=>true}).invoke(ctx(),call);assert.equal(r.status,'unknown');assert.equal(c.calls.filter(x=>x.method==='executeApproved').length,1);});
test('M4 dispatcher VM deadline cancels the port and preserves unknown outcomes',async()=>{
 const {ToolDispatcher}=await import('../dist/tools/dispatcher.js');
 for(const status of ['cancelled','unknown']){
  const definitions=offlineShellTools().map(d=>d.name==='run_shell'?{...d,timeoutMs:5}:d);
  const gateway={invoke:async(ctx,call)=>new Promise(resolve=>ctx.signal.addEventListener('abort',()=>resolve({callId:call.id,status,code:status==='unknown'?'outcome_unknown':'cancelled',content:{text:''},untrusted:true}),{once:true}))};
  const tools=new ToolDispatcher(new ToolRegistry(definitions),{finishExecution(){}},undefined,{},gateway);
  const r=await tools.invoke(ctx(),call);assert.equal(r.code,status==='unknown'?'outcome_unknown':'tool_timeout');
 }
});
