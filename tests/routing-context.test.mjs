import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import Ajv from 'ajv';
import {UsageLedger,ConnectivityEngine,priceFor,taskContext} from '../dist/index.js';
import {main} from '../dist/cli.js';
import {dispatch} from '../dist/dashboard.js';
const task={type:'chat',difficulty:'normal',requiredCapabilities:['text'],inputCharacters:null,estimatedInputTokens:null};
const schema=JSON.parse(readFileSync(new URL('../schemas/routing-decision-context.schema.json',import.meta.url),'utf8'));
const validate=new Ajv({strict:true}).compile(schema);
const model=(provider,id)=>({provider,id,name:id,capabilities:{chat:'supported',vision:'unknown',tools:'unknown',streaming:'supported'},capabilitySource:'mock',limits:{inputTokens:1000,outputTokens:100,contextTokens:1100},details:{apiKey:'MUST_NOT_EXPORT',prompt:'PROMPT_MUST_NOT_EXPORT'}});
const tokens={inputTokens:100,outputTokens:20,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0};
function fixture(ledger=new UsageLedger(':memory:',()=>new Date('2026-10-27T00:00:00Z'))){
 const keys=new Map([['gemini','PRIVATE_API_KEY'],['openai','SECOND_PRIVATE_KEY']]);
 const snapshots=new Map(['gemini','openai'].map(provider=>[provider,{provider,version:1,fetchedAt:'2026-10-20T00:00:00Z',models:[model(provider,provider==='gemini'?'gemini-2.5-flash':'gpt-4.1-mini')]}]));
 let calls=0;
 const credentials={get:async p=>keys.get(p)??null,set:async(p,k)=>keys.set(p,k),delete:async p=>keys.delete(p)};
 const store={load:async p=>snapshots.get(p)??null,save:async s=>snapshots.set(s.provider,s),remove:async p=>snapshots.delete(p)};
 const registry=Object.fromEntries(['gemini','openai'].map(p=>[p,{chat:async(_,r)=>{calls++;return {provider:p,model:r.model,text:'RESPONSE_MUST_NOT_EXPORT',usage:tokens};},listModels:async()=>{throw Error('network must not run');}}]));
 const engine=new ConnectivityEngine(credentials,store,registry,ledger);
 const permit=async p=>engine.setAccountPermission(p,'paid_only',true,true,true);
 const chat=async(p='gemini',id=snapshots.get(p).models[0].id)=>engine.chat(p,{model:id,messages:[{role:'user',content:'PROMPT_MUST_NOT_EXPORT'}],maxOutputTokens:32});
 return {engine,ledger,keys,snapshots,permit,chat,get calls(){return calls;}};
}
const check=c=>assert.ok(validate(c),JSON.stringify(validate.errors));
test('context includes unknown permission and pricing without API calls or sensitive details; schema is strict',async()=>{
 const f=fixture();f.snapshots.get('gemini').models.push(model('gemini','text-unknown'));
 const c=await f.engine.buildRoutingDecisionContext(task);check(c);
 assert.equal(f.calls,0);assert.equal(c.models.length,3);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').usage.estimatedUSD,null);
 assert.equal(c.models.find(m=>m.provider==='openai').tier,1);assert.equal(c.routingPolicy.executableCandidates.length,0);
 assert.equal(c.providers[2].targetUSD,null);assert.equal(c.providers[2].utilizationPercent,null);
 const json=JSON.stringify(c);for(const secret of ['PRIVATE_API_KEY','SECOND_PRIVATE_KEY','PROMPT_MUST_NOT_EXPORT','MUST_NOT_EXPORT','fingerprint','accountId','RESPONSE_MUST_NOT_EXPORT'])assert.ok(!json.includes(secret),secret);
 assert.equal(validate({...c,prompt:'secret'}),false);
 assert.throws(()=>taskContext({...task,prompt:'secret'}));
 assert.throws(()=>taskContext({...task,estimatedInputTokens:-1}));
});
test('monthly per-model/provider aggregation includes all rows, preserves price snapshots and avoids confirmed double counting',async()=>{
 const f=fixture();await f.permit('gemini');await f.permit('openai');
 for(let i=0;i<205;i++)await f.chat();await f.chat('openai');
 let c=await f.engine.buildRoutingDecisionContext(task), g=c.models.find(m=>m.provider==='gemini');
 assert.equal(g.usage.requests,205);assert.equal(g.usage.inputTokens,20500);assert.equal(g.usage.outputTokens,4100);assert.equal(g.recent.successRate,1);
 const original=g.usage.estimatedUSD;
 f.ledger.reconcile(f.ledger.snapshot().requests.find(r=>r.provider==='gemini').id,'0.01',{provider:'gemini',reference:'bill/one'});
 c=await f.engine.buildRoutingDecisionContext(task);g=c.models.find(m=>m.provider==='gemini');check(c);
 assert.equal(g.usage.confirmedUSD,'0.010000000');assert.equal(g.usage.estimatedUSD,original);
 assert.notEqual(Number(g.usage.knownSpendUSD),Number(original)+0.01);
 assert.equal(c.providers.find(p=>p.provider==='gemini').usage.requests,205);
 assert.equal(c.providers.find(p=>p.provider==='openai').usage.requests,1);
 assert.deepEqual(g.cost.officialPrice,priceFor('gemini',g.model));
 assert.ok(g.usage.priceVersions.length>0);
});
test('soft budgets never alter routing or calls, including zero and exceeded targets; unknown costs keep utilization null',async()=>{
 const f=fixture();await f.permit('gemini');await f.engine.setModelTier('gemini','gemini-2.5-flash',2);
 const request={model:'automatic',messages:[{role:'user',content:'hello'}],maxOutputTokens:32};
 const before=(await f.engine.routePlan(request)).candidates.map(c=>c.model.id);
 f.engine.setSoftBudget('gemini','0');await f.chat();
 const after=(await f.engine.routePlan(request)).candidates.map(c=>c.model.id);assert.deepEqual(after,before);
 let c=await f.engine.buildRoutingDecisionContext(task), b=c.providers.find(p=>p.provider==='gemini');
 assert.equal(b.state,'exceeded');assert.equal(b.enforcement,'none');assert.equal(b.utilizationPercent,null);
 f.engine.setSoftBudget('gemini','0.000001');c=await f.engine.buildRoutingDecisionContext(task);b=c.providers.find(p=>p.provider==='gemini');assert.ok(b.utilizationPercent>100);
 f.snapshots.get('gemini').models.push(model('gemini','text-future'));await f.chat('gemini','text-future');
 c=await f.engine.buildRoutingDecisionContext(task);b=c.providers.find(p=>p.provider==='gemini');assert.equal(b.usage.unknownCostRequests,1);assert.equal(b.utilizationPercent,null);assert.ok(b.knownUtilizationPercent>100);
 assert.equal(c.models.find(m=>m.model==='text-future').usage.estimatedUSD,null);check(c);
 f.engine.setSoftBudget('gemini',null);assert.equal((await f.engine.buildRoutingDecisionContext(task)).providers.find(p=>p.provider==='gemini').state,'unset');
 assert.throws(()=>f.engine.setSoftBudget('gemini','-1'));
});
test('catalog refresh/deduplication, Tier changes, disconnected credentials and cooldown update the context without policy mutation',async()=>{
 const f=fixture();await f.permit('gemini');let c=await f.engine.buildRoutingDecisionContext(task);
 assert.ok(c.routingPolicy.executableCandidates.includes('gemini:gemini-2.5-flash'));
 const revision=f.ledger.routingSettings().revision;
 f.snapshots.get('gemini').models.push(f.snapshots.get('gemini').models[0]);c=await f.engine.buildRoutingDecisionContext(task);assert.equal(c.models.filter(m=>m.provider==='gemini').length,1);
 assert.equal(f.ledger.routingSettings().revision,revision);
 f.ledger.recordHealth('gemini','gemini-2.5-flash','rate_limit',120);
 c=await f.engine.buildRoutingDecisionContext(task);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').health.available,false);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').recent.lastError,'rate_limit');assert.equal(c.routingPolicy.executableCandidates.length,0);
 f.ledger.recordHealth('gemini','gemini-2.5-flash','passed');f.ledger.recordHealth('gemini','*','authentication',300);
 assert.equal((await f.engine.buildRoutingDecisionContext(task)).models.find(m=>m.model==='gemini-2.5-flash').health.available,false);
 await f.engine.setModelTier('gemini','gemini-2.5-flash',3);c=await f.engine.buildRoutingDecisionContext(task);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').tier,3);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').userModified,true);assert.ok(!c.routingPolicy.allowedModels.includes('gemini:gemini-2.5-flash'));
 f.keys.delete('gemini');c=await f.engine.buildRoutingDecisionContext(task);assert.equal(c.models.find(m=>m.model==='gemini-2.5-flash').connection,'disconnected');
 f.snapshots.get('gemini').models=[];c=await f.engine.buildRoutingDecisionContext(task);assert.equal(c.models.filter(m=>m.provider==='gemini').length,0);
});
test('migration from schema 7 preserves requests/legacy budgets; soft targets survive restart without inheriting hard budgets',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
 let ledger=new UsageLedger(path);let f=fixture(ledger);await f.permit('gemini');await f.chat();ledger.setBudget('gemini','10');const id=ledger.snapshot().requests[0].id;ledger.close();
 let db=new DatabaseSync(path);db.exec('DROP TABLE soft_budgets;PRAGMA user_version=7;');db.close();
 ledger=new UsageLedger(path);f=fixture(ledger);assert.equal(f.engine.usage().softBudgets.find(b=>b.provider==='gemini').targetUSD,null);
 f.engine.setSoftBudget('gemini','1.123456789');ledger.close();ledger=new UsageLedger(path);f=fixture(ledger);
 assert.equal(f.engine.usage().softBudgets.find(b=>b.provider==='gemini').targetUSD,'1.123456789');assert.equal(ledger.snapshot().requests[0].id,id);assert.equal(ledger.snapshot().providers.find(p=>p.scope==='gemini').budgetUSD,'10.000000000');ledger.close();
 db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);db.close();
});
test('CLI and dashboard return the same context and soft budget API without AI calls',async()=>{
 const f=fixture();let output='';const dependencies={engine:f.engine,write:s=>output=s};
 await main(['routing-context','--difficulty','normal'],dependencies);assert.deepEqual(JSON.parse(output),await dispatch({method:'routing-context',task},f.engine));
 await main(['soft-budget','gemini','--usd','5'],dependencies);assert.equal(JSON.parse(output).softBudgets.find(b=>b.provider==='gemini').targetUSD,'5.000000000');
 await dispatch({method:'soft-budget-set',provider:'gemini',usd:null},f.engine);assert.equal(f.engine.usage().softBudgets.find(b=>b.provider==='gemini').targetUSD,null);
 await assert.rejects(main(['soft-budget','gemini','--usd','1','--delete'],dependencies));assert.equal(f.calls,0);
});
test('failed usage and pending requests stay unknown and success rates exclude pending/blocked',async()=>{
 const f=fixture();await f.permit('gemini');
 const req={model:'gemini-2.5-flash',messages:[{role:'user',content:'secret'}],maxOutputTokens:32};
 const hash=createHash('sha256').update('PRIVATE_API_KEY').digest('hex');
 const failed=f.ledger.recordRequest('gemini',req,'chat',undefined,hash);f.ledger.settle(failed,'failed',null);
 f.ledger.recordRequest('gemini',req,'chat',undefined,hash);await f.chat();
 const c=await f.engine.buildRoutingDecisionContext(task),m=c.models.find(m=>m.model==='gemini-2.5-flash');check(c);assert.equal(m.usage.requests,3);assert.equal(m.usage.unknownCostRequests,2);assert.equal(m.usage.unknownTokenRequests,2);assert.equal(m.recent.successRate,0.5);assert.equal(m.recent.completedRequests,2);
});
test('stored historical prices are not recalculated from current official prices, and context reading does not write settings',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus-context-price-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
 const ledger=new UsageLedger(path,()=>new Date('2026-10-27T00:00:00Z')),f=fixture(ledger);await f.permit('gemini');await f.chat();
 const db=new DatabaseSync(path),before=ledger.snapshot().requests[0];
 const oldPrice={...before.pricing,rates:[{tier:'historical',input:99,output:99,cachedInput:null,conditions:'historical'}]};
 db.prepare('UPDATE requests SET price_version=?,price_json=? WHERE id=?').run('historic-version',JSON.stringify(oldPrice),before.id);
 const state=()=>({tiers:db.prepare('SELECT * FROM model_tiers').all(),settings:db.prepare('SELECT * FROM routing_settings').all(),permissions:db.prepare('SELECT * FROM permission_events').all()});
 const saved=state();const c=await f.engine.buildRoutingDecisionContext(task),g=c.models.find(m=>m.provider==='gemini');
 assert.equal(g.usage.estimatedUSD,before.estimatedUSD);assert.deepEqual(g.usage.priceVersions,['historic-version']);assert.notEqual(g.cost.officialPrice.rates[0].input,99);assert.deepEqual(state(),saved);check(c);
 db.close();ledger.close();
});
test('recent route error observations have explicit scope and include rate-limit events after recovery',async()=>{
 const f=fixture();f.ledger.recordRoute('r',{provider:'gemini',model:'gemini-2.5-flash',reason:'rate_limit',status:'failed',budget:'disabled',boundUSD:null});
 f.ledger.recordHealth('gemini','gemini-2.5-flash','passed');
 const c=await f.engine.buildRoutingDecisionContext(task),r=c.models.find(m=>m.provider==='gemini').recent;
 assert.equal(r.observedRateLimitEvents,1);assert.equal(r.observedRoutingFailures,1);assert.equal(r.errorHistoryScope,'automatic-route-events-only');assert.equal(r.successRate,null);check(c);
});
test('credential access failure and unknown capabilities still produce context, never a guessed free model',async()=>{
 const f=fixture();f.engine=new ConnectivityEngine({get:async()=>{throw Error('locked credential store');}}, {load:async p=>f.snapshots.get(p)??null}, {}, f.ledger);
 const c=await f.engine.buildRoutingDecisionContext({...task,requiredCapabilities:['vision']});check(c);
 assert.ok(c.models.every(m=>m.connection==='unknown'&&m.permission.allowed===null));assert.equal(c.routingPolicy.executableCandidates.length,0);
 assert.ok(c.models.every(m=>m.usage.estimatedUSD===null));
});
test('UTC monthly scope differs from recent rolling window and per-provider totals remain independent',async()=>{
 let now=new Date('2026-09-30T23:59:59Z');const f=fixture(new UsageLedger(':memory:',()=>now));await f.permit('gemini');await f.chat();
 now=new Date('2026-10-01T00:00:01Z');await f.chat();
 const c=await f.engine.buildRoutingDecisionContext(task),m=c.models.find(m=>m.provider==='gemini');
 assert.equal(c.month,'2026-10');assert.equal(m.usage.requests,1);assert.equal(m.recent.completedRequests,2);assert.equal(m.recent.lastCallAt,now.toISOString());
 assert.equal(c.providers.find(p=>p.provider==='openai').usage.requests,0);check(c);
});
