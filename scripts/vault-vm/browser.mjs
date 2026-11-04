// Trusted read-only renderer. Chromium has a fresh profile, no NIC, no cache mount.
import {spawn} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
const input=JSON.parse(readdirSync('/work').filter(n=>/^browser-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(n=>readFileSync('/work/'+n,'utf8')).join(''));
let html=Buffer.from(input.body,'base64').toString('utf8');
if(input.contentType==='text/plain')html='<pre>'+html.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</pre>';
const child=spawn('/usr/lib/chromium/chromium',['--headless','--disable-setuid-sandbox','--disable-gpu','--in-process-gpu','--disable-software-rasterizer','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--disable-quic','--user-data-dir=/tmp/browser-profile','--remote-debugging-pipe'],{stdio:['ignore','ignore','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/home',LANG:'C.UTF-8'}});
let next=0,buffer=Buffer.alloc(0),session;const pending=new Map();
function fail(error){for(const p of pending.values())p.reject(error);pending.clear();}
child.stderr.on('data',()=>{});child.on('error',fail);child.on('close',()=>fail(Error('browser_closed')));
function call(method,params={},sessionId=session){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
child.stdio[4].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1048576){fail(Error('browser_protocol_limit'));child.kill();return;}let end;while((end=buffer.indexOf(0))>=0){const raw=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let m;try{m=JSON.parse(raw)}catch{fail(Error('browser_protocol'));return;}if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Fetch.requestPaused'){void call('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'BlockedByClient'},m.sessionId).catch(()=>{});}}});
const timer=setTimeout(()=>{fail(Error('browser_timeout'));child.kill('SIGKILL');},20000);
try{
 const {browserContextId}=await call('Target.createBrowserContext',{disposeOnDetach:true});
 await call('Browser.setDownloadBehavior',{behavior:'deny',browserContextId});
 const {targetId}=await call('Target.createTarget',{url:'about:blank',browserContextId});
 ({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true}));
 await call('Page.enable');await call('Emulation.setScriptExecutionDisabled',{value:true});
 await call('Network.enable');await call('Network.setBlockedURLs',{urls:['*']});
 await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 const {frameTree}=await call('Page.getFrameTree');
 // CSP precedes the response and forbids resources, navigation helpers and forms.
 html='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'none\'; frame-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'">'+html;
 await call('Page.setDocumentContent',{frameId:frameTree.frame.id,html});
 const search=input.kind==='search';
 const {result}=await call('Runtime.evaluate',{expression:`JSON.stringify({title:document.title.slice(0,512),text:(${search?"document.querySelector('#b_results')":"document.body"}?.innerText||'').slice(0,16000),links:Array.from(document.querySelectorAll(${JSON.stringify(search?'.b_algo h2 a[href]':'a[href]')})).slice(0,40).map(a=>({text:(a.innerText||'').slice(0,160),url:(a.getAttribute('href')||'').slice(0,2048)}))})`,returnByValue:true});
 const sandboxed=readdirSync('/proc').filter(n=>/^\d+$/.test(n)).some(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('--type=renderer')&&/^Seccomp:\s+2$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'))&&/^NoNewPrivs:\s+1$/m.test(readFileSync(`/proc/${pid}/status`,'utf8'));}catch{return false;}});
 if(!sandboxed)throw Error('browser_renderer_sandbox_unconfirmed');
 // stdout has a 32 KiB guest limit; keep whole valid JSON even for multibyte pages.
 const value={...JSON.parse(result.value),sandboxVerified:true};while(Buffer.byteLength(JSON.stringify(value))>28000){if(value.links.length)value.links.pop();else value.text=value.text.slice(0,Math.floor(value.text.length*.8));}
 if(search&&(!value.text.trim()||!value.links.length))throw Error('browser_search_results_unavailable');
 await call('Target.disposeBrowserContext',{browserContextId},null);console.log(JSON.stringify(value));
}catch(error){console.error(String(error));process.exitCode=1;}finally{clearTimeout(timer);child.kill('SIGKILL');}
