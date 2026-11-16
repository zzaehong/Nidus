import {test} from 'node:test';import assert from 'node:assert/strict';
import {publicIPv4,publicURL,resolvePublic,publicGet} from '../dist/vault/network-policy.js';
test('development network: public IPv4 only, all internal/reserved address classes blocked',()=>{
 for(const address of ['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1','100.64.0.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicIPv4(address),false,address);
 assert.equal(publicIPv4('93.184.215.14'),true);
});
test('development network: URL credentials, ports, decimal/octal loopback and alternate protocols rejected',()=>{
 for(const url of ['http://example.com','file:///etc/passwd','https://user:pass@example.com','https://example.com:8443','https://2130706433','https://0177.0.0.1','https://[::1]','https://localhost','https://host.local','https://example.com./','https://example.com\\@127.0.0.1'])assert.throws(()=>publicURL(url));
 assert.equal(publicURL('https://example.com/path?q=test').hostname,'example.com');
});
test('development network: fresh DNS rejects rebinding and mixed private answers; IPv6 is never dialled',async()=>{
 let count=0;const lookup=async()=>++count===1?[{family:4,address:'93.184.215.14'},{family:6,address:'::1'}]:[{family:4,address:'127.0.0.1'}];
 assert.equal(await resolvePublic(publicURL('https://example.com'),lookup),'93.184.215.14');await assert.rejects(resolvePublic(publicURL('https://example.com'),lookup));
 await assert.rejects(resolvePublic(publicURL('https://example.com'),async()=>[{family:4,address:'93.184.215.14'},{family:4,address:'10.0.0.1'}]));
 await assert.rejects(resolvePublic(publicURL('https://example.com'),async()=>[{family:6,address:'2606:4700::1111'}]));
});
test('development network: real local test server receives zero denied requests',async t=>{
 const {createServer}=await import('node:http');let received=0;const server=createServer((_q,r)=>{received++;r.end('private');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await assert.rejects(publicGet(`https://127.0.0.1:${server.address().port}/`,new AbortController().signal));assert.equal(received,0);
});

test('browser network: TLS destination is pinned to validated DNS with no credentials or tunnel',async()=>{
 const {EventEmitter}=await import('node:events');let calls=0,lookups=0;
 const transport=(url,options,respond)=>{
  calls++;assert.equal(url.hostname,'example.com');assert.equal(options.method,'GET');assert.equal(options.servername,'example.com');assert.equal(options.agent,false);assert.equal(options.family,4);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers['Accept-Encoding'],'identity');
  options.lookup('example.com',{},(_e,address,family)=>{assert.equal(address,'93.184.215.14');assert.equal(family,4)});
  const req=new EventEmitter();req.destroy=e=>queueMicrotask(()=>req.emit('error',e));req.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();socket.remoteAddress='93.184.215.14';req.emit('socket',socket);socket.emit('connect');const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/html'};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from('safe'));res.emit('end');});return req;
 };
 const r=await publicGet('https://example.com/',new AbortController().signal,{lookup:async()=>{lookups++;return [{family:4,address:lookups===1?'93.184.215.14':'127.0.0.1'}]},request:transport});assert.equal(Buffer.from(r.body,'base64').toString(),'safe');assert.equal(calls,1);assert.equal(lookups,1);
});
test('browser network: compressed responses, downloads, oversized content and peer mismatch are rejected',async()=>{
 const {EventEmitter}=await import('node:events');
 for(const variant of ['compression','download','size','peer','private-redirect']){
  const request=(_url,_options,respond)=>{
   const req=new EventEmitter();req.destroy=e=>queueMicrotask(()=>req.emit('error',e));req.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();socket.remoteAddress=variant==='peer'?'127.0.0.1':'93.184.215.14';req.emit('socket',socket);socket.emit('connect');if(variant==='peer')return;const res=new EventEmitter();res.statusCode=variant==='private-redirect'?302:200;res.headers={'content-type':'text/html',...(variant==='compression'?{'content-encoding':'gzip'}:{}),...(variant==='download'?{'content-disposition':'attachment'}:{}),...(variant==='private-redirect'?{location:'https://169.254.169.254/'}:{})};res.destroy=()=>{};respond(res);res.emit('data',Buffer.alloc(variant==='size'?524289:1));res.emit('end');});return req;
  };
  await assert.rejects(publicGet('https://example.com/',new AbortController().signal,{lookup:async()=>[{family:4,address:'93.184.215.14'}],request}),/network_/);
 }
});
