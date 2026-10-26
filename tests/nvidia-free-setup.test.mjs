import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UsageLedger} from '../dist/ledger.js';
import {ConnectivityEngine} from '../dist/engine.js';
import {dispatch} from '../dist/dashboard.js';
import {priceFor} from '../dist/pricing.js';
import {NidusError} from '../dist/errors.js';
const ids=['nvidia/nemotron-3.5-super-vl-120b-a12b','nvidia/nemotron-3.5-lightning-30b-a3b','nvidia/nemotron-3-ultra-550b-a55b','deepseek-ai/deepseek-v4.1-flash'];
const request=model=>({model,messages:[{role:'user',content:'test'}],maxOutputTokens:64});
function fixture(){
 const ledger=new UsageLedger(':memory:');let calls=0;let fail=false;
 const models=[...ids,'writer/palmyra-med-70b'].map(id=>({provider:'nvidia',id,name:id,capabilities:{chat:'unknown',tools:'unknown',vision:'unknown',streaming:'unknown'},details:{},limits:{}}));
 const credentials={get:async()=> 'mock-key'};
 const engine=new ConnectivityEngine(credentials,{load:async p=>p==='nvidia'?{version:1,provider:p,models,fetchedAt:'2026-10-25'}:null}, {nvidia:{chat:async(k,r)=>{calls++;if(fail)throw new NidusError('rate_limit','limited',429);return {provider:'nvidia',model:r.model,text:'ok',usage:{inputTokens:5,outputTokens:2}};}}},ledger);
 return {engine,ledger,credentials,calls:()=>calls,setFailure:()=>fail=true};
}
test('NVIDIA Unknown is blocked until Free Only confirmation, without requiring a money budget',async()=>{
 const f=fixture();for(const id of ids)await assert.rejects(f.engine.chat('nvidia',request(id)),e=>e.reason==='account_unknown');
 assert.equal(f.calls(),0);await f.engine.setAccountPermission('nvidia','free_only',false,true,true);
 for(const id of ids){const r=await f.engine.chat('nvidia',request(id));assert.equal(r.billingMode,'free');assert.equal(Number(r.estimatedUSD),0);await f.engine.setModelTier('nvidia',id,2);}
 assert.equal((await f.engine.autoChat(request('automatic'))).provider,'nvidia');
});

test('explicit one-step setup enables four discovered official free endpoints without paid budgets',async()=>{
 const f=fixture();await dispatch({method:'nvidia-free-setup',models:ids,confirmed:true,riskAccepted:true},f.engine);assert.equal(f.calls(),0);
 for(const id of ids){const r=await f.engine.chat('nvidia',request(id));assert.equal(r.billingMode,'free');assert.equal(Number(r.estimatedUSD),0);assert.equal(priceFor('nvidia',id).rates.length,0);assert.equal(f.ledger.modelTier('nvidia',id).tier,0);}
 assert.equal(f.ledger.snapshot().requests.length,4);assert.equal(f.ledger.routingSettings().allowPaid,false);
 assert.ok(f.ledger.snapshot().requests.every(r=>r.inputTokens===5&&Number(r.reservedUSD)===0));
});
test('unconfirmed, undiscovered, unreviewed and duplicate selections cannot change any approvals',async()=>{
 const f=fixture();for(const [models,confirmed,risk] of [[ids,false,true],[ids,true,false],[['unknown'],true,true],[['writer/palmyra-med-70b'],true,true],[[ids[0],ids[0]],true,true],[[],true,true]])await assert.rejects(f.engine.approveNvidiaFreeModels(models,confirmed,risk),e=>e.code==='invalid_request');
 assert.equal(f.ledger.providerPlan('nvidia').state,'unknown');assert.equal(f.ledger.freeUse('nvidia',ids[0]).approved,false);assert.equal(f.calls(),0);
});
test('NVIDIA Free Only permits reviewed free models, blocks unknown models and changed keys',async()=>{
 const f=fixture();await f.engine.approveNvidiaFreeModels([ids[0]],true,true);
 assert.equal((await f.engine.chat('nvidia',request(ids[1]))).billingMode,'free');
 await assert.rejects(f.engine.chat('nvidia',request('writer/palmyra-med-70b')),e=>e.reason==='free_model_unverified');
 f.credentials.get=async()=> 'changed-key';await assert.rejects(f.engine.chat('nvidia',request(ids[0])),e=>e.reason==='account_unknown');
 f.credentials.get=async()=> 'mock-key';await f.engine.approveNvidiaFreeModels(ids,true,true);for(const id of ids)await f.engine.setModelTier('nvidia',id,2);
 f.setFailure();await assert.rejects(f.engine.autoChat(request('automatic')),e=>e.code==='unsupported');assert.equal(f.calls(),5);assert.ok(f.ledger.routes().filter(r=>r.status==='failed').every(r=>r.reason==='rate_limit'));
});
