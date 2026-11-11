import {createDOMReader} from './browser-dom.mjs';
// Persistent Chromium for one Host-authorized task. No NIC, Host files or package cache.
import {spawn} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const child=spawn('/usr/lib/chromium/chromium',['--headless','--lang=ko-KR','--disable-setuid-sandbox','--disable-gpu','--in-process-gpu','--disable-software-rasterizer','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--disable-quic','--user-data-dir=/tmp/live-profile','--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/home',LANG:'C.UTF-8'}});
let sequence=0,buffer=Buffer.alloc(0),session,context,mainTarget,reader,loader,observedRevision,observedLoader,cachedPage,settled=false,actionDispatched=false,snapshot='',elements=[],closed=false,networkCount=0;const pending=new Map(),requests=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function call(method,params={},sessionId=session){return new Promise((resolve,reject)=>{if(closed)return reject(Error('browser_closed'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('browser_cdp_timeout'));},20000);pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
function died(){closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('browser_closed'));}pending.clear();}
child.on('error',died);child.on('close',died);child.stderr.on('data',()=>{});child.stdio[3].on('error',died);
child.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>3*1024*1024){child.kill('SIGKILL');return;}let end;while((end=buffer.indexOf(0))>=0){const raw=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let m;try{m=JSON.parse(raw)}catch{child.kill('SIGKILL');return;}if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else if(m.method==='Fetch.requestPaused'){
 const r=m.params,requestId=r.requestId;requests.add(requestId);networkCount++;
 if(m.sessionId!==session||JSON.stringify(r.request).length>90000||(r.request.hasPostData&&typeof r.request.postData!=='string')){requests.delete(requestId);void call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});continue;}
 emit({event:'request',requestId,url:r.request.url,method:r.request.method,headers:r.request.headers,body:r.request.postData??'',resourceType:r.resourceType});
 }else if(m.method==='Target.targetCreated'){const t=m.params.targetInfo;if(t.type==='page'&&t.browserContextId===context&&t.targetId!==mainTarget)void call('Target.closeTarget',{targetId:t.targetId},null).catch(()=>{});
 }else if(m.method==='Fetch.authRequired'){void call('Fetch.continueWithAuth',{requestId:m.params.requestId,authChallengeResponse:{response:'CancelAuth'}},m.sessionId).catch(()=>{});}
}});
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:false});if(r.exceptionDetails)throw Error('browser_evaluation_failed');return r.result.value;}
async function dom(method,args=[],byValue=true){const r=await call('Runtime.callFunctionOn',{objectId:reader,functionDeclaration:`function(...args){return this[${JSON.stringify(method)}](...args)}`,arguments:args,returnByValue:byValue,objectGroup:'observation'});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description?.match(/browser_[a-z_]+/)?.[0]??'browser_evaluation_failed');return byValue?r.result.value:r.result;}
async function ensureDOM(){const {frameTree}=await call('Page.getFrameTree');if(reader&&loader===frameTree.frame.loaderId)return;loader=frameTree.frame.loaderId;const {executionContextId}=await call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'nidus-dom'});const r=await call('Runtime.evaluate',{expression:`(${createDOMReader.toString()})()`,contextId:executionContextId,objectGroup:'reader'});reader=r.result.objectId;if(!reader)throw Error('browser_dom_unavailable');await dom('state');}
async function settle(){let last='',stable=0;settled=false;for(let i=0;i<650;i++){await sleep(100);try{await ensureDOM();const s=await dom('state'),key=JSON.stringify([networkCount,s]);if(!requests.size&&s.ready&&!s.busy&&last===key){if(++stable>=4){settled=true;return;}}else stable=0;last=key;}catch{reader=undefined;}if(i>=49&&!requests.size)return;}if(requests.size)throw Error('browser_action_timeout');}
function sandbox(){return readdirSync('/proc').filter(n=>/^\d+$/.test(n)).some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('--type=renderer')&&/^Seccomp:\s+2$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'))&&/^NoNewPrivs:\s+1$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'));}catch{return false;}});}
// DOM references are kept by CDP object IDs, never in a page-accessible global map.
async function observe(){
 if(!sandbox())throw Error('browser_renderer_sandbox_unconfirmed');
 await ensureDOM();await call('Runtime.releaseObjectGroup',{objectGroup:'observation'});elements=[];snapshot=randomUUID();
 const before=await dom('state'),list=await dom('scan',[],false);const props=await call('Runtime.getProperties',{objectId:list.objectId,ownProperties:true});
 const nodes=props.result.filter(p=>/^\d+$/.test(p.name));
 for(const prop of nodes.slice(0,60)){const objectId=prop.value.objectId,value=await dom('metadata',[{objectId}]),fingerprint=await dom('fingerprint',[{objectId}]);elements.push({...value,id:String(elements.length+1),objectId,fingerprint});}
 const page=await dom('page'),after=await dom('state');observedRevision=after.revision;observedLoader=loader;
 if(before.revision!==after.revision) {snapshot='';throw Error('browser_dom_changed');}
 cachedPage={...page,snapshotId:snapshot,sandboxVerified:true,untrusted:true,settled,ready:after.ready,textLength:page.text.length,elementsOmitted:Math.max(0,nodes.length-60)};
 return pageSlice(0,true);
}
function pageSlice(offset,controls=false){const p=cachedPage,end=Math.min(offset+4000,p.text.length);const output={...p,text:p.text.slice(offset,end),textOffset:offset,nextOffset:end<p.text.length?end:null,elements:controls?elements.map(({objectId,fingerprint,...e})=>e):[]};while(Buffer.byteLength(JSON.stringify(output))>28000&&output.elements.length)output.elements.pop();output.elementsOmitted+=controls?elements.length-output.elements.length:0;return output;}
async function current(){await ensureDOM();const state=await dom('state');if(!snapshot||loader!==observedLoader||state.revision!==observedRevision||state.url!==cachedPage.url)throw Error('browser_stale_observation');}
async function action(a){
 actionDispatched=false;
 if(a.op==='observe'){await settle();return observe();}
 if(a.op==='read'){if(a.snapshotId!==snapshot||!Number.isSafeInteger(a.offset)||a.offset<0||a.offset>cachedPage?.text.length)throw Error('browser_stale_observation');await current();return pageSlice(a.offset);}
 if(a.op==='navigate'){await call('Page.navigate',{url:a.url});reader=undefined;await settle();return observe();}
 if(a.op==='back'){const h=await call('Page.getNavigationHistory');if(h.currentIndex>0)await call('Page.navigateToHistoryEntry',{entryId:h.entries[h.currentIndex-1].id});reader=undefined;await settle();return observe();}
 if(a.op==='scroll'){await evaluate(`window.scrollBy(0,${Math.max(-1000,Math.min(1000,a.delta))})`);await settle();return observe();}
 if(!['click','type','press','select','check'].includes(a.op)||a.snapshotId!==snapshot)throw Error('browser_stale_observation');
 await current();const e=elements.find(e=>e.id===a.targetId);if(!e)throw Error('browser_element_missing');
 if(e.disabled||!await dom('valid',[{objectId:e.objectId},{value:e.fingerprint}]))throw Error('browser_stale_observation');
 if(['type','select','check'].includes(a.op)&&e.readonly)throw Error('browser_readonly');
 if(a.op==='click'&&e.target&&e.target!=='_self')throw Error('browser_new_tab_unsupported');
 if(a.op==='type'){
  if(!e.editable&&!['INPUT','TEXTAREA'].includes(e.tag))throw Error('browser_not_text_input');
  if(!e.editable&&e.tag!=='TEXTAREA'&&!['','text','search','email','url','tel','password','number'].includes(e.type))throw Error('browser_input_type_denied');
  actionDispatched=true;snapshot='';await call('DOM.focus',{objectId:e.objectId});await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.insertText',{text:a.text});
 }else if(a.op==='press'){
  const keys={Enter:['Enter',13],Tab:['Tab',9],Escape:['Escape',27],ArrowUp:['ArrowUp',38],ArrowDown:['ArrowDown',40],ArrowLeft:['ArrowLeft',37],ArrowRight:['ArrowRight',39],Space:['Space',32]};if(!Object.hasOwn(keys,a.key))throw Error('browser_key_denied');
  actionDispatched=true;snapshot='';await call('DOM.focus',{objectId:e.objectId});const [code,windowsVirtualKeyCode]=keys[a.key],key=a.key==='Space'?' ':a.key;await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(a.key==='Enter'?{text:'\r'}:a.key==='Space'?{text:' '}: {})});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
 }else if(a.op==='select'){if(typeof a.value!=='string'||a.value.length>160)throw Error('browser_option_unavailable');actionDispatched=true;snapshot='';await dom('select',[{objectId:e.objectId},{value:a.value}]);
 }else{
  if(a.op==='check'&&(!['checkbox','radio'].includes(e.role)||typeof a.checked!=='boolean'||e.role==='radio'&&!a.checked))throw Error('browser_check_unsupported');
  if(a.op!=='check'||e.checked!==a.checked){actionDispatched=true;snapshot='';await call('Input.dispatchMouseEvent',{type:'mousePressed',x:e.x,y:e.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:e.x,y:e.y,button:'left',clickCount:1});}
 }
 snapshot='';await settle();
 if(['type','select','check'].includes(a.op)){let verified=false;try{verified=await dom('verify',[{objectId:e.objectId},{value:a.op},{value:a.op==='type'?a.text:a.op==='select'?a.value:a.checked}]);}catch{}if(!verified)throw Error('browser_action_unverified');}
 const result=await observe();return {...result,actionResult:{operation:a.op,status:['type','select','check'].includes(a.op)?'verified':'dispatched',note:['click','press'].includes(a.op)?'Input dispatched; page observation is not proof of business outcome.':undefined}};
}
let capturing=false;
async function frame(id){if(capturing){emit({event:'frame',id,error:true});return;}capturing=true;try{const layout=await call('Page.getLayoutMetrics');const viewport=layout.cssVisualViewport??layout.visualViewport;const {data}=await call('Page.captureScreenshot',{format:'jpeg',quality:35,captureBeyondViewport:false,clip:{x:viewport.pageX,y:viewport.pageY,width:1280,height:900,scale:0.625}});if(data.length>90000)throw Error('frame limit');emit({event:'frame',id,data});}catch{emit({event:'frame',id,error:true});}finally{capturing=false;}}
let chain=Promise.resolve();const input=createInterface({input:process.stdin});input.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return;}if(m.op==='frame'){void frame(m.id);return;}if(m.op==='response'){
 if(!requests.delete(m.requestId))return;
 void (m.error?call('Fetch.failRequest',{requestId:m.requestId,errorReason:'BlockedByClient'}):call('Fetch.fulfillRequest',{requestId:m.requestId,responseCode:m.status,responseHeaders:m.headers,body:m.body})).catch(()=>{});return;
 }
 chain=chain.then(async()=>{try{if(m.op==='close'){await call('Browser.close',{},null);emit({event:'result',id:m.id,value:{closed:true}});input.close();process.stdin.destroy();return;}const value=await action(m);emit({event:'result',id:m.id,value});}catch(e){emit({event:'result',id:m.id,error:actionDispatched&&e.message!=='browser_action_unverified'?'browser_action_outcome_unknown':String(e.message)});}});
});
input.on('close',()=>{child.kill('SIGKILL');});
try{
 ({browserContextId:context}=await call('Target.createBrowserContext',{disposeOnDetach:true},null));await call('Browser.setDownloadBehavior',{behavior:'deny',browserContextId:context},null);
 const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId:context},null);mainTarget=targetId;await call('Target.setDiscoverTargets',{discover:true},null);({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true},null));
 await call('Page.enable');await call('Network.enable');const version=await call('Browser.getVersion',{},null);await call('Network.setUserAgentOverride',{userAgent:version.userAgent,acceptLanguage:'ko-KR,ko,en-US,en,ja,zh-CN'});await call('Emulation.setLocaleOverride',{locale:'ko-KR'});await call('Network.setBypassServiceWorker',{bypass:true});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}],handleAuthRequests:true});emit({event:'ready'});
}catch(e){emit({event:'fatal',error:String(e.message)});child.kill('SIGKILL');input.close();process.stdin.destroy();process.exitCode=1;}
