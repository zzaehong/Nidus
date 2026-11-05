import {test} from 'node:test';import assert from 'node:assert/strict';
import {LiveBrowser} from '../dist/vault/live-browser.js';
import {validateLiveRequest,needsNetworkApproval} from '../dist/vault/live-network.js';
import {ToolRegistry,interactiveBrowserTools} from '../dist/tools/registry.js';
import {SingleAgentRuntime} from '../dist/agent/runtime.js';import {MockAgentModel} from '../dist/agent/model.js';
const request=(x={})=>({requestId:'request',url:'https://example.com/',method:'GET',headers:{},body:'',resourceType:'Document',...x});
const observation=(x={})=>({snapshotId:'snapshot',url:'https://example.com/',title:'Example',text:'content',elements:[{id:'1',name:'Search',tag:'INPUT'}],sandboxVerified:true,...x});
class Backend {messages=[];async beginLive(id,listener){this.id=id;this.listener=listener;}async sendLive(message){this.messages.push(message);if(message.op!=='response')queueMicrotask(()=>this.listener({event:'result',id:message.id,value:observation()}));}async endLive(){this.ended=true;this.listener({event:'ended'});}cancel(){this.cancelled=true;}}
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,1));};
test('interactive registry: text models get bounded element actions, no arbitrary JS or URL tool',()=>{
 const r=new ToolRegistry(interactiveBrowserTools());assert(!r.available().some(d=>d.name.startsWith('browser_')));const tools=r.available(false,true);assert(tools.some(d=>d.name==='browser_start'));assert(!tools.some(d=>d.name==='browser_navigate'));
 assert.throws(()=>r.validate('browser_click',{snapshotId:'s',targetId:'1',url:'https://evil.example'}));assert.throws(()=>r.validate('browser_scroll',{delta:1001}));assert.throws(()=>r.validate('browser_type',{snapshotId:'s',targetId:'1',text:'x'.repeat(2049)}));
});
test('live network validates every resource, drops Host-controlled headers and gates mutations/auth',()=>{
 for(const url of ['http://example.com/','https://127.0.0.1/','https://169.254.169.254/','https://[::1]/','file:///etc/passwd','wss://example.com/'])assert.throws(()=>validateLiveRequest(request({url})));
 const r=validateLiveRequest(request({headers:{Host:'internal','Proxy-Authorization':'secret','Cookie':'guest=1','Accept':'text/html'}}));assert.deepEqual(r.headers,{cookie:'guest=1',accept:'text/html'});assert.equal(needsNetworkApproval(r),false);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal(needsNetworkApproval(validateLiveRequest(request({method,body:'user-approved'}))),true);
 assert.equal(needsNetworkApproval(validateLiveRequest(request({headers:{Authorization:'Bearer guest'}}))),true);
 assert.throws(()=>validateLiveRequest(request({method:'CONNECT'})));assert.throws(()=>validateLiveRequest(request({headers:{Accept:'x\r\nHost: local'}})));assert.throws(()=>validateLiveRequest(request({method:'POST',body:'x'.repeat(65537)})));
});
test('persistent browser: same session, stale observations rejected, cleanup confirmed',async()=>{
 const b=new Backend(),live=new LiveBrowser('vault','task',b);await live.start();const first=await live.action({op:'observe'},async()=>true);await live.action({op:'type',snapshotId:first.snapshotId,targetId:'1',text:'query'},async()=>true);assert.equal(b.id,live.id);
 await assert.rejects(live.action({op:'click',snapshotId:'old',targetId:'1'},async()=>true),/stale/);await assert.rejects(live.action({op:'type',snapshotId:first.snapshotId,targetId:'missing',text:'query'},async()=>true),/stale/);
 await live.close();assert.equal(b.ended,true);await assert.rejects(live.action({op:'observe'},async()=>true),/session_ended/);
});
test('background POST is denied before transport; public GET may use only the browser broker',async()=>{
 const b=new Backend(),requests=[],live=new LiveBrowser('vault','task',b,async r=>{requests.push(r);return {status:200,headers:[],body:Buffer.from('ok').toString('base64')}});await live.start();
 b.listener({event:'request',...request({method:'POST',body:'private'})});await flush();assert.equal(requests.length,0);assert.equal(b.messages.at(-1).error,true);
 b.listener({event:'request',...request()});await flush();assert.equal(requests.length,1);assert.equal(b.messages.at(-1).status,200);await live.close();
});
test('network approval refusal sends no request; grant is one exact immutable request',async()=>{
 for(const answer of [false,true]){const b=new Backend();b.sendLive=async function(m){this.messages.push(m);if(m.op!=='response'){this.action=m;queueMicrotask(()=>this.listener({event:'request',...request({method:'POST',body:'q=query'})}));}};
 const sent=[],live=new LiveBrowser('vault','task',b,async r=>{sent.push(r);return {status:200,headers:[],body:''}});await live.start();let approvals=0;
 live.observation=observation();live.observedId='snapshot';
 const action=live.action({op:'click',snapshotId:'snapshot',targetId:'1'},async p=>{approvals++;assert.equal(p.scope,'network-sensitive');assert.match(p.command,/POST https:\/\/example.com/);return answer;});await flush();b.listener({event:'result',id:b.action.id,value:observation()});await action;assert.equal(approvals,1);assert.equal(sent.length,answer?1:0);await live.close();}
});
test('Agent waits for browser cleanup and reports uncertainty instead of completed on cleanup failure',async()=>{
 let cleaned=false;const tools={available:()=>[],validateVault:async()=>{},finishExecution:async()=>{await flush();cleaned=true;throw Error('cleanup');}};
 const runtime=new SingleAgentRuntime(new MockAgentModel(async()=>({text:'done',calls:[],continuation:null,usage:null})),tools);const task=await runtime.run({vaultId:'v',model:'m',prompt:'test'});assert.equal(cleaned,true);assert.equal(task.status,'UNCONFIRMED');assert.equal(task.code,'browser_cleanup_unconfirmed');
});

test('UI frames have independent bounded replies and never alter model observations',async()=>{
 const b=new Backend(),live=new LiveBrowser('vault','task',b);await live.start();const page=await live.action({op:'observe'},async()=>true);
 b.sendLive=async function(m){this.messages.push(m);if(m.op==='frame')queueMicrotask(()=>this.listener({event:'frame',id:m.id,data:Buffer.from([255,216,255,217]).toString('base64')}));};
 const frame=await live.frame();assert.ok(frame.data);assert.ok(frame.capturedAt);assert.equal(page.data,undefined);assert.equal(await live.frame(),null);await live.close();assert.equal(await live.frame(),null);
});

test('automatic page-load POST is blocked without asking user; GET page load remains available',async()=>{
 const b=new Backend(),sent=[],live=new LiveBrowser('vault','task',b,async r=>{sent.push(r);return {status:200,headers:[],body:''}});await live.start();let prompts=0;
 b.sendLive=async function(m){this.messages.push(m);if(m.op!=='response'){this.action=m;queueMicrotask(()=>this.listener({event:'request',...request({method:'POST',body:'telemetry'})}));}};
 const action=live.action({op:'navigate',url:'https://example.com/'},async()=>{prompts++;return true;});await flush();b.listener({event:'result',id:b.action.id,value:observation()});const page=await action;assert.equal(prompts,0);assert.equal(sent.length,0);assert.equal(page.networkBlocked,1);await live.close();
});

test('new actions validate stale references and bounded arguments before guest dispatch',async()=>{
 const b=new Backend(),live=new LiveBrowser('vault','task',b);await live.start();await live.action({op:'observe'},async()=>true);const count=b.messages.length;
 for(const action of [{op:'press',key:'F12'},{op:'select',value:'x'.repeat(161)},{op:'check',checked:'yes'}])await assert.rejects(live.action({...action,snapshotId:'snapshot',targetId:'1'},async()=>true));
 for(const op of ['press','select','check'])await assert.rejects(live.action({op,snapshotId:'old',targetId:'1',key:'Enter',value:'a',checked:true},async()=>true),/stale/);
 assert.equal(b.messages.length,count);await live.close();
});
