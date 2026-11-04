import {createHash,randomUUID} from 'node:crypto';
import {publicGet,publicURL,type PublicResponse} from './network-policy.js';
import {VaultError} from './types.js';

export interface BrowserRequest {url:string;kind:'navigate'|'search'}
export interface BrowserPage {url:string;title:string;text:string;links:{text:string;url:string}[];retrievedAt:string;untrusted:true;mode:'read-only-snapshot'}
/** Conservative lexical mismatch check, not semantic relevance or factual verification.
 * Ignore the page title: search engines can echo the query above unrelated results.
 */
export function checkSearchRelevance(page:BrowserPage,query:string):void {
 const ignored=new Set(['a','an','the','of','for','and','or','to','in','on','is','are','what','how','latest','spec','specs','specification','specifications','information','about','please','search']);
 const terms=[...new Set((query.toLowerCase().replace(/site:\S+/g,' ').match(/[\p{L}\p{N}]+/gu)??[]).filter(t=>t.length>1&&!ignored.has(t)))];
 const words=new Set((page.text+' '+page.links.map(l=>l.text).join(' ')).toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]);
 if(!terms.length||terms.filter(t=>words.has(t)).length<Math.min(2,terms.length))throw new VaultError('browser_search_unrelated');
}
export function browserRequest(tool:string,value:string):BrowserRequest {
 if(typeof value!=='string'||!value.trim())throw new VaultError('browser_invalid_request');
 if(tool==='browser_search'){
  if(value.length>512)throw new VaultError('browser_query_limit');
  return {kind:'search',url:publicURL('https://www.bing.com/search?q='+encodeURIComponent(value)+'&setlang=en&cc=US').href};
 }
 if(tool!=='browser_navigate')throw new VaultError('browser_invalid_request');
 return {kind:'navigate',url:publicURL(value).href};
}
/** The only Internet operation is the exact approved GET. No redirects or page subrequests. */
export async function browserSnapshot(request:BrowserRequest,vaultId:string,environmentId:string,signal:AbortSignal,get:typeof publicGet=publicGet){
 let response:PublicResponse;
 try{response=await get(request.url,signal);signal.throwIfAborted();}
 catch(error){throw error instanceof VaultError?error:new VaultError(signal.aborted?'network_cancelled':'network_transport_failed');}
 if(response.status>=300&&response.status<400)throw new VaultError('browser_redirect_requires_new_approval');
 if(response.status!==200)throw new VaultError('browser_http_'+response.status);
 const raw=Buffer.from(response.body,'base64');if(raw.length>262144)throw new VaultError('browser_page_limit');
 try{new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw new VaultError('browser_encoding_denied');}
 if(!['text/html','application/xhtml+xml','text/plain'].includes(response.contentType))throw new VaultError('browser_content_denied');
 const data=JSON.stringify({url:request.url,kind:request.kind,contentType:response.contentType,body:response.body});
 const files=[];for(let i=0;i<data.length;i+=60000){const content=data.slice(i,i+60000);files.push({path:`browser-${files.length}.json`,content,hash:createHash('sha256').update(content).digest('hex')});}
 return JSON.stringify({schemaVersion:1,snapshotId:randomUUID(),vaultId,environmentId,files});
}
/** All VM output remains untrusted, including links and titles. */
export function browserPage(stdout:string,url:string):BrowserPage {
 let value:any;try{value=JSON.parse(stdout);}catch{throw new VaultError('browser_result_invalid');}
 if(value.sandboxVerified!==true||typeof value.title!=='string'||typeof value.text!=='string'||!Array.isArray(value.links)||value.title.length>512||value.text.length>16000||value.links.length>40)throw new VaultError('browser_result_invalid');
 const links:BrowserPage['links']=[];
 for(const link of value.links){if(typeof link.text!=='string'||typeof link.url!=='string')throw new VaultError('browser_result_invalid');try{let candidate=new URL(link.url,url);const wrapped=candidate.searchParams.get('u');if(candidate.hostname==='www.bing.com'&&candidate.pathname==='/ck/a'&&wrapped?.startsWith('a1'))candidate=new URL(Buffer.from(wrapped.slice(2),'base64url').toString('utf8'));candidate.hash='';links.push({text:link.text.slice(0,160),url:publicURL(candidate.href).href});}catch{}}
 return {url,title:value.title,text:value.text,links,retrievedAt:new Date().toISOString(),untrusted:true,mode:'read-only-snapshot'};
}
