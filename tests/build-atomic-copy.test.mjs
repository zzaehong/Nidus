import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,open,rm,stat} from 'node:fs/promises';import {atomicCopy} from '../scripts/atomic-copy.mjs';
test('app binary replacement preserves the old mapped inode and replaces path atomically',async t=>{
 const dir=await mkdtemp('/private/tmp/nidus-atomic-');t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(dir+'/old','old code');await writeFile(dir+'/new','new code');const held=await open(dir+'/old','r');try{const before=await held.stat();await atomicCopy(dir+'/new',dir+'/old');assert.notEqual((await stat(dir+'/old')).ino,before.ino);assert.equal(await held.readFile('utf8'),'old code');assert.equal(await readFile(dir+'/old','utf8'),'new code');}finally{await held.close();}
});
