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
