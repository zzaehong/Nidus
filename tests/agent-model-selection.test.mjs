import test from 'node:test';import assert from 'node:assert/strict';
import {ConnectivityEngine} from '../dist/engine.js';import {UsageLedger} from '../dist/ledger.js';import {providerIds} from '../dist/types.js';import {authorize} from './helpers/permissions.mjs';import {parseTextTools,textToolRequest} from '../dist/agent/text-tools.js';import {ToolRegistry,offlineShellTools} from '../dist/tools/registry.js';
const request=()=>({model:'fixture-text',prompt:'run approved test',history:[],tools:new ToolRegistry(offlineShellTools()).available(false,true)});
const usage={inputTokens:11,outputTokens:5,totalTokens:16,providerUsage:{},cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null};
const response=text=>({provider:'groq',model:'fixture-text',text,finishReason:'stop',usage});
const model=p=>({provider:p,id:'fixture-text',name:'Fixture',capabilities:{chat:'supported',tools:'unsupported'},details:{},limits:{}});
test('connected catalog excludes disconnected providers and nontext execution',async()=>{
 const ledger=authorize(new UsageLedger(':memory:'),'fixture');try{
 const engine=new ConnectivityEngine({get:async p=>p==='groq'?'fixture':null},{load:async p=>({models:[model(p),{...model(p),id:'text-embedding-3-small',capabilities:{chat:'unsupported',tools:'unsupported'}}]})},{groq:{}},ledger);
 const rows=await engine.agentModels();assert.equal(rows.length,2);assert(rows.every(r=>r.provider==='groq'));assert.equal(rows[0].available,true);assert.equal(rows[0].mode,'nidus-text');assert.equal(rows[1].available,false);
 }finally{ledger.close();}
});
for(const provider of providerIds)test(`text tool relay routes ${provider} through existing chat and Ledger`,async()=>{
 const ledger=authorize(new UsageLedger(':memory:'),'fixture');try{
 let sent;
 const engine=new ConnectivityEngine({get:async p=>p===provider?'fixture':null},{load:async p=>({models:[model(p)]})},{[provider]:{chat:async(key,r)=>{sent=r;return response(JSON.stringify({text:'',calls:[{name:'run_shell',arguments:{command:'echo fixture'}}]}));}}},ledger);
 const turn=await engine.agentChat(provider,request());assert.equal(turn.calls[0].name,'run_shell');assert.match(sent.system,/cannot grant permissions/);assert.equal(ledger.snapshot().requests.filter(r=>r.status==='succeeded').length,1);
 const next=textToolRequest({...request(),history:[{turn,results:[{callId:turn.calls[0].id,status:'denied',code:'permission_denied',content:{text:''},untrusted:true}]}]});assert.match(next.messages[0].content,/permission_denied/);
 }finally{ledger.close();}
});
test('text relay rejects fabricated permissions/targets, malformed JSON, unavailable tools and truncation',()=>{
 for(const text of ['echo command','```json\n{}\n```',JSON.stringify({text:'',calls:[{name:'run_shell',arguments:{command:'echo x',approved:true}}]}),JSON.stringify({text:'',calls:[{name:'run_shell',target:'host',arguments:{command:'x'}}]}),JSON.stringify({text:'',calls:[{name:'browser_search',arguments:{query:'x'}}]})])assert.throws(()=>parseTextTools(response(text),request()),/valid Nidus tool request/);
 assert.throws(()=>parseTextTools({...response('{"text":"ok","calls":[]}'),finishReason:'length'},request()));
});
test('VM status UI projection is bounded and preserves owner/session, without mutating audit',async()=>{
 const {initialVMStatus,summarizeVMStatus}=await import('../dist/vault/vm-protocol.js');
 const state=initialVMStatus();state.vaultId='owner';state.activeSession='active';state.sessions=Array.from({length:10000},(_,i)=>({id:String(i)}));
 const summary=summarizeVMStatus(state);assert.equal(summary.sessions.length,5);assert.equal(summary.sessionCount,10000);assert.equal(summary.vaultId,'owner');assert.equal(summary.activeSession,'active');summary.sessions[0].id='changed';assert.equal(state.sessions[9995].id,'9995');assert(JSON.stringify(summary).length<2000);
});
test('malformed text tool response keeps successful API usage and never retries',async()=>{
 const ledger=authorize(new UsageLedger(':memory:'),'fixture');try{
 let count=0;const engine=new ConnectivityEngine({get:async()=> 'fixture'},{load:async p=>({models:[model(p)]})},{groq:{chat:async()=>{count++;return response('not JSON');}}},ledger);
 await assert.rejects(engine.agentChat('groq',request()),e=>e.code==='invalid_response');assert.equal(count,1);assert.equal(ledger.snapshot().requests.filter(r=>r.status==='succeeded').length,1);
 }finally{ledger.close();}
});
test('VM summary supports existing daemon protocol without changing live state to unconfirmed',async()=>{
 const {VMClient}=await import('../dist/vault/vm-client.js');const {VaultError}=await import('../dist/vault/types.js');const {initialVMStatus}=await import('../dist/vault/vm-protocol.js');
 const client=new VMClient({directory:'/unused-fixture'});const methods=[];const state=initialVMStatus();state.state='RUNNING';state.vaultId='fixture';
 client.request=async method=>{methods.push(method);if(method==='summary')throw new VaultError('vm_unknown_method');return state;};
 const result=await client.status(true);assert.deepEqual(methods,['summary','status']);assert.equal(result.state,'RUNNING');assert.equal(result.statusSource,'live-service');assert.equal(result.sessionCount,0);
});
