import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../dist/ledger.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { NidusError } from '../dist/errors.js';
import { dispatch } from '../dist/dashboard.js';
const request={model:'gemini-2.5-flash',messages:[{role:'user',content:'private prompt'}],maxOutputTokens:64};
const hash=createHash('sha256').update('test-key').digest('hex');
function fixture(ledger=new UsageLedger(':memory:'), fail=()=>{}) {
  const calls=[],models=new Map();
  for(const [provider,id] of [['gemini','gemini-2.5-flash'],['gemini','gemini-3.5-flash-lite'],['openai','gpt-4.1-mini']]) {
    const list=models.get(provider)??[];list.push({provider,id,name:id,capabilities:{chat:'supported',tools:'unknown',vision:'unknown',streaming:'unknown'},details:{},limits:{inputTokens:null,outputTokens:null,contextTokens:null},capabilitySource:'mock'});models.set(provider,list);
  }
  const credentials={get:async()=> 'test-key',delete:async()=>{}};
  const store={load:async p=>({provider:p,version:1,models:models.get(p)??[],fetchedAt:'2026-10-25'}),remove:async p=>models.delete(p)};
  const adapters=Object.fromEntries([...models.keys()].map(provider=>[provider,{chat:async(key,r)=>{
    calls.push([provider,r.model]);await fail(provider,r.model);
    return {provider,model:r.model,text:'OK',usage:{inputTokens:10,outputTokens:2,totalTokens:12,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0,providerUsage:{}}};
  }}]));
  const engine=new ConnectivityEngine(credentials,store,adapters,ledger);
  ledger.setBudget('total','10');ledger.setBudget('request','5');
  return {engine,ledger,credentials,calls};
}
const approve=(f,model=request.model,status='unverified')=>f.engine.setFreeUse('gemini',model,status,true,status==='verified',true);
test('same-revision reservation rejects mismatched, missing and cross-provider tier assignments',()=>{
  const f=fixture();f.ledger.setAutomaticPaid(true);
  f.ledger.modelTier('gemini',request.model);
  const revision=f.ledger.routingSettings().revision;
  assert.throws(()=>f.ledger.reserve('gemini',request,'chat',false,{revision,difficulty:'normal',tier:1}),e=>e.code==='budget');
  assert.equal(f.ledger.snapshot().requests[0].blockReason,'model_tier_mismatch');
  assert.throws(()=>f.ledger.reserve('openai',{...request,model:'gpt-4.1-mini'},'chat',false,{revision,difficulty:'normal',tier:1}),e=>e.code==='budget');
  assert.ok(f.ledger.snapshot().requests.every(r=>r.reservedUSD==='0.000000000'));
  const r=f.ledger.reserve('gemini',request,'chat',false,{revision,difficulty:'normal',tier:2});assert.ok(r.bound>0n);
});
test('another connection changing model tier without revision cannot race the atomic model check',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'nidus-tier-check-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
  const ledger=new UsageLedger(path);t.after(()=>ledger.close());const f=fixture(ledger);f.ledger.setAutomaticPaid(true);await f.engine.setRoutingPolicy('normal',[2]);
  const other=new DatabaseSync(path);t.after(()=>other.close());
  f.credentials.get=async()=>{other.prepare("UPDATE model_tiers SET tier=1 WHERE provider='gemini'").run();return 'test-key';};
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,0);
  assert.equal(f.ledger.snapshot().requests[0].blockReason,'model_tier_mismatch');
});
test('free-tier defaults distinguish unsupported from account unverified and never invent remaining quota',()=>{
  const f=fixture();const gemini=f.ledger.freeUse('gemini',request.model),openai=f.ledger.freeUse('openai','gpt-4.1-mini');
  assert.equal(gemini.status,'unverified');assert.equal(gemini.approved,false);assert.equal(gemini.checkedAt,null);
  assert.equal(openai.status,'unsupported');assert.equal(f.ledger.freeUse('anthropic','unknown').status,'unverified');
  assert.equal(gemini.remainingRequests,undefined);
});
test('unverified free model requires scoped charge-risk consent; approval retains positive cost and budgets',async()=>{
  const f=fixture();await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');
  await assert.rejects(f.engine.setFreeUse('gemini',request.model,'unverified',true,false,false),e=>e.code==='invalid_request');
  await approve(f);assert.equal(f.ledger.routingSettings().allowPaid,false);
  const result=await f.engine.autoChat(request);assert.equal(result.provider,'gemini');assert.ok(Number(result.routing.boundUSD)>0);
  assert.ok(Number(result.estimatedUSD)>0);assert.equal(f.ledger.freeUse('gemini',request.model).status,'unverified');
  assert.equal(f.ledger.routes()[0].authorization,'model-scoped-charge-consent');
  f.ledger.setBudget('gemini','0');await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,1);
});
test('verified status requires account attestation and is not itself approval or a zero price',async()=>{
  const f=fixture();await assert.rejects(f.engine.setFreeUse('gemini',request.model,'verified',false,false,false),e=>e.code==='invalid_request');
  await f.engine.setFreeUse('gemini',request.model,'verified',false,true,false);
  const free=f.ledger.freeUse('gemini',request.model);assert.equal(free.verification,'user-account-attestation');assert.ok(free.checkedAt);
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');
  await approve(f,request.model,'verified');const result=await f.engine.autoChat(request);assert.ok(Number(result.estimatedUSD)>0);
});
test('free unavailable skips to another approved model and never an unapproved paid model',async()=>{
  const f=fixture();await approve(f);await approve(f,'gemini-3.5-flash-lite');
  await f.engine.setFreeUse('gemini',request.model,'unavailable',false,true,false);
  const result=await f.engine.autoChat(request);assert.equal(result.model,'gemini-3.5-flash-lite');
  await f.engine.setFreeUse('gemini','gemini-3.5-flash-lite','unavailable',false,true,false);
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.ok(f.calls.every(([p])=>p==='gemini'));
});
test('rate-limit fallback uses only other approved candidates; no inferred free quota depletion',async()=>{
  const f=fixture(undefined,(p,m)=>{if(m===request.model)throw new NidusError('rate_limit','mock',429,'60');});
  await approve(f);await approve(f,'gemini-3.5-flash-lite');
  const result=await f.engine.autoChat(request);assert.equal(result.model,'gemini-3.5-flash-lite');assert.equal(f.calls.length,2);
  assert.equal(f.ledger.freeUse('gemini',request.model).status,'unverified');assert.ok(Number(f.ledger.snapshot().total.reservedUSD)>0);
  const alone=fixture(undefined,()=>{throw new NidusError('rate_limit','mock',429,'60');});await approve(alone);
  await assert.rejects(alone.engine.autoChat(request),e=>e.code==='budget');assert.equal(alone.calls.length,1);
});
test('scoped approval is bound to current credential and revocation during key retrieval is atomic',async()=>{
  const f=fixture();await approve(f);f.credentials.get=async()=> 'different-account-key';
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,0);
  f.credentials.get=async()=>{f.ledger.setFreeUse('gemini',request.model,'unverified',false,false,hash);return 'test-key';};
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,0);
});
test('free approvals survive schema upgrade/restart without exposing key digests and invalidate on disconnect',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'nidus-free-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
  const f=fixture(new UsageLedger(path));const pending=f.ledger.reserve('gemini',request,'chat');
  f.ledger.close();const old=new DatabaseSync(path);old.exec('DROP TABLE model_free_use; PRAGMA user_version=3;');old.close();
  const again=fixture(new UsageLedger(path));await approve(again);assert.equal(again.ledger.snapshot().requests[0].id,pending.id);
  again.ledger.close();const restored=fixture(new UsageLedger(path));t.after(()=>restored.ledger.close());
  assert.equal(restored.ledger.freeUse('gemini',request.model).approved,true);
  const settings=JSON.stringify(await dispatch({method:'routing-settings'},restored.engine));assert.ok(!settings.includes(hash));assert.ok(!settings.includes('test-key'));
  await restored.engine.disconnect('gemini');assert.equal(restored.ledger.freeUse('gemini',request.model).approved,false);
});
test('dashboard scoped consent validates exact discovered free model and existing policy',async()=>{
  const f=fixture();
  await assert.rejects(dispatch({method:'free-use-set',provider:'openai',model:'gpt-4.1-mini',status:'verified',approved:true,accountConfirmed:true,chargeRiskAccepted:true},f.engine),e=>e.code==='invalid_request');
  const s=await dispatch({method:'free-use-set',provider:'gemini',model:request.model,status:'unverified',approved:true,accountConfirmed:false,chargeRiskAccepted:true},f.engine);
  assert.equal(s.allowPaid,false);assert.equal(s.models.find(m=>m.id===request.model).freeUse.approved,true);
  f.ledger.setBudget('request','0');await assert.rejects(f.engine.autoChat(request),e=>e.code==='budget');assert.equal(f.calls.length,0);
});
test('scoped consent never permits automatic budget exceptions or ambiguous-delivery retry',async()=>{
  const f=fixture(undefined,()=>{throw new NidusError('timeout','ambiguous');});await approve(f);await approve(f,'gemini-3.5-flash-lite');
  await assert.rejects(f.engine.autoChat(request),e=>e.code==='timeout');assert.equal(f.calls.length,1);
  const revision=f.ledger.routingSettings().revision;
  assert.throws(()=>f.ledger.reserve('gemini',request,'chat',true,{revision,difficulty:'normal',tier:2,credentialHash:hash}),e=>e.code==='invalid_request');
  assert.ok(Number(f.ledger.snapshot().total.reservedUSD)>0);
});
