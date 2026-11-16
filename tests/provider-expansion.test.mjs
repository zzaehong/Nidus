import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../dist/http.js';
import { CompatibleAdapter, CloudflareAdapter } from '../dist/adapters/index.js';
import { cloudflareCredential, resolveCloudflareCredential } from '../dist/adapters/cloudflare.js';
import { expandedProviders, reviewedFreeModels } from '../dist/providers.js';
const account='a'.repeat(32), key='synthetic-key';
const request=model=>({model,messages:[{role:'user',content:'private prompt'}],system:'system text',maxOutputTokens:32});
const completion={choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,prompt_tokens_details:{cached_tokens:2},completion_tokens_details:{reasoning_tokens:1}}};
function fixture() {
 const calls=[];
 const http=new HttpClient(async(url,init)=>{
   const path=new URL(url).pathname,provider=new URL(url).hostname.split('.')[0];calls.push({provider,path,init});
   const id=reviewedFreeModels[provider][0];
   return Response.json(provider==='cloudflare'?{success:true,result:[{name:id,task:{name:'Text Generation'}}]}:{data:[{id,capabilities:provider==='mistral'?{completion_chat:true}:undefined},{id:'new-unclassified'}]});
 });
 const registry=Object.fromEntries(expandedProviders.map(p=>[p,p==='cloudflare'?new CloudflareAdapter(`https://${p}.invalid`,http):new CompatibleAdapter(p,`https://${p}.invalid`,http)]));
 return {calls,registry};
}
test('Cloudflare paginates and rejects failure envelopes; Mistral text blocks normalize',async()=>{
 let calls=0;const http=new HttpClient(async()=>Response.json({success:true,result:++calls===1?Array.from({length:100},(_,i)=>({name:`model-${i}`,task:{name:'Text Embeddings'}})):[]}));
 const models=await new CloudflareAdapter('https://mock.invalid',http).listModels(cloudflareCredential(key,account));assert.equal(calls,2);assert.equal(models.length,100);assert.ok(models.every(m=>m.capabilities.chat==='unsupported'));
 await assert.rejects(new CloudflareAdapter('https://mock.invalid',new HttpClient(async()=>Response.json({success:false,errors:[{message:'secret'}]}))).listModels(cloudflareCredential(key,account)),e=>e.code==='provider_error'&&!e.message.includes('secret'));
 const adapter=new CompatibleAdapter('mistral','https://mock.invalid',new HttpClient(async()=>Response.json({...completion,choices:[{message:{content:[{type:'text',text:'hello'},{type:'thinking',thinking:'private'}]}}]})));
 assert.equal((await adapter.chat(key,request('mistral-small-2603'))).text,'hello');
});

test('catalog lookup rejects invalid model IDs before any network request', async () => {
 const f=fixture();
 for (const provider of expandedProviders) {
  const credential=provider==='cloudflare'?cloudflareCredential(key,account):key;
  for (const id of ['', ' ', 'a\nb', 'a\0b', 'a'.repeat(513), null]) {
   await assert.rejects(f.registry[provider].getModel(credential,id),e=>e.code==='invalid_request');
  }
  assert.equal(f.calls.length,0);
 }
 for (const provider of expandedProviders) {
  const credential=provider==='cloudflare'?cloudflareCredential(key,account):key;
  const id=reviewedFreeModels[provider][0];
  assert.equal((await f.registry[provider].getModel(credential,id)).id,id);
  await assert.rejects(f.registry[provider].getModel(credential,'missing-model'),e=>e.code==='not_found');
 }
});

test('Cloudflare malformed stored credentials fail safely before network access', async () => {
 const f=fixture();
 for (const credential of ['not-json', 'null', '{}', JSON.stringify({token:key,accountId:'../escape'}), JSON.stringify({token:'secret\nheader',accountId:account})]) {
  await assert.rejects(f.registry.cloudflare.listModels(credential),e=>e.code==='invalid_request'&&!e.message.includes('secret'));
 }
 assert.equal(f.calls.length,0);
 assert.deepEqual(JSON.parse(cloudflareCredential(` ${key} `,account)),{token:key,accountId:account});
});

test('cloudflare: an empty Account ID is looked up with the token; only one account is unambiguous; the token never leaks', async () => {
  const seen = [];
  const answer = { accounts: [{ id: account, name: 'Mine' }] };
  const http = new HttpClient(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    if (answer.status) return new Response(JSON.stringify({ success: false, errors: [{ message: 'secret-echo' }] }), { status: answer.status });
    return Response.json({ success: true, result: answer.accounts });
  });
  const one = await resolveCloudflareCredential(key, '', http, 'https://cf.invalid');
  assert.deepEqual([one.accountId, one.discovered, JSON.parse(one.credential)], [account, true, { token: key, accountId: account }]);
  assert.deepEqual(seen, [{ url: 'https://cf.invalid/accounts?per_page=50', auth: `Bearer ${key}` }]);
  const typed = await resolveCloudflareCredential(key, ` ${account} `, http);
  assert.deepEqual([typed.accountId, typed.discovered, seen.length], [account, false, 1], 'a typed ID is used as is, without asking Cloudflare');
  await assert.rejects(resolveCloudflareCredential(key, 'not-hex', http), { code: 'invalid_request' });
  answer.accounts = [{ id: account, name: 'Mine' }, { id: 'b'.repeat(32), name: 'Work' }];
  const many = await resolveCloudflareCredential(key, undefined, http, 'https://cf.invalid').catch(e => e);
  assert.match(many.message, /계정 2개.*Mine: a{32}.*Work: b{32}/);
  answer.accounts = [];
  await assert.rejects(resolveCloudflareCredential(key, '', http, 'https://cf.invalid'), /계정 목록을 볼 수 없어.*Use REST API/, 'a Workers AI-only token gets an empty list: the user is told where the ID is, not that there is no account');
  answer.status = 403;
  const denied = await resolveCloudflareCredential(key, '', http, 'https://cf.invalid').catch(e => e);
  assert.equal(denied.code, 'permission');
  assert.match(denied.message, /Account ID를 직접/);
  assert.ok(!JSON.stringify(denied).includes('secret-echo') && !JSON.stringify(denied).includes(key));
});
