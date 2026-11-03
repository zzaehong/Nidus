import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
test('development image locks official ARM64 packages and required tools',()=>{
 const lock=JSON.parse(readFileSync('scripts/vault-vm/development.lock.json','utf8'));
 assert.equal(lock.architecture,'aarch64');
 for(const name of ['python3','py3-pip','nodejs','npm','git','bash','curl','build-base','chromium'])assert(lock.packages.some(p=>p.name===name));
 assert.equal(new Set(lock.packages.map(p=>p.name)).size,lock.packages.length);
 for(const p of lock.packages){assert.match(p.sha256,/^[a-f0-9]{64}$/);assert(p.bytes>0);assert.equal(p.url,`https://dl-cdn.alpinelinux.org/alpine/v3.24/${p.url.includes('/community/')?'community':'main'}/aarch64/${p.name}-${p.version}.apk`);}
});
test('newc layer ignores filesystem timestamps and rejects special objects',()=>{
 const script=`import sys,pathlib,tempfile,os
sys.path.insert(0,'scripts/vault-vm')
from newc import write
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp)/'root';root.mkdir();p=root/'text';p.write_text('sample');(root/'link').symlink_to('text')
 a=pathlib.Path(tmp)/'a.gz';b=pathlib.Path(tmp)/'b.gz';write(root,a);os.utime(p,(12,12));write(root,b);assert a.read_bytes()==b.read_bytes()
 os.mkfifo(root/'fifo')
 try:write(root,b)
 except ValueError:pass
 else:raise AssertionError('special object accepted')
`;
 const result=spawnSync('python3',['-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
