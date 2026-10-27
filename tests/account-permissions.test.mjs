import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UsageLedger,ConnectivityEngine,NidusError} from '../dist/index.js';
import {dispatch} from '../dist/dashboard.js';
import {main} from '../dist/cli.js';
const digest=k=>createHash('sha256').update(k).digest('hex');
const request=(model='gemini-2.5-flash')=>({model,messages:[{role:'user',content:'private prompt'}],maxOutputTokens:32});
const usage={inputTokens:10,outputTokens:2,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0};
function fixture(ledger=new UsageLedger(':memory:'),fail=()=>{}){
 const keys=new Map(['gemini','nvidia','openai'].map(p=>[p,'synthetic-'+p]));
 const pairs=[['gemini','gemini-2.5-flash'],['gemini','gemini-3.5-flash-lite'],['nvidia','meta/llama-3.1-8b-instruct'],['openai','gpt-4.1-mini'],['openai','text-future']];
 const model=(provider,id)=>({provider,id,name:id,capabilities:{chat:'supported'},limits:{},details:{},capabilitySource:'mock'});
 const snapshots=new Map([...keys.keys()].map(p=>[p,{provider:p,version:1,fetchedAt:'2026-10-26',models:pairs.filter(([q])=>q===p).map(([p,id])=>model(p,id))}]));
 const credentials={get:async p=>keys.get(p)??null,set:async(p,k)=>keys.set(p,k),delete:async p=>keys.delete(p)};
 const store={load:async p=>snapshots.get(p),save:async s=>snapshots.set(s.provider,s),remove:async p=>snapshots.delete(p)};
 const calls=[];const registry=Object.fromEntries([...keys.keys()].map(p=>[p,{listModels:async()=>snapshots.get(p).models,chat:async(k,r)=>{calls.push([p,r.model,k]);await fail(p,r.model);return {provider:p,model:r.model,text:'OK',usage};}}]));
 const engine=new ConnectivityEngine(credentials,store,registry,ledger);
 const set=(p,state,paid=false)=>engine.setAccountPermission(p,state,paid,true,true,'project');
 return {ledger,engine,set,keys,credentials,store,registry,calls};
}
const denied=e=>e.code==='execution_permission';
test('fresh account is Unknown; listing and preview never infer billing or dispatch',async()=>{
 const f=fixture();const s=await f.engine.accountPermission('gemini');assert.equal(s.state,'unknown');assert.equal(s.verification,'unverified');
 await f.engine.models('gemini',true);assert.equal((await f.engine.routePlan(request())).candidates.length,0);assert.equal(f.calls.length,0);
 await assert.rejects(f.engine.chat('gemini',request()),e=>denied(e)&&e.reason==='account_unknown');
 assert.equal((await f.engine.probe('gemini',request().model)).status,'skipped');assert.equal(f.calls.length,0);
 assert.ok(f.ledger.snapshot().requests.every(r=>r.status==='blocked'&&Number(r.reservedUSD)===0));
});
test('connection confirms Free Only for Gemini and NVIDIA without paid budgets',async()=>{
 for(const p of ['gemini','nvidia']){const f=fixture();const model=p==='gemini'?request().model:'meta/llama-3.1-8b-instruct';
 const connected=await f.engine.connect(p,'new-key',true,{},undefined,{state:'free_only',paidAllowed:false,confirmed:true,riskAccepted:true});
 assert.equal(connected.accountPermission.state,'free_only');assert.equal(connected.accountPermission.verification,'user-declared');assert.equal(f.calls.length,0);
 const r=await f.engine.chat(p,request(model));assert.equal(r.billingMode,'free');assert.equal(Number(r.estimatedUSD),0);assert.equal(f.ledger.snapshot().requests[0].inputTokens,10);}
});
test('invalid connection billing input is rejected before credential mutation or API discovery',async()=>{
 const f=fixture();let discovery=0;f.registry.gemini.listModels=async()=>{discovery++;return [];};
 await assert.rejects(f.engine.connect('gemini','replacement',true,{},undefined,{state:'free_only',paidAllowed:true,confirmed:true,riskAccepted:true}));
 assert.equal(f.keys.get('gemini'),'synthetic-gemini');assert.equal(discovery,0);
});
test('Free Only rejects unknown and paid-only models, including a one-shot token',async()=>{
 const f=fixture();const token=await f.engine.issueConsent('gemini','new-unreviewed','chat',true);await f.set('gemini','free_only');
 for(const model of ['new-unreviewed','gemini-4-argon'])await assert.rejects(f.engine.chat('gemini',request(model),{consentToken:token.token}),e=>denied(e)&&e.reason==='free_model_unverified');
 assert.equal(f.calls.length,0);
});
test('Hybrid and Paid Only require Provider approval; no money budget is consulted',async()=>{
 for(const state of ['hybrid','paid_only']){const f=fixture();await f.set('gemini',state);
 await assert.rejects(f.engine.chat('gemini',request()),e=>denied(e)&&e.reason==='provider_paid_not_approved');
 await f.set('gemini',state,true);for(const scope of ['total','request','gemini'])f.ledger.setBudget(scope,'0');
 const r=await f.engine.chat('gemini',request());assert.equal(r.billingMode,'paid');assert.ok(Number(r.estimatedUSD)>0);assert.equal(f.ledger.snapshot().total.reservedUSD,'0.000000000');}
});
test('Provider approval covers new models with unknown prices without granting free costs',async()=>{
 const f=fixture();await f.set('openai','paid_only',true);await f.engine.setModelTier('openai','text-future',2);
 const r=await f.engine.autoChat(request('automatic'));assert.equal(r.model,'text-future');assert.equal(r.estimatedUSD,null);assert.equal(f.ledger.snapshot().requests[0].costStatus,'unknown');
});
test('unapproved paid fallback never dispatches and Free Only never escalates even to approved paid',async()=>{
 for(const approvePaid of [false,true]){const f=fixture(undefined,()=>{throw new NidusError('rate_limit','limited',429);});
 await f.set('gemini','free_only');await f.set('openai','paid_only',approvePaid);
 await assert.rejects(f.engine.autoChat(request()),e=>e.code==='unsupported');assert.equal(f.calls.length,2);assert.ok(f.calls.every(([p])=>p==='gemini'));
 assert.ok(f.ledger.routes().some(e=>e.reason==='rate_limit'));}
});
test('free fallback crosses Provider within configured Tier and honors cooldown',async()=>{
 const f=fixture(undefined,p=>{if(p==='gemini')throw new NidusError('rate_limit','limited',429,'60');});await f.set('gemini','free_only');await f.set('nvidia','free_only');
 await f.engine.setModelTier('nvidia','meta/llama-3.1-8b-instruct',2);
 const r=await f.engine.autoChat(request());assert.equal(r.provider,'nvidia');assert.equal(r.routing.tier,2);assert.equal(r.billingMode,'free');assert.equal(f.calls.length,2);
});
test('Unknown one-shot consent is bound to model, task and credential, expires, and consumes once',async()=>{
 let now=new Date('2026-10-26T00:00:00Z');const f=fixture(new UsageLedger(':memory:',()=>now));
 await assert.rejects(f.engine.issueConsent('gemini',request().model,'chat',false));
 const token=(await f.engine.issueConsent('gemini',request().model,'chat',true)).token;
 await assert.rejects(f.engine.chat('gemini',request('wrong'),{consentToken:token}),denied);
 assert.equal((await f.engine.probe('gemini',request().model,false,token)).status,'skipped');
 assert.equal((await f.engine.chat('gemini',request(),{consentToken:token})).billingMode,'paid');
 await assert.rejects(f.engine.chat('gemini',request(),{consentToken:token}),denied);assert.equal(f.calls.length,1);
 const expiring=(await f.engine.issueConsent('gemini',request().model,'chat',true)).token;now=new Date(now.getTime()+300001);
 await assert.rejects(f.engine.chat('gemini',request(),{consentToken:expiring}),denied);
 const keybound=(await f.engine.issueConsent('gemini',request().model,'chat',true)).token;f.keys.set('gemini','different');
 await assert.rejects(f.engine.chat('gemini',request(),{consentToken:keybound}),denied);
 await assert.rejects(f.engine.autoChat(request(),'normal',{consentToken:token}),e=>e.code==='invalid_request');
});
test('single probe can consume its own consent; batch-like repeated probes cannot reuse it',async()=>{
 const f=fixture();const token=(await f.engine.issueConsent('gemini',request().model,'probe',true)).token;
 assert.equal((await f.engine.probe('gemini',request().model,false,token)).status,'passed');
 assert.equal((await f.engine.probe('gemini',request().model,false,token)).status,'skipped');assert.equal(f.calls.length,1);
});
test('simultaneous requests cannot consume the same one-shot consent twice',async()=>{
 const f=fixture();const token=(await f.engine.issueConsent('gemini',request().model,'chat',true)).token;
 const results=await Promise.allSettled([f.engine.chat('gemini',request(),{consentToken:token}),f.engine.chat('gemini',request(),{consentToken:token})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1);assert.equal(Number(f.ledger.snapshot().total.reservedUSD),0);
});
test('permission revocation from another connection before dispatch wins against pending credentials',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus-permission-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'usage.sqlite');
 const ledger=new UsageLedger(path),other=new UsageLedger(path);t.after(()=>{ledger.close();other.close();});const f=fixture(ledger);await f.set('gemini','hybrid',true);
 let release;const gate=new Promise(r=>release=r);f.credentials.get=async()=>{await gate;return 'synthetic-gemini';};
 const pending=f.engine.chat('gemini',request());other.setAccountPermission('gemini','hybrid',false,true,true,digest('synthetic-gemini'),'project');release();
 await assert.rejects(pending,e=>denied(e)&&e.reason==='provider_paid_not_approved');assert.equal(f.calls.length,0);
});
test('account revision recheck prevents Free Only becoming paid between selection and dispatch',async()=>{
 const f=fixture();await f.set('gemini','free_only');let reads=0;const get=f.credentials.get;
 f.credentials.get=async p=>{if(p==='gemini'&&++reads===3)f.ledger.setAccountPermission('gemini','hybrid',true,true,true,digest('synthetic-gemini'));return get(p);};
 await assert.rejects(f.engine.autoChat(request()),e=>e.code==='unsupported');assert.equal(f.calls.length,0);
});
test('refresh preserves confirmation; credential replacement, account change and disconnect revoke it',async()=>{
 const f=fixture();await f.set('gemini','paid_only',true);await f.engine.models('gemini',true);assert.equal((await f.engine.accountPermission('gemini')).paidAllowed,true);
 await f.engine.connect('gemini','replacement');assert.equal((await f.engine.accountPermission('gemini')).state,'unknown');
 await assert.rejects(f.engine.chat('gemini',request()),denied);
 await f.engine.setAccountPermission('gemini','hybrid',false,true,true,'new-project');assert.equal((await f.engine.accountPermission('gemini')).paidAllowed,false);
 await f.engine.disconnect('gemini');assert.equal((await f.engine.accountPermission('gemini')).state,'unknown');
});
test('schema 6 migration retains history but never inherits legacy free or paid approval; schema 7 persists',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus-permissions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'usage.sqlite');
 let ledger=new UsageLedger(path);const f=fixture(ledger);await f.set('gemini','paid_only',true);await f.engine.chat('gemini',request());const before=ledger.snapshot().requests[0];
 ledger.setAutomaticPaid(true);ledger.setGeminiBilling('free','old',true,true,digest('synthetic-gemini'));ledger.setBudget('total','0');ledger.close();
 const db=new DatabaseSync(path);db.exec('DROP TABLE account_permissions;DROP TABLE execution_consents;DROP TABLE permission_events;PRAGMA user_version=6;');db.close();
 ledger=new UsageLedger(path);let g=fixture(ledger);assert.equal((await g.engine.accountPermission('gemini')).state,'unknown');assert.equal(ledger.snapshot().requests[0].id,before.id);assert.equal(ledger.snapshot().total.budgetUSD,'0.000000000');
 await assert.rejects(g.engine.chat('gemini',request()),denied);await g.set('gemini','free_only');ledger.close();
 ledger=new UsageLedger(path);g=fixture(ledger);assert.equal((await g.engine.accountPermission('gemini')).state,'free_only');assert.equal((await g.engine.chat('gemini',request())).billingMode,'free');
 const json=JSON.stringify(await g.engine.routingSettings());assert.ok(!json.includes(digest('synthetic-gemini')));assert.ok(!json.includes('synthetic-gemini'));ledger.close();assert.ok(!readFileSync(path).includes(Buffer.from('private prompt')));
});
test('CLI and SwiftUI share account setting and request-specific approval policies',async()=>{
 const f=fixture();let output='';const deps={engine:f.engine,write:s=>output=s,readPrompt:async()=> 'hello'};
 await main(['billing-set','gemini','--billing-type','hybrid','--confirm-billing','--accept-charge-risk'],deps);
 await assert.rejects(dispatch({method:'chat',provider:'gemini',request:request()},f.engine),denied);
 await dispatch({method:'account-permission-set',provider:'gemini',state:'hybrid',paidAllowed:true,confirmed:true,riskAccepted:true},f.engine);
 await main(['chat','--provider','gemini','--model',request().model],deps);assert.equal(JSON.parse(output).billingMode,'paid');
 await f.set('gemini','unknown');await assert.rejects(main(['chat','--provider','gemini','--model',request().model],deps),denied);
 await main(['chat','--provider','gemini','--model',request().model,'--approve-once'],deps);assert.equal(f.calls.length,2);
});
test('timeout never retries and missing usage remains unknown with zero reservations',async()=>{
 const f=fixture(undefined,()=>{throw new NidusError('timeout','ambiguous');});await f.set('gemini','free_only');await f.set('nvidia','free_only');await f.engine.setModelTier('nvidia','meta/llama-3.1-8b-instruct',2);
 await assert.rejects(f.engine.autoChat(request()),e=>e.code==='timeout');assert.equal(f.calls.length,1);const row=f.ledger.snapshot().requests[0];assert.equal(row.estimatedUSD,null);assert.equal(row.reservedUSD,'0.000000000');
});
test('observed environment-key change permanently invalidates prior approval even if old key returns',async()=>{
 const f=fixture();await f.set('gemini','hybrid',true);f.keys.set('gemini','other');
 assert.equal((await f.engine.accountPermission('gemini')).state,'unknown');
 f.keys.set('gemini','synthetic-gemini');assert.equal((await f.engine.accountPermission('gemini')).state,'unknown');
 await assert.rejects(f.engine.chat('gemini',request()),denied);assert.equal(f.calls.length,0);
});
test('stale settings cannot approve a replacement credential using an old account revision',async()=>{
 const f=fixture();const opened=await f.engine.accountPermission('gemini');f.keys.set('gemini','replacement');
 await assert.rejects(dispatch({method:'account-permission-set',provider:'gemini',state:'hybrid',paidAllowed:true,confirmed:true,riskAccepted:true,expectedRevision:opened.revision},f.engine),denied);
 assert.equal((await f.engine.accountPermission('gemini')).state,'unknown');assert.equal(f.calls.length,0);
});
test('old key free-unavailable metadata does not apply to a newly confirmed account',async()=>{
 const f=fixture();await f.set('gemini','free_only');await f.engine.setFreeUse('gemini',request().model,'unavailable',false,true,false);
 await assert.rejects(f.engine.chat('gemini',request()),e=>e.reason==='free_unavailable');
 f.keys.set('gemini','new-account-key');await f.set('gemini','free_only');assert.equal((await f.engine.chat('gemini',request())).billingMode,'free');
});
