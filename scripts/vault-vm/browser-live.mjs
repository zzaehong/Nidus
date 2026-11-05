// Persistent Chromium for one Host-authorized task. No NIC, Host files or package cache.
import {spawn} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const child=spawn('/usr/lib/chromium/chromium',['--headless','--lang=ko-KR','--disable-setuid-sandbox','--disable-gpu','--in-process-gpu','--disable-software-rasterizer','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--disable-quic','--user-data-dir=/tmp/live-profile','--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/home',LANG:'C.UTF-8'}});
let sequence=0,buffer=Buffer.alloc(0),session,context,snapshot='',elements=[],closed=false,networkCount=0;const pending=new Map(),requests=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function call(method,params={},sessionId=session){return new Promise((resolve,reject)=>{if(closed)return reject(Error('browser_closed'));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('browser_cdp_timeout'));},20000);pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
function died(){closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('browser_closed'));}pending.clear();}
child.on('error',died);child.on('close',died);child.stderr.on('data',()=>{});child.stdio[3].on('error',died);
child.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>3*1024*1024){child.kill('SIGKILL');return;}let end;while((end=buffer.indexOf(0))>=0){const raw=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let m;try{m=JSON.parse(raw)}catch{child.kill('SIGKILL');return;}if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else if(m.method==='Fetch.requestPaused'){
 const r=m.params,requestId=r.requestId;requests.add(requestId);networkCount++;
 if(m.sessionId!==session||JSON.stringify(r.request).length>90000||(r.request.hasPostData&&typeof r.request.postData!=='string')){requests.delete(requestId);void call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});continue;}
 emit({event:'request',requestId,url:r.request.url,method:r.request.method,headers:r.request.headers,body:r.request.postData??'',resourceType:r.resourceType});
 }else if(m.method==='Fetch.authRequired'){void call('Fetch.continueWithAuth',{requestId:m.params.requestId,authChallengeResponse:{response:'CancelAuth'}},m.sessionId).catch(()=>{});}
}});
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:false});if(r.exceptionDetails)throw Error('browser_evaluation_failed');return r.result.value;}
async function settle(){let last=networkCount,stable=0;for(let i=0;i<650;i++){await sleep(100);if(requests.size===0&&last===networkCount){if(++stable>=4)return;}else stable=0;last=networkCount;}if(requests.size)throw Error('browser_action_timeout');}
function sandbox(){return readdirSync('/proc').filter(n=>/^\d+$/.test(n)).some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('--type=renderer')&&/^Seccomp:\s+2$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'))&&/^NoNewPrivs:\s+1$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'));}catch{return false;}});}
// DOM references are kept by CDP object IDs, never in a page-accessible global map.
async function observe(){
 if(!sandbox())throw Error('browser_renderer_sandbox_unconfirmed');
 const group='observation';await call('Runtime.releaseObjectGroup',{objectGroup:group});elements=[];snapshot=randomUUID();
 const list=await call('Runtime.evaluate',{expression:`Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'&&!e.disabled}).slice(0,60)`,objectGroup:group});
 const props=await call('Runtime.getProperties',{objectId:list.result.objectId,ownProperties:true});
 for(const prop of props.result.filter(p=>/^\d+$/.test(p.name))){const objectId=prop.value.objectId;const r=await call('Runtime.callFunctionOn',{objectId,functionDeclaration:`function(){const r=this.getBoundingClientRect();return {tag:this.tagName,role:this.getAttribute('role')||'',type:this.type||'',name:(this.getAttribute('aria-label')||this.innerText||this.placeholder||this.name||'').slice(0,160),value:this.type==='password'?'[redacted]':String(this.value||'').slice(0,160),href:this.getAttribute('href')||'',x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}}`,returnByValue:true});elements.push({...r.result.value,id:String(elements.length+1),objectId});}
 const page=await evaluate(`({url:location.href,title:document.title.slice(0,512),text:(document.body?.innerText||'').slice(0,9000),language:navigator.language,languages:navigator.languages,challengeVisible:Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#captcha-form')).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'})})`);
 let output={...page,snapshotId:snapshot,elements:elements.map(({objectId,...e})=>e),sandboxVerified:true,untrusted:true};while(Buffer.byteLength(JSON.stringify(output))>28000){if(output.text.length>1000)output.text=output.text.slice(0,Math.floor(output.text.length*.7));else output.elements.pop();}return output;
}
async function action(a){
 if(a.op==='observe'){await settle();return observe();}
 if(a.op==='navigate'){await call('Page.navigate',{url:a.url});await settle();return observe();}
 if(a.op==='back'){const h=await call('Page.getNavigationHistory');if(h.currentIndex>0)await call('Page.navigateToHistoryEntry',{entryId:h.entries[h.currentIndex-1].id});await settle();return observe();}
 if(a.op==='scroll'){await evaluate(`window.scrollBy(0,${Math.max(-1000,Math.min(1000,a.delta))})`);return observe();}
 if(!['click','type'].includes(a.op)||a.snapshotId!==snapshot)throw Error('browser_stale_observation');
 const e=elements.find(e=>e.id===a.targetId);if(!e)throw Error('browser_element_missing');
 // Refuse stale geometry or a changed/removed control; user/model must observe again.
 const state=await call('Runtime.callFunctionOn',{objectId:e.objectId,functionDeclaration:`function(){const r=this.getBoundingClientRect();return {connected:this.isConnected,disabled:!!this.disabled,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),href:this.getAttribute('href')||'',type:this.type||'',name:(this.getAttribute('aria-label')||this.innerText||this.placeholder||this.name||'').slice(0,160),hit:this.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}}`,returnByValue:true});const now=state.result.value;
 if(!now?.connected||now.disabled||now.x!==e.x||now.y!==e.y||now.href!==e.href||now.type!==e.type||now.name!==e.name||!now.hit)throw Error('browser_stale_observation');
 if(a.op==='type'){
  if(!['INPUT','TEXTAREA'].includes(e.tag))throw Error('browser_not_text_input');
  if(e.tag!=='TEXTAREA'&&!['','text','search','email','url','tel','password','number'].includes(e.type))throw Error('browser_input_type_denied');
  await call('DOM.focus',{objectId:e.objectId});await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.insertText',{text:a.text});
 }else{await call('Input.dispatchMouseEvent',{type:'mousePressed',x:e.x,y:e.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:e.x,y:e.y,button:'left',clickCount:1});}
 await settle();return observe();
}
let capturing=false;
async function frame(id){if(capturing){emit({event:'frame',id,error:true});return;}capturing=true;try{const layout=await call('Page.getLayoutMetrics');const viewport=layout.cssVisualViewport??layout.visualViewport;const {data}=await call('Page.captureScreenshot',{format:'jpeg',quality:35,captureBeyondViewport:false,clip:{x:viewport.pageX,y:viewport.pageY,width:1280,height:900,scale:0.625}});if(data.length>90000)throw Error('frame limit');emit({event:'frame',id,data});}catch{emit({event:'frame',id,error:true});}finally{capturing=false;}}
let chain=Promise.resolve();const input=createInterface({input:process.stdin});input.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return;}if(m.op==='frame'){void frame(m.id);return;}if(m.op==='response'){
 if(!requests.delete(m.requestId))return;
 void (m.error?call('Fetch.failRequest',{requestId:m.requestId,errorReason:'BlockedByClient'}):call('Fetch.fulfillRequest',{requestId:m.requestId,responseCode:m.status,responseHeaders:m.headers,body:m.body})).catch(()=>{});return;
 }
 chain=chain.then(async()=>{try{if(m.op==='close'){await call('Browser.close',{},null);emit({event:'result',id:m.id,value:{closed:true}});input.close();process.stdin.destroy();return;}const value=await action(m);emit({event:'result',id:m.id,value});}catch(e){emit({event:'result',id:m.id,error:String(e.message)});}});
});
input.on('close',()=>{child.kill('SIGKILL');});
try{
 ({browserContextId:context}=await call('Target.createBrowserContext',{disposeOnDetach:true},null));await call('Browser.setDownloadBehavior',{behavior:'deny',browserContextId:context},null);
 const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId:context},null);({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true},null));
 await call('Page.enable');await call('Network.enable');const version=await call('Browser.getVersion',{},null);await call('Network.setUserAgentOverride',{userAgent:version.userAgent,acceptLanguage:'ko-KR,ko,en-US,en,ja,zh-CN'});await call('Emulation.setLocaleOverride',{locale:'ko-KR'});await call('Network.setBypassServiceWorker',{bypass:true});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}],handleAuthRequests:true});emit({event:'ready'});
}catch(e){emit({event:'fatal',error:String(e.message)});child.kill('SIGKILL');input.close();process.stdin.destroy();process.exitCode=1;}
