import {authorize,recordApproved} from './helpers/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectivityEngine } from '../dist/engine.js';
import { UsageLedger } from '../dist/ledger.js';
import { rankCandidates } from '../dist/router.js';
import { NidusError } from '../dist/errors.js';
import { main } from '../dist/cli.js';
import { dispatch } from '../dist/dashboard.js';
const pairs = [['openai','gpt-4.1-mini'],['gemini','gemini-2.5-flash'],['deepseek','deepseek-flash'],['anthropic','claude-opus-4-6'],['openai','new-model']];
const req = { model: 'automatic', messages: [{ role:'user', content:'secret-prompt' }], maxOutputTokens:128 };
function fixture(ledger = new UsageLedger(':memory:'), fail = async () => {}) {
  authorize(ledger,'fake-key');
  const models = new Map(), calls = [];
  for (const [provider,id] of pairs) {
    const list = models.get(provider) ?? [];
    list.push({provider,id,name:id,capabilities:{chat:'supported',vision:'unknown',tools:'unknown',streaming:'unknown'},limits:{inputTokens:null,outputTokens:null,contextTokens:null},details:{},capabilitySource:'mock'});
    models.set(provider,list);
  }
  const store = { load:async p => ({provider:p,version:1,fetchedAt:'2026-10-25',models:models.get(p)??[]}),save:async s=>models.set(s.provider,s.models) };
  const credentials = {get:async()=> 'fake-key'};
  const adapters=Object.fromEntries([...models.keys()].map(p=>[p,{listModels:async()=>models.get(p),chat:async (key,r)=>{
    calls.push([p,r.model]); await fail(p,r.model);
    return {provider:p,model:r.model,text:'OK',usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0,totalTokens:12,providerUsage:{}}};
  }}]));
  const engine = new ConnectivityEngine(credentials,store,adapters,ledger);
  return {engine,ledger,calls,credentials,models};
}
function allow(f) { f.ledger.setBudget('total','100'); f.ledger.setBudget('request','10'); f.ledger.setAutomaticPaid(true); }
test('fresh defaults preserve Tier eligibility while manual and automatic calls need no budget setup',async()=>{
 const f=fixture(),s=await f.engine.routingSettings();assert.deepEqual(s.policies,{simple:[1,2],normal:[2,1],complex:[3,2]});assert.equal(s.allowPaid,false);
 assert.equal(s.models.find(m=>m.id==='new-model').tierAssignment.tier,0);assert.equal(s.models.find(m=>m.id==='gpt-4.1-mini').tierAssignment.tier,1);
 await f.engine.autoChat(req);await f.engine.chat('openai',{...req,model:'gpt-4.1-mini'});assert.equal(f.calls.length,2);
});

test('user overrides and policies survive refresh, restart and reset to reviewed default',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'nidus-tier-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
  const f=fixture(new UsageLedger(path));allow(f);
  await f.engine.setModelTier('openai','gpt-4.1-mini',3);await f.engine.setRoutingPolicy('simple',[3]);
  await f.engine.models('openai',true);
  let s=await f.engine.routingSettings();assert.equal(s.models.find(m=>m.id==='gpt-4.1-mini').tierAssignment.userModified,true);
  f.ledger.close();const again=fixture(new UsageLedger(path));t.after(()=>again.ledger.close());
  s=await again.engine.routingSettings();assert.deepEqual(s.policies.simple,[3]);assert.equal(s.allowPaid,true);
  assert.equal((await again.engine.autoChat(req,'simple')).routing.tier,3);
  await again.engine.setModelTier('openai','gpt-4.1-mini',null);
  s=await again.engine.routingSettings();const assignment=s.models.find(m=>m.id==='gpt-4.1-mini').tierAssignment;
  assert.equal(assignment.tier,1);assert.equal(assignment.userModified,false);assert.match(assignment.source,/openai.com/);
});
test('tier order beats cheaper or free lower tier even at budget pressure; same tier sorts by cost',async()=>{
  const f=fixture();allow(f);const plan=await f.engine.routePlan(req,'normal');
  assert.equal(plan.candidates[0].tier,2);
  const general=plan.candidates.find(c=>c.tier===2), light=plan.candidates.find(c=>c.tier===1);
  const free={...light,quote:{allowed:true,reason:null,boundUSD:'0.000000000'},pressure:true};
  assert.equal(rankCandidates([free,{...general,pressure:true}],'normal',[2,1])[0].tier,2);
  assert.equal(rankCandidates([general,free],'normal',[1,2])[0].tier,1);
  assert.equal(rankCandidates([{...free,tier:2},general],'normal',[2])[0].quote.boundUSD,'0.000000000');
  await f.engine.setRoutingPolicy('complex',[1]);assert.equal((await f.engine.autoChat(req,'complex')).routing.tier,1);
});
test('exhausts current tier across providers before next tier; persisted logs include tier',async()=>{
  const f=fixture(undefined,async p=>{if(p==='gemini')throw new NidusError('rate_limit','mock',429,'10');});allow(f);
  const result=await f.engine.autoChat(req,'normal');
  assert.deepEqual(f.calls.map(c=>c[0]),['gemini','deepseek']);assert.equal(result.routing.tier,2);
  assert.ok(f.ledger.routes().filter(e=>e.status!=='excluded').every(e=>e.tier===2));assert.ok(!JSON.stringify(f.ledger.routes()).includes('secret-prompt'));
});
test('zero provider and global budgets do not skip the preferred Tier or provider',async()=>{
 const f=fixture();for(const scope of ['gemini','total','request'])f.ledger.setBudget(scope,'0');
 const r=await f.engine.autoChat(req);assert.equal(r.provider,'gemini');assert.equal(r.routing.tier,2);assert.equal(f.calls.length,1);
});

test('empty policy disables difficulty; unknown price is eligible but assignment never overrides text incompatibility',async()=>{
  const f=fixture();allow(f);await f.engine.setRoutingPolicy('simple',[]);
  await assert.rejects(f.engine.autoChat(req,'simple'),e=>e.code==='unsupported');
  await f.engine.setModelTier('openai','new-model',3);await f.engine.setRoutingPolicy('complex',[3]);
  const plan=await f.engine.routePlan(req,'complex');assert.ok(plan.candidates.some(c=>c.model.id==='new-model'&&c.quote.boundUSD===null));
  await f.engine.setModelTier('openai','gpt-4.1-mini',3);
  f.models.get('openai')[0].capabilities.chat='unsupported';
  assert.ok(!(await f.engine.routePlan(req,'complex')).candidates.some(c=>c.model.id==='gpt-4.1-mini'));
});
test('Tier policy changes while awaiting credentials reject stale routing',async()=>{
  for(const mutate of [f=>f.ledger.setRoutingPolicy('normal',[3]),f=>f.ledger.setModelTier('gemini','gemini-2.5-flash',0)]){
    const f=fixture();allow(f);let once=false;
    f.credentials.get=async()=>{if(!once){once=true;mutate(f);}return 'fake-key';};
    await assert.rejects(f.engine.autoChat(req),e=>e.code==='invalid_request');assert.equal(f.calls.length,0);
    assert.ok(f.ledger.snapshot().requests.every(r=>r.status==='blocked'));
  }
});
test('timeout and network never fall through to next configured tier',async()=>{
  for(const code of ['timeout','network']){const f=fixture(undefined,async()=>{throw new NidusError(code,'mock');});allow(f);
    await assert.rejects(f.engine.autoChat(req),e=>e.code===code);assert.equal(f.calls.length,1);assert.equal(Number(f.ledger.snapshot().total.reservedUSD),0);
  }
});
test('schema 1 and 2 migrate without deleting usage, pending reservations or transition logs',async t=>{
  for(const version of [1,2]){
    const dir=mkdtempSync(join(tmpdir(),'nidus-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
    const ledger=new UsageLedger(path);ledger.setBudget('total','100');ledger.setBudget('request','10');
    recordApproved(ledger,'openai',{...req,model:'gpt-4.1-mini'},'chat');ledger.recordRoute('old',{provider:'openai',model:'gpt-4.1-mini',reason:'initial_selection',status:'selected',budget:'allowed',boundUSD:'1'});ledger.close();
    const db=new DatabaseSync(path);db.exec("UPDATE requests SET reserved=1000000,bound=1000000,settlement='reserved'");db.exec(`DROP TABLE model_tiers; DROP TABLE routing_settings; PRAGMA user_version=${version};`);db.close();
    const restored=new UsageLedger(path);t.after(()=>restored.close());assert.equal(restored.snapshot().requests.length,1);assert.equal(restored.routes()[0].routeId,'old');
    assert.ok(Number(restored.snapshot().total.reservedUSD)>0);assert.equal(restored.routingSettings().allowPaid,false);
  }
});
test('CLI and SwiftUI update and consume identical persisted policy; invalid updates do not alter it',async()=>{
  const f=fixture();allow(f);
  await main(['routing-policy','normal','--tiers','1,3'],{engine:f.engine,write:()=>{}});
  const s=await dispatch({method:'routing-settings'},f.engine);assert.deepEqual(s.policies.normal,[1,3]);
  const ui=await dispatch({method:'auto-chat',difficulty:'normal',request:req},f.engine);assert.equal(ui.routing.tier,1);
  await dispatch({method:'routing-policy-set',difficulty:'normal',tiers:[3]},f.engine);
  let output='';await main(['chat','--auto'],{engine:f.engine,readPrompt:async()=> 'hello',write:s=>output+=s});assert.equal(JSON.parse(output).routing.tier,3);
  for(const tiers of [[1,1],[0],[4],'1,2',null])await assert.rejects(f.engine.setRoutingPolicy('normal',tiers),e=>e.code==='invalid_request');
  await assert.rejects(f.engine.setAutomaticPaid('true'),e=>e.code==='unsupported');
  await assert.rejects(f.engine.setModelTier('openai','not-discovered',2),e=>e.code==='invalid_request');
  assert.deepEqual((await f.engine.routingSettings()).policies.normal,[3]);
});
test('policy revocation from a second SQLite connection is observed before dispatch',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'nidus-policy-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
  const first=new UsageLedger(path),second=new UsageLedger(path);t.after(()=>{first.close();second.close();});
  const f=fixture(first);allow(f);
  f.credentials.get=async()=>{second.setRoutingPolicy('normal',[3]);return 'fake-key';};
  await assert.rejects(f.engine.autoChat(req),e=>e.code==='invalid_request');assert.equal(f.calls.length,0);
  assert.ok(first.snapshot().requests.every(r=>r.blockReason==='routing_policy_changed'));
});
