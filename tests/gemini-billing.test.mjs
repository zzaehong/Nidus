import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedger } from '../dist/ledger.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { NidusError } from '../dist/errors.js';
import { dispatch } from '../dist/dashboard.js';
const request={model:'gemini-2.5-flash',messages:[{role:'user',content:'private'}],maxOutputTokens:32};
const usage={inputTokens:12,outputTokens:3,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0};
function fixture(ledger=new UsageLedger(':memory:'), fail=()=>{}) {
 const calls=[];const credentials={get:async()=> 'mock-key'};
 const models=[['gemini',request.model],['gemini','gemini-3.5-flash-lite'],['openai','gpt-4.1-mini']].map(([provider,id])=>({provider,id,name:id,capabilities:{chat:'supported'},details:{},limits:{},capabilitySource:'mock'}));
 const store={load:async p=>({provider:p,models:models.filter(m=>m.provider===p),version:1,fetchedAt:'2026-10-25'})};
 const registry=Object.fromEntries(['gemini','openai'].map(provider=>[provider,{chat:async(k,r)=>{calls.push([provider,r.model]);await fail(provider,r.model);return {provider,model:r.model,text:'ok',usage};}}]));
 return {ledger,calls,credentials,engine:new ConnectivityEngine(credentials,store,registry,ledger)};
}
const free=f=>f.engine.setGeminiBilling('free','project-test',true,true);
test('free project supports manual, probe common execution and automatic calls without paid budgets',async()=>{
 const f=fixture();await free(f);f.ledger.setBudget('gemini','0');
 const r=await f.engine.chat('gemini',request);assert.equal(r.billingMode,'free');assert.equal(Number(r.estimatedUSD),0);
 await f.engine.autoChat(request);const rows=f.ledger.snapshot().requests;assert.equal(rows.length,2);
 assert.ok(rows.every(r=>r.billingMode==='free'&&r.inputTokens===12&&Number(r.reservedUSD)===0));
 assert.equal(f.ledger.geminiBilling().remainingFreeQuota,null);
});
test('unknown and paid retain existing policy and detailed rejection reasons',async()=>{
 for(const state of ['unknown','paid']) { const f=fixture();await f.engine.setGeminiBilling(state,'project-test',false,false);
 await assert.rejects(f.engine.chat('gemini',request),e=>e.reason==='budget_not_configured'&&e.toJSON().reason===e.reason);
 f.ledger.setBudget('total','10');f.ledger.setBudget('request','2');
 const r=await f.engine.chat('gemini',request);assert.equal(r.billingMode,'paid');assert.ok(Number(r.estimatedUSD)>0);
 await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget'); }
});
test('free project rejects unsupported and unreviewed models even with budget exception',async()=>{
 const f=fixture();await free(f);
 for(const model of ['gemini-4-argon','new-model']) await assert.rejects(f.engine.chat('gemini',{...request,model},{budgetException:true}),e=>e.reason==='gemini_free_model_unverified');
 assert.equal(f.calls.length,0);
});
test('free 429 falls back to free candidate and never escalates to paid even with global permission',async()=>{
 const f=fixture(undefined,(provider)=>{if(provider==='gemini')throw new NidusError('rate_limit','RESOURCE_EXHAUSTED',429);});
 await free(f);f.ledger.setAutomaticPaid(true);f.ledger.setBudget('total','10');f.ledger.setBudget('request','2');
 await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(([p])=>p==='gemini'));
 assert.ok(f.ledger.routes().filter(e=>e.status==='failed').every(e=>e.reason==='rate_limit'));
 assert.ok(f.ledger.snapshot().requests.every(r=>r.estimatedUSD===null&&r.costStatus==='unknown'&&Number(r.reservedUSD)===0));
});
test('credential changes, missing consent and known exhausted model block free execution',async()=>{
 const f=fixture();await assert.rejects(f.engine.setGeminiBilling('free','project-test',true,false));await free(f);
 f.credentials.get=async()=> 'other-key';await assert.rejects(f.engine.chat('gemini',request),e=>e.reason==='gemini_project_credential_changed');assert.equal(f.calls.length,0);
});
test('schema4 migration preserves liabilities and project setting survives restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus-gemini-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
 let ledger=new UsageLedger(path);ledger.setBudget('total','10');ledger.setBudget('request','2');const old=ledger.reserve('gemini',request,'chat');ledger.close();
 const db=new DatabaseSync(path);db.exec('DROP TABLE gemini_project; DROP TABLE request_billing; PRAGMA user_version=4;');db.close();
 ledger=new UsageLedger(path);const f=fixture(ledger);await free(f);ledger.close();ledger=new UsageLedger(path);t.after(()=>ledger.close());
 assert.equal(ledger.geminiBilling().state,'free');assert.ok(Number(ledger.snapshot().total.reservedUSD)>0);assert.equal(ledger.snapshot().requests[0].billingMode,'paid');
 ledger.settle(old,'succeeded',usage);assert.ok(Number(ledger.snapshot().requests[0].estimatedUSD)>0);
 const result=await fixture(ledger).engine.chat('gemini',request);assert.equal(result.billingMode,'free');
});
test('dashboard project setting and execution-time policy changes use same guard',async()=>{
 const f=fixture();await dispatch({method:'gemini-billing-set',state:'free',project:'project-test',confirmed:true,riskAccepted:true},f.engine);
 f.credentials.get=async()=>{f.ledger.setGeminiBilling('paid','project-test',false,false,'');return 'mock-key';};
 await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,0);
});
test('free model reported unavailable is excluded while another free model succeeds',async()=>{
 const f=fixture();await free(f);await f.engine.setFreeUse('gemini',request.model,'unavailable',false,true,false);
 const r=await f.engine.autoChat(request);assert.equal(r.model,'gemini-3.5-flash-lite');assert.equal(r.billingMode,'free');
});
test('successful free reservation keeps its original billing basis after settings change',async()=>{
 const f=fixture(undefined,()=>f.ledger.setGeminiBilling('paid','project-test',false,false,''));await free(f);
 const r=await f.engine.chat('gemini',request);assert.equal(Number(r.estimatedUSD),0);assert.equal(f.ledger.snapshot().requests[0].billingMode,'free');
});
