import {request as httpsRequest} from 'node:https';
import {publicURL,resolvePublic} from './network-policy.js';
import {VaultError} from './types.js';
export interface LiveRequest {requestId:string;url:string;method:string;headers:Record<string,string>;body:string;resourceType:string}
export interface LiveResponse {status:number;headers:{name:string;value:string}[];body:string}
export function validateLiveRequest(input:any):LiveRequest {
 if(!input||typeof input.requestId!=='string'||input.requestId.length>128||typeof input.method!=='string'||!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(input.method)||typeof input.body!=='string'||Buffer.byteLength(input.body)>65536||!input.headers||Array.isArray(input.headers)||typeof input.headers!=='object'||Buffer.byteLength(JSON.stringify(input.headers))>32768)throw new VaultError('browser_network_request_invalid');
 const url=publicURL(input.url).href;const headers:Record<string,string>={};
 for(const [name,value] of Object.entries(input.headers)){if(typeof value!=='string'||/[\r\n\0]/.test(name+value))throw new VaultError('browser_network_header_invalid');if(['accept','accept-language','content-type','cookie','authorization','origin','referer','range','user-agent'].includes(name.toLowerCase()))headers[name.toLowerCase()]=value;}
 if((input.method==='GET'||input.method==='HEAD')&&input.body)throw new VaultError('browser_network_request_invalid');
 return {requestId:input.requestId,url,method:input.method,body:input.body,headers,resourceType:String(input.resourceType??'')};
}
export const needsNetworkApproval=(r:LiveRequest)=>!['GET','HEAD','OPTIONS'].includes(r.method)||!!r.headers.authorization;
/** No NIC or CONNECT tunnel. Every redirect/resource has fresh DNS and pinned TLS. */
export async function liveRequest(input:LiveRequest,signal:AbortSignal):Promise<LiveResponse>{
 const r=validateLiveRequest(input),url=publicURL(r.url),deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
 const address=await Promise.race([resolvePublic(url),new Promise<never>((_,reject)=>{deadline.addEventListener('abort',()=>reject(new VaultError('browser_network_timeout')),{once:true});if(deadline.aborted)reject(new VaultError('browser_network_timeout'));})]);deadline.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const req=httpsRequest(url,{method:r.method,agent:false,family:4,servername:url.hostname,lookup:(_h,_o,cb)=>cb(null,address,4),headers:{...r.headers,'accept-encoding':'identity',...(r.body?{'content-length':Buffer.byteLength(r.body)}:{})},signal:deadline,timeout:10000},res=>{
   if(res.headers['content-disposition']||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new VaultError('browser_network_content_denied'));return;}
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(b:Buffer)=>{size+=b.length;if(size>2*1024*1024){res.destroy();reject(new VaultError('browser_resource_limit'));}else chunks.push(b);});res.on('error',()=>reject(new VaultError('browser_network_failed')));
   res.on('end',()=>{const headers=[];for(let i=0;i<res.rawHeaders.length;i+=2){const name=res.rawHeaders[i]!,value=res.rawHeaders[i+1]!;if(!['connection','transfer-encoding','content-length','content-encoding','alt-svc','upgrade','proxy-authenticate'].includes(name.toLowerCase()))headers.push({name,value});}resolve({status:res.statusCode??502,headers,body:Buffer.concat(chunks).toString('base64')});});
  });req.on('socket',s=>s.once('connect',()=>{if(s.remoteAddress!==address)req.destroy(new VaultError('browser_network_peer_mismatch'));}));req.on('timeout',()=>req.destroy());req.on('error',()=>reject(new VaultError('browser_network_failed')));req.end(r.body||undefined);
 });
}
