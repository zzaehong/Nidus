import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { UsageLedger, money, dollars, calculatedCost, priceFor, upperCost, ConnectivityEngine, NidusError, OpenAIAdapter, HttpClient, deepseekBalance, rateLimitHeaders } from '../dist/index.js';
import { fundedLedger } from './helpers/ledger.mjs';
import { dispatch } from '../dist/dashboard.js';
import { main } from '../dist/cli.js';
const request = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'private-prompt-never-store' }], maxOutputTokens: 100 };
const tokens = (inputTokens = 100, outputTokens = 10, cachedInputTokens = 20) => ({ inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: null, reasoningTokens: 5, totalTokens: inputTokens + outputTokens, providerUsage: { secret: 'do-not-save' } });
const reserve = l => l.recordRequest('openai', request, 'chat');
function engine(ledger, action) {
  const model = { id: request.model, provider: 'openai', capabilities: { chat: 'supported' }, limits: {}, details: {}, name: 'Mini' };
  return new ConnectivityEngine({ get: async () => 'private-key-never-store' }, { load: async () => ({ models: [model] }) }, { openai: { chat: action } }, ledger);
}
test('integer decimal cost, cache pricing, reasoning not counted twice, and unknown writes', () => {
  assert.equal(dollars(money('0.1') + money('0.2')), '0.300000000');
  assert.equal(dollars(calculatedCost(priceFor('openai', request.model), tokens())), '0.000050000');
  assert.equal(calculatedCost(priceFor('openai', 'unknown'), tokens()), null);
  assert.equal(calculatedCost(priceFor('openai', request.model), { ...tokens(), inputTokens: null }), null);
  assert.equal(calculatedCost(priceFor('openai', request.model), { ...tokens(), cachedInputTokens: 101 }), null);
  assert.equal(calculatedCost(priceFor('anthropic', 'claude-sonnet-4-6'), { ...tokens(), cacheWriteTokens: 1 }), null);
  for (const invalid of ['NaN', '-1', '1e2', '0.0000000001', 2, '1000001']) assert.throws(() => money(invalid));
  assert.equal(upperCost('openai', { ...request, maxOutputTokens: Infinity }), null);
  assert.equal(upperCost('openai', request, { ...priceFor('openai', request.model), checkedAt: '2020-01-01' }), null);
});
test('unconfigured, zero budgets and unknown pricing never block or reserve; unknown is not zero', () => {
 const l=new UsageLedger(':memory:');
 for(const scope of ['total','request','openai']) l.setBudget(scope,'0');
 for(const model of [request.model,'unknown']) {
   const r=l.recordRequest('openai',{...request,model},'chat');assert.equal(r.bound,null);
   l.settle(r,'succeeded',tokens());
   const row=l.snapshot().requests.find(x=>x.id===r.id);
   assert.equal(row.reservedUSD,'0.000000000');assert.equal(row.status,'succeeded');
   if(model==='unknown'){assert.equal(row.estimatedUSD,null);assert.equal(row.costStatus,'unknown');}
   else assert.ok(Number(row.estimatedUSD)>0);
 }
 assert.equal(l.snapshot().budgetGuardEnabled,false);l.close();
});

test('legacy limits remain stored but quote is advisory at every previous threshold', () => {
 const l=new UsageLedger(':memory:');l.setBudget('total','10');l.setBudget('request','0');l.setBudget('openai','0');
 for(const used of ['8','9','10','11']) {
   const r=reserve(l);l.settle(r,'failed');l.reconcile(r.id,used,{provider:'openai',reference:'mock:'+used});
   assert.equal(l.quote('openai',request).allowed,true);
 }
 assert.equal(l.snapshot().requestBudgetUSD,'0.000000000');assert.equal(l.snapshot().total.reservedUSD,'0.000000000');l.close();
});

test('removed budget mutation transports report unsupported and CLI rejects obsolete flags', async () => {
 const l=new UsageLedger(':memory:');const e=engine(l,async()=>({text:'OK',usage:tokens()}));
 await assert.rejects(dispatch({method:'budget-set',scope:'total',usd:'10'},e),x=>x.code==='unsupported');
 await assert.rejects(e.setAutomaticPaid(true),x=>x.code==='unsupported');
 await assert.rejects(main(['budget','total','--usd','10'],{engine:e,write:()=>{}}));
 await assert.rejects(main(['chat','--provider','openai','--model',request.model,'--approve-budget-exception'],{engine:e,readPrompt:async()=>'',write:()=>{}}));
 l.close();
});

test('missing usage, cancellation and failure remain unknown without new reservations; real usage after failure is charged', async () => {
  for (const code of ['timeout', 'network', 'cancelled', 'invalid_response']) {
    const l = fundedLedger(); const e = engine(l, async () => { throw new NidusError(code, 'safe'); });
    await assert.rejects(e.chat('openai', request));
    const r = l.snapshot().requests[0];
    assert.equal(r.status, code === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(r.estimatedUSD, null); assert.equal(r.costStatus, 'unknown'); assert.equal(r.reservedUSD, '0.000000000'); l.close();
  }
  const l = fundedLedger(); const e = engine(l, async () => ({ text: 'answer' }));
  await e.chat('openai', request); assert.equal(l.snapshot().requests[0].settlement, 'unresolved'); l.close();
  const ledger = fundedLedger();
  const adapter = new OpenAIAdapter('https://example.invalid', new HttpClient(async () => Response.json({ output: [], usage: { input_tokens: 10, output_tokens: 5 } })));
  const e2 = engine(ledger, (...args) => adapter.chat(...args));
  await assert.rejects(e2.chat('openai', request));
  assert.equal(ledger.snapshot().requests[0].estimatedUSD, '0.000012000');
  assert.equal(ledger.snapshot().requests[0].status, 'failed'); ledger.close();
});
test('CLI, dashboard chat, single and batch probes execute without budget setup and all record usage', async () => {
 const l=new UsageLedger(':memory:');let calls=0;const e=engine(l,async()=>{calls++;return {text:'OK',usage:tokens()};});
 await dispatch({method:'chat',provider:'openai',request},e);
 await main(['chat','--provider','openai','--model',request.model],{engine:e,readPrompt:async()=> 'hello',write:()=>{}});
 assert.equal((await e.probe('openai',request.model)).status,'passed');
 for(let i=0;i<3;i++)assert.equal((await dispatch({method:'probe',provider:'openai',model:request.model,confirmed:true},e)).status,'passed');
 assert.equal(calls,6);assert.equal(l.snapshot().requests.length,6);assert.ok(l.snapshot().requests.every(r=>Number(r.reservedUSD)===0));l.close();
});

test('restart restores incomplete requests and excludes all private content from SQLite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'usage.sqlite'); let l = new UsageLedger(path);
  l.setBudget('total', '10'); l.setBudget('request', '2');
  const e = engine(l, async () => ({ text: 'private-response-never-store', usage: tokens() }));
  await e.chat('openai', request); reserve(l); l.close();
  l = new UsageLedger(path); assert.equal(l.snapshot().requests.length, 2); assert.equal(l.snapshot().total.unknownCount, 1);
  assert.equal(l.snapshot().requestBudgetUSD, '2.000000000'); l.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path);
  for (const secret of ['private-prompt-never-store', 'private-key-never-store', 'private-response-never-store', 'do-not-save']) assert.ok(!bytes.includes(Buffer.from(secret)));
});
test('unknown costs survive UTC month boundary; reconciliation is idempotent and not double counted', () => {
  let date = new Date('2026-10-31T23:59:00Z'); const l = new UsageLedger(':memory:', () => date);
  l.setBudget('total', '10'); l.setBudget('request', '2'); const r = reserve(l); l.settle(r, 'failed');
  date = new Date('2026-11-01T00:01:00Z'); assert.equal(l.snapshot().total.reservedUSD, '0.000000000');
  l.reconcile(r.id, '0.01', { provider: 'openai', reference: 'invoice:123' });
  l.reconcile(r.id, '0.01', { provider: 'openai', reference: 'invoice:123' });
  assert.equal(l.snapshot().total.reservedUSD, '0.000000000');
  assert.throws(() => l.reconcile(r.id, '0.02', { provider: 'openai', reference: 'invoice:123' }));
  const current = reserve(l); l.settle(current, 'succeeded', tokens());
  l.reconcile(current.id, '0.02', { provider: 'openai', reference: 'invoice:124' });
  assert.equal(l.snapshot().total.exposureUSD, '0.020000000');
  assert.equal(l.snapshot().total.estimatedUSD, '0.000000000'); l.close();
});
test('concurrent processes record distinct pending requests without reservations or budget conflicts', async t => {
 const dir=await mkdtemp(join(tmpdir(),'nidus-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'usage.sqlite');const l=new UsageLedger(path);
 l.setBudget('total','0');l.setBudget('request','0');
 const moduleURL=new URL('../dist/ledger.js',import.meta.url).href;
 const script=`import {UsageLedger} from ${JSON.stringify(moduleURL)};const l=new UsageLedger(process.argv[1]);console.log(l.recordRequest('openai',${JSON.stringify(request)},'chat').id);l.close();`;
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script,path]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));});
 const ids=await Promise.all(Array.from({length:8},run));assert.equal(new Set(ids).size,8);assert.equal(l.snapshot().requests.length,8);assert.equal(l.snapshot().total.reservedUSD,'0.000000000');l.close();
});

test('rate limit header whitelist and balance use only reported USD, never infer other currencies', async () => {
  assert.deepEqual(rateLimitHeaders(new Headers({ 'x-ratelimit-remaining-tokens': '42', 'x-secret': 'do-not-store', 'retry-after': 'secret' })), { 'x-ratelimit-remaining-tokens': '42' });
  const http = new HttpClient(async (url, options) => {
    assert.equal(String(url), 'https://api.deepseek.com/user/balance'); assert.equal(options.method, 'GET');
    return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '100' }] });
  });
  assert.equal((await deepseekBalance('synthetic', http)).usd, null);
});
test('provider remaining capacity respects the global ceiling even without a provider-specific budget', () => {
  const l = fundedLedger(); l.setBudget('total', '1');
  assert.equal(l.snapshot().providers[0].level, 'inherited');
  assert.equal(l.snapshot().providers[0].remainingUSD, '1.000000000');
  l.setBudget('openai', '10'); reserve(l);
  assert.equal(l.snapshot().providers[0].remainingUSD, l.snapshot().total.remainingUSD); l.close();
});
