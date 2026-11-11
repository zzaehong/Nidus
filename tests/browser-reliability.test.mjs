import test from 'node:test';import assert from 'node:assert/strict';
import {pageState,webFailureMessage} from '../dist/vault/page-state.js';
import {browserRequest,browserPage,checkSearchRelevance} from '../dist/vault/browser.js';
import {SingleAgentRuntime} from '../dist/agent/runtime.js';import {MockAgentModel} from '../dist/agent/model.js';
import {interactiveBrowserTools,ToolRegistry} from '../dist/tools/registry.js';
import {LiveBrowser} from '../dist/vault/live-browser.js';import {VMToolGateway} from '../dist/tools/vm.js';
const page=(text='',extra={})=>({url:'https://www.google.com/search?q=test',title:'Search',text,...extra});
test('CAPTCHA signals across languages stop; documentation about CAPTCHA does not',()=>{
 for(const text of ['Our systems have detected unusual traffic from your computer network','로봇이 아닙니다','私はロボットではありません','我不是机器人'])assert.equal(pageState(page(text)),'captcha_required');
 assert.equal(pageState(page('',{url:'https://www.google.com/sorry/index'})),'captcha_required');assert.equal(pageState(page('',{challengeVisible:true})),'captcha_required');
 assert.equal(pageState(page('How to implement CAPTCHA and reCAPTCHA in your app',{title:'CAPTCHA documentation',url:'https://example.com/docs'})),'page');
 assert.equal(pageState(page('No results found')),'search_no_results');assert.match(webFailureMessage('search_no_results'),/정보 자체가 없다는 뜻은 아닙니다/);
 assert.equal(pageState(page('blocked',{title:'Access Denied'})),'browser_access_blocked');
});
test('CAPTCHA terminates whole agent batch and does not call model again; cleanup runs',async()=>{
 let modelCalls=0,toolCalls=0,closed=false;const model=new MockAgentModel(async()=>{modelCalls++;return {text:'',calls:[{id:'a',name:'browser_start',arguments:{}},{id:'b',name:'browser_click',arguments:{}}],usage:null,continuation:null};});
 const tools={available:()=>interactiveBrowserTools().filter(x=>x.implemented),validateVault:async()=>{},invoke:async()=>{toolCalls++;return {callId:'a',status:'failed',code:'captcha_required',content:{text:''},untrusted:true}},finishExecution:async()=>{closed=true}};
 const task=await new SingleAgentRuntime(model,tools).run({vaultId:'v',model:'m',prompt:'search'});assert.equal(task.code,'captcha_required');assert.equal(task.webStatus,'captcha_required');assert.equal(toolCalls,1);assert.equal(modelCalls,1);assert.equal(closed,true);assert.match(task.text,/수동|직접 확인/);
});
test('live browser latches CAPTCHA and rejects next action without dispatch',async()=>{
 let listener,sends=0;const b={beginLive:async(id,l)=>listener=l,sendLive:async m=>{sends++;listener({event:'result',id:m.id,value:{...page('我不是机器人'),sandboxVerified:true,elements:[],snapshotId:'s'}})},endLive:async()=>{}};
 const live=new LiveBrowser('v','t',b);await live.start();await assert.rejects(live.action({op:'observe'},async()=>true),/captcha_required/);await assert.rejects(live.action({op:'navigate',url:'https://example.com/'},async()=>true),/captcha_required/);assert.equal(sends,1);await live.close();
});
for(const query of ['맥 미니 사양','Mac mini specifications','日本語 仕様','中文 规格'])test('Unicode query/URL/parsing: '+query,()=>{
 const url=browserRequest('browser_search',query+' & + #').url;assert.equal(new URL(url).searchParams.get('q'),query+' & + #');
 const parsed=browserPage(JSON.stringify({title:query,text:query+' 상세 공식 자료',links:[{text:query,url:'https://example.com/文書?q='+encodeURIComponent(query)}],sandboxVerified:true}),'https://www.google.com/search?q='+encodeURIComponent(query));assert.equal(parsed.title,query);checkSearchRelevance(parsed,query);assert.equal(new URL(parsed.links[0].url).searchParams.get('q'),query);
 new ToolRegistry(interactiveBrowserTools()).validate('browser_type',{snapshotId:'s',targetId:'1',text:query});
});
test('direct source tool starts at the exact supplied URL without a Google navigation',async()=>{
 const calls=[],client={request:async(method,args)=>{calls.push({method,args});return {url:args.url,text:'official docs'}}};const gateway=new VMToolGateway(client,{request:async()=>true});
 await gateway.invoke({vaultId:'v',executionId:'t',signal:new AbortController().signal},{id:'call',name:'browser_open',arguments:{url:'https://example.com/公式'}});assert.equal(calls[0].method,'live-open');assert.equal(calls[0].args.url,'https://example.com/公式');await gateway.finishExecution('t');
});
