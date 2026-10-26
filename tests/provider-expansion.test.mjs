import {authorize,recordApproved} from './helpers/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../dist/http.js';
import { CompatibleAdapter, CloudflareAdapter } from '../dist/adapters/index.js';
import { cloudflareCredential } from '../dist/adapters/cloudflare.js';
import { expandedProviders, reviewedFreeModels } from '../dist/providers.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { UsageLedger } from '../dist/ledger.js';
import { EnvironmentCredentials } from '../dist/credentials.js';
import { dispatch } from '../dist/dashboard.js';
import { main } from '../dist/cli.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
const account='a'.repeat(32), key='synthetic-key';
const request=model=>({model,messages:[{role:'user',content:'private prompt'}],system:'system text',maxOutputTokens:32});
const completion={choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,prompt_tokens_details:{cached_tokens:2},completion_tokens_details:{reasoning_tokens:1}}};
function fixture(ledger=new UsageLedger(':memory:')) {
 const calls=[],keys=new Map(),snapshots=new Map();let failure=null;
 const http=new HttpClient(async(url,init)=>{
   const path=new URL(url).pathname,provider=new URL(url).hostname.split('.')[0];calls.push({provider,path,init});
   if(failure&&path.endsWith('/chat/completions')) return new Response(JSON.stringify({error:{message:'secret'}}),{status:failure,headers:{'retry-after':'7'}});
   if(path.endsWith('/chat/completions'))return Response.json(completion);
   const id=reviewedFreeModels[provider][0];
   return Response.json(provider==='cloudflare'?{success:true,result:[{name:id,task:{name:'Text Generation'}}]}:{data:[{id,capabilities:provider==='mistral'?{completion_chat:true}:undefined},{id:'new-unclassified'}]});
 });
 const registry=Object.fromEntries(expandedProviders.map(p=>[p,p==='cloudflare'?new CloudflareAdapter(`https://${p}.invalid`,http):new CompatibleAdapter(p,`https://${p}.invalid`,http)]));
 const credentials={get:async p=>keys.get(p)??null,set:async(p,k)=>keys.set(p,k),delete:async p=>keys.delete(p)};
 const store={load:async p=>snapshots.get(p)??null,save:async s=>snapshots.set(s.provider,s),remove:async p=>snapshots.delete(p)};
 return {ledger,calls,keys,snapshots,credentials,store,registry,setFailure:s=>failure=s,engine:new ConnectivityEngine(credentials,store,registry,ledger)};
}
async function connect(f,p) { return f.engine.connect(p,key,true,{},p==='cloudflare'?account:undefined); }
async function approve(f,p) {
 const id=reviewedFreeModels[p][0];await f.engine.setProviderPlan(p,'free',true,true);
 await f.engine.setFreeUse(p,id,'verified',true,true,true);await f.engine.setModelTier(p,id,2);return id;
}
for(const p of expandedProviders) {
 test(`${p}: discover, credential store, manual tier survives refresh, free chat and disconnect`,async()=>{
  const f=fixture();const result=await connect(f,p);const id=reviewedFreeModels[p][0];
  assert.equal(result.authentication,p==='nvidia'?'catalog-access-only':'models-api-verified');assert.ok(result.models.some(m=>m.id===id));assert.equal(result.models[0].tierAssignment.tier,0);
  assert.equal(f.calls.length,1);assert.ok(f.keys.has(p));assert.ok(!JSON.stringify(result).includes(key));
  const registered=await approve(f,p);await f.engine.models(p,true);assert.equal((await f.engine.cachedModels(p)).models[0].tierAssignment.tier,2);
  const response=await f.engine.chat(p,request(registered));assert.equal(response.billingMode,'free');assert.equal(response.usage.inputTokens,10);assert.equal(response.usage.reasoningTokens,1);
  const sent=f.calls.at(-1);assert.equal(sent.init.headers.authorization,`Bearer ${key}`);const body=JSON.parse(sent.init.body);assert.equal(body.model,id);assert.equal(p==='groq'?body.max_completion_tokens:body.max_tokens,32);assert.equal(body.messages[0].role,'system');
  assert.equal(f.ledger.snapshot().requests[0].billingMode,'free');assert.equal(f.ledger.snapshot().requests[0].inputTokens,10);
  await f.engine.disconnect(p);assert.equal(f.keys.has(p),false);assert.equal(f.snapshots.has(p),false);assert.equal(f.ledger.providerPlan(p).state,'unknown');
 });
 test(`${p}: unknown/paid and unapproved free do not silently become zero; errors remain safe`,async()=>{
  const f=fixture();await connect(f,p);const id=reviewedFreeModels[p][0];
  for(const state of ['unknown','paid','free']) {
   await f.engine.setProviderPlan(p,state,true,true);
   if(state==='free')assert.equal((await f.engine.chat(p,request(id))).billingMode,'free');else await assert.rejects(f.engine.chat(p,request(id)),e=>e.reason==='account_unknown');
  }
  assert.equal(f.calls.length,2);await approve(f,p);
  for(const [status,code] of [[401,'authentication'],[403,'permission'],[429,'rate_limit']]) {
   f.setFailure(status);await assert.rejects(f.engine.chat(p,request(id)),e=>e.code===code&&!e.message.includes('secret'));
  }
  assert.equal(f.ledger.snapshot().requests[0].headers['retry-after'],'7');
 });
}
test('Cloudflare account is validated, credential-bound and isolated from discovery cache',async()=>{
 const f=fixture();await assert.rejects(f.engine.connect('cloudflare',key,true,{},'../bad'),e=>e.code==='invalid_request');assert.equal(f.calls.length,0);
 await connect(f,'cloudflare');assert.equal(f.calls[0].path,`/accounts/${account}/ai/models/search`);
 assert.equal(JSON.parse(f.keys.get('cloudflare')).accountId,account);assert.ok(!JSON.stringify([...f.snapshots.values()]).includes(account));
 await approve(f,'cloudflare');f.keys.set('cloudflare',cloudflareCredential(key,'b'.repeat(32)));
 await assert.rejects(f.engine.chat('cloudflare',request(reviewedFreeModels.cloudflare[0])),e=>e.reason==='account_unknown');
 const env=new EnvironmentCredentials(f.credentials,{NIDUS_CLOUDFLARE_API_KEY:key,NIDUS_CLOUDFLARE_ACCOUNT_ID:account});assert.equal(JSON.parse(await env.get('cloudflare')).accountId,account);
});
test('free fallback crosses new providers in allowed Tier and never pays',async()=>{
 const f=fixture();for(const p of ['groq','nvidia']){await connect(f,p);await approve(f,p);}
 f.registry.groq.chat=async()=>{const {NidusError}=await import('../dist/errors.js');throw new NidusError('rate_limit','limited',429,'3');};
 const result=await f.engine.autoChat(request('automatic'));assert.equal(result.provider,'nvidia');assert.equal(result.routing.tier,2);
 assert.ok(result.routing.transitions.some(t=>t.provider==='groq'&&t.reason==='rate_limit'));
 assert.equal(f.ledger.routingSettings().allowPaid,false);
});
test('schema5 upgrade preserves paid liabilities and free plans survive reopen',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nidus42-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'ledger.sqlite');
 let ledger=new UsageLedger(path);ledger.setBudget('total','10');ledger.setBudget('request','2');recordApproved(ledger,'gemini',request('gemini-2.5-flash'),'chat');ledger.close();
 const old=new DatabaseSync(path);old.exec("UPDATE requests SET reserved=1000000,bound=1000000,settlement='reserved'");old.exec('DROP TABLE provider_plans; PRAGMA user_version=5;');old.close();ledger=new UsageLedger(path);
 const f=fixture(ledger);await connect(f,'groq');await approve(f,'groq');ledger.close();ledger=new UsageLedger(path);t.after(()=>ledger.close());
 assert.equal(ledger.providerPlan('groq').state,'free');assert.ok(Number(ledger.snapshot().total.reservedUSD)>0);assert.equal(ledger.modelTier('groq',reviewedFreeModels.groq[0]).tier,2);
});
test('CLI account-id and SwiftUI connection use common engine without inference',async()=>{
 const f=fixture();await main(['connect','cloudflare','--account-id',account],{engine:f.engine,readSecret:async()=>key,write:()=>{}});
 await dispatch({method:'connect',provider:'groq',key},f.engine);assert.equal(f.calls.length,2);
 await dispatch({method:'provider-plan-set',provider:'groq',state:'free',confirmed:true,riskAccepted:true},f.engine);
 assert.equal(f.ledger.providerPlan('groq').state,'free');assert.equal(f.calls.length,2);
});
test('Cloudflare paginates and rejects failure envelopes; Mistral text blocks normalize',async()=>{
 let calls=0;const http=new HttpClient(async()=>Response.json({success:true,result:++calls===1?Array.from({length:100},(_,i)=>({name:`model-${i}`,task:{name:'Text Embeddings'}})):[]}));
 const models=await new CloudflareAdapter('https://mock.invalid',http).listModels(cloudflareCredential(key,account));assert.equal(calls,2);assert.equal(models.length,100);assert.ok(models.every(m=>m.capabilities.chat==='unsupported'));
 await assert.rejects(new CloudflareAdapter('https://mock.invalid',new HttpClient(async()=>Response.json({success:false,errors:[{message:'secret'}]}))).listModels(cloudflareCredential(key,account)),e=>e.code==='provider_error'&&!e.message.includes('secret'));
 const adapter=new CompatibleAdapter('mistral','https://mock.invalid',new HttpClient(async()=>Response.json({...completion,choices:[{message:{content:[{type:'text',text:'hello'},{type:'thinking',thinking:'private'}]}}]})));
 assert.equal((await adapter.chat(key,request('mistral-small-2603'))).text,'hello');
});
test('paid Groq calls ignore old zero limits and disabled automatic paid permission while recording costs',async()=>{
 const f=fixture();await connect(f,'groq');const id=reviewedFreeModels.groq[0];await f.engine.setModelTier('groq',id,2);await f.engine.setAccountPermission('groq','paid_only',true,true,true);
 for(const scope of ['total','request','groq'])f.ledger.setBudget(scope,'0');
 for(const r of [await f.engine.chat('groq',request(id)),await f.engine.autoChat(request(id))]){assert.equal(r.billingMode,'paid');assert.ok(Number(r.estimatedUSD)>0);}
 assert.equal(f.ledger.snapshot().requests.length,2);assert.equal(Number(f.ledger.snapshot().total.reservedUSD),0);
});

test('connection failure preserves previous key/cache; reconnect clears free consent',async()=>{
 const f=fixture();await connect(f,'groq');await approve(f,'groq');
 const original=f.registry.groq.listModels;f.registry.groq.listModels=async()=>{throw Error('mock');};
 await assert.rejects(f.engine.connect('groq','new-key'));assert.equal(f.keys.get('groq'),key);assert.ok(f.snapshots.has('groq'));
 f.registry.groq.listModels=original;f.store.save=async()=>{throw Error('mock disk');};
 await assert.rejects(f.engine.connect('groq','new-key'));assert.equal(f.keys.get('groq'),key);
 f.store.save=async s=>f.snapshots.set(s.provider,s);await f.engine.connect('groq','new-key');assert.equal(f.ledger.providerPlan('groq').state,'unknown');assert.equal(f.ledger.freeUse('groq',reviewedFreeModels.groq[0]).approved,false);
});
test('legacy free Gemini falls back to approved new provider; timeout never duplicates',async()=>{
 const f=fixture();await connect(f,'groq');await approve(f,'groq');
 const {NidusError}=await import('../dist/errors.js');
 f.keys.set('gemini','gemini-key');const model={provider:'gemini',id:'gemini-2.5-flash',name:'Gemini',capabilities:{chat:'supported',tools:'unknown',vision:'unknown',streaming:'unknown'},details:{},limits:{}};
 f.snapshots.set('gemini',{version:1,provider:'gemini',fetchedAt:new Date().toISOString(),models:[model]});
 f.registry.gemini={chat:async()=>{throw new NidusError('rate_limit','limited',429);}};await f.engine.setGeminiBilling('free','project-test',true,true);
 const r=await f.engine.autoChat(request('automatic'));assert.equal(r.provider,'groq');assert.equal(r.routing.transitions[0].provider,'gemini');
 f.ledger.recordHealth('gemini',model.id,'ready');f.registry.gemini.chat=async()=>{throw new NidusError('timeout','ambiguous');};const n=f.calls.length;
 await assert.rejects(f.engine.autoChat(request('automatic')),e=>e.code==='timeout');assert.equal(f.calls.length,n);
});
test('plan revocation at credential boundary blocks execution; concurrent free tokens remain separate',async()=>{
 const f=fixture();await connect(f,'groq');const id=await approve(f,'groq');const results=await Promise.all([f.engine.chat('groq',request(id)),f.engine.chat('groq',request(id))]);assert.notEqual(results[0].requestId,results[1].requestId);
 assert.equal(f.ledger.snapshot().requests.length,2);assert.ok(f.ledger.snapshot().requests.every(r=>r.inputTokens===10));
 f.credentials.get=async p=>{f.ledger.setProviderPlan('groq','unknown',false,false,'');return f.keys.get(p);};const count=f.calls.length;
 await assert.rejects(f.engine.autoChat(request(id)),e=>e.code==='invalid_request');assert.equal(f.calls.length,count);
});
