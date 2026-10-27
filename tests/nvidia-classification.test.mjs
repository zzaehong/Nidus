import {authorize,recordApproved} from './helpers/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from '../dist/classification.js';
import { probeModel } from '../dist/health.js';
import { ConnectivityEngine } from '../dist/engine.js';
import { UsageLedger } from '../dist/ledger.js';
import { priceFor } from '../dist/pricing.js';
const model=(id,details={},chat='unknown')=>({provider:'nvidia',id,name:id,capabilities:{chat,vision:'unknown',tools:'unknown',streaming:'unknown'},details,limits:{}});
test('NVIDIA reviewed exact text models and old families have distinct evidence',()=>{
 for(const id of ['openai/gpt-oss-20b','meta/llama-3.1-70b-instruct','nvidia/nemotron-3-super-120b-a12b','z-ai/glm-5.3']){
  const c=classifyModel(model(id));assert.equal(c.kind,'text');assert.equal(c.confidence,'metadata');assert.equal(c.textProbe,'opt_in');assert.ok(c.source.startsWith('https://docs.api.nvidia.com/'));assert.ok(c.checkedAt);
 }
 for(const id of ['01-ai/yi-large','ibm/granite-3.0-8b-instruct','microsoft/phi-3.5-moe-instruct','writer/palmyra-med-70b','deepseek-ai/deepseek-v4.1-flash','mistralai/codestral-22b-instruct-v0.1']){
  const c=classifyModel(model(id));assert.equal(c.kind,'text');assert.equal(c.confidence,'inferred');assert.equal(c.textProbe,'opt_in');
 }
});
test('specialized purpose precedes LLM backbone, generic media naming and chat flag',async()=>{
 for(const [id,kind] of [
  ['nvidia/llama-3.2-nv-embedqa-1b-v1','embedding'],['nvidia/nvclip','embedding'],['snowflake/arctic-embed-l','embedding'],
  ['nvidia/llama-nemotron-rerank-vl-1b-v2','reranking'],['meta/llama-guard-4-12b','moderation'],
  ['nvidia/nemotron-3.5-content-safety','moderation'],['nvidia/nemotron-4-340b-reward','reward'],
  ['nvidia/ai-synthetic-video-detector','detection'],['nvidia/nemotron-parse-2.0','document'],['google/deplot','document']]) {
   const m=model(id,{},'supported'),c=classifyModel(m);assert.equal(c.kind,kind,id);assert.equal(c.textProbe,'unsupported');
   assert.equal((await probeModel(m,true,async()=>assert.fail('must not infer'))).status,'skipped');
 }
});
test('vision input is not image generation and unknown specialized models remain unknown',()=>{
 for(const id of ['meta/llama-3.2-90b-vision-instruct','microsoft/phi-3-vision-128k-instruct','adept/fuyu-8b','nvidia/vila'])assert.equal(classifyModel(model(id)).kind,'text');
 for(const id of ['other-company/llama-3.1-instruct','nvidia/ising-calibration-1.5-31b','nvidia/nemotron-3-nano-omni-30b-a3b-reasoning','google/diffusiongemma-26b-a4b-it','nvidia/new-unknown'])assert.equal(classifyModel(model(id)).kind,'unknown',id);
 assert.equal(classifyModel(model('meta/llama-3.1-8b-instruct',{outputModalities:['image']})).kind,'image');
 assert.equal(classifyModel(model('meta/llama-3.1-8b-instruct',{},'unsupported')).textProbe,'unsupported');
 assert.equal(classifyModel(model('meta/llama-3.1-8b-instruct',{},'supported')).textProbe,'supported');
});
test('cached NVIDIA models reclassify offline while Tier and free metadata stay intact without budget gates',async()=>{
 const ledger=new UsageLedger(':memory:');let keys=0,calls=0;const id='openai/gpt-oss-20b';
 authorize(ledger,'mock');
 const engine=new ConnectivityEngine({get:async()=>{keys++;return 'mock';}}, {load:async p=>p==='nvidia'?{provider:p,version:1,fetchedAt:'2026-10-25',models:[model(id)]}:null}, {nvidia:{chat:async()=>{calls++;return {text:'ok',usage:{inputTokens:1,outputTokens:1}};}}},ledger);
 const cached=await engine.cachedModels('nvidia');assert.equal(cached.models[0].classification.kind,'text');assert.equal(keys,0);assert.equal(cached.models[0].tierAssignment.tier,0);
 assert.equal(priceFor('nvidia',id).freeTier,'unknown');assert.equal(ledger.freeUse('nvidia',id).approved,false);
 await engine.setModelTier('nvidia',id,2);assert.equal((await engine.routePlan({model:id,messages:[{role:'user',content:'test'}]})).candidates.length,1);
 await engine.chat('nvidia',{model:id,messages:[{role:'user',content:'test'}]});assert.equal(calls,1);ledger.close();
});
