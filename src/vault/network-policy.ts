import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request} from 'node:https';
import {VaultError} from './types.js';
export function publicIPv4(address:string):boolean {
 if(isIP(address)!==4)return false;const [a,b,c]=address.split('.').map(Number) as [number,number,number,number];
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===192&&b===0||a===192&&b===2||a===192&&b===88&&c===99||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
}
export function publicURL(input:string):URL {
 if(typeof input!=='string'||input.length>2048||/[\x00-\x20\\]/.test(input))throw new VaultError('network_url_denied');
 let url:URL;try{url=new URL(input);}catch{throw new VaultError('network_url_denied');}
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!url.hostname||url.hostname.endsWith('.')||url.hostname.startsWith('[')||['localhost','localhost.localdomain'].includes(url.hostname)||/\.(localhost|local|internal|home\.arpa)$/.test(url.hostname))throw new VaultError('network_url_denied');
 if(isIP(url.hostname)&&!publicIPv4(url.hostname))throw new VaultError('network_address_denied');return url;
}
export async function resolvePublic(url:URL,lookup:typeof dnsLookup=dnsLookup):Promise<string>{
 if(isIP(url.hostname))return publicIPv4(url.hostname)?url.hostname:Promise.reject(new VaultError('network_address_denied'));
 const addresses=await lookup(url.hostname,{all:true,verbatim:true});
 // IPv6 transport is deliberately absent. No fallback, NAT64, mapped-address or alternative resolver path.
 const ipv4=addresses.filter(a=>a.family===4);if(!ipv4.length||ipv4.some(a=>!publicIPv4(a.address)))throw new VaultError('network_dns_denied');return ipv4[0]!.address;
}
export interface PublicResponse {status:number;contentType:string;body:string;location?:string;address:string;url:string}
/** GET-only HTTPS, fresh DNS per request and an IP-pinned TLS socket. No raw CONNECT tunnel. */
export async function publicGet(input:string,signal:AbortSignal,dependencies:{lookup?:typeof dnsLookup;request?:typeof request}={}):Promise<PublicResponse>{
 const url=publicURL(input);signal.throwIfAborted();
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
 const address=await new Promise<string>((resolve,reject)=>{
  const abort=()=>{deadline.removeEventListener('abort',abort);reject(new VaultError(signal.aborted?'cancelled':'network_timeout'));};
  deadline.addEventListener('abort',abort,{once:true});
  resolvePublic(url,dependencies.lookup??dnsLookup).then(value=>{deadline.removeEventListener('abort',abort);resolve(value);},error=>{deadline.removeEventListener('abort',abort);reject(error instanceof VaultError?error:new VaultError('network_dns_failed'));});
  if(deadline.aborted)abort();
 });deadline.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const req=(dependencies.request??request)(url,{method:'GET',family:4,agent:false,servername:url.hostname,lookup:(_host,_options,callback)=>callback(null,address,4),headers:{'User-Agent':'Nidus-ReadOnly-Browser/1','Accept':'text/html,text/plain,text/css','Accept-Encoding':'identity'},signal:deadline,timeout:8000},res=>{
   const type=String(res.headers['content-type']??'').split(';')[0]!.toLowerCase();const status=res.statusCode??502;
   if(res.headers['content-disposition']||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||![301,302,303,307,308].includes(status)&&!['text/html','text/plain','text/css','application/xhtml+xml'].includes(type)){res.destroy();reject(new VaultError('network_content_denied'));return;}
   let size=0;const chunks:Buffer[]=[];
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>524288){res.destroy();reject(new VaultError('network_response_limit'));}else chunks.push(chunk);});
   res.on('error',()=>reject(new VaultError('network_transport_failed')));
   res.on('end',()=>{
    try{const location=res.headers.location?publicURL(new URL(res.headers.location,url).href).href:undefined;resolve({status,contentType:type||'text/plain',body:Buffer.concat(chunks).toString('base64'),address,url:url.href,...(location?{location}:{})});}
    catch(e){reject(e);}
   });
  });
  req.on('socket',socket=>socket.once('connect',()=>{if(socket.remoteAddress!==address){req.destroy(new VaultError('network_peer_mismatch'));}}));
  req.on('timeout',()=>req.destroy(new VaultError('network_timeout')));req.on('error',()=>reject(new VaultError(signal.aborted?'cancelled':'network_transport_failed')));req.end();
 });
}
