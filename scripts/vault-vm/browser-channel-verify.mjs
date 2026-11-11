// Real product Host channel; synthetic Vault and programmatic approvals, no Provider.
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import assert from 'node:assert/strict';
import {VaultRegistry} from '../../dist/vault/registry.js';import {VMClient} from '../../dist/vault/vm-client.js';
const base=await realpath(await mkdtemp('/private/tmp/nidus-web-channel-'));await mkdir(join(base,'vault'));
const registry=new VaultRegistry(join(base,'registry')),vault=await registry.registerVault(join(base,'vault')),client=new VMClient(registry);
const evidence={scope:'Real product direct-browser channel, no Provider, synthetic Vault, programmatic approvals'};
async function run(approved){
 const child=spawn(process.execPath,['dist/agent-channel.js'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,NIDUS_VAULT_REGISTRY:registry.directory},stdio:['pipe','pipe','pipe']});child.stderr.resume();const events=[];
 const timer=setTimeout(()=>child.kill('SIGTERM'),80000);
 createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);events.push(event);if(event.event==='approval'){assert.equal(event.proposal.browser.url,'https://example.com/');child.stdin.write(JSON.stringify({method:'approval',approvalId:event.proposal.approvalId,approved})+'\n');}});
 child.stdin.write(JSON.stringify({method:'direct-browser',vaultId:vault.vaultId,tool:'browser_navigate',value:'https://example.com/'})+'\n');
 try{assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0);}finally{clearTimeout(timer);}
 return events;
}
try{
 evidence.denied=await run(false);assert.equal(evidence.denied.find(e=>e.event==='tool-result').result.status,'denied');assert.equal((await client.status()).sessions.length,0);
 evidence.approved=await run(true);const result=evidence.approved.find(e=>e.event==='tool-result').result;assert.equal(result.status,'succeeded');assert.equal(JSON.parse(result.content.text).url,'https://example.com/');assert.equal(evidence.approved.find(e=>e.event==='completed').task.webStatus,'used');
 await client.request('stop');await client.request('shutdown');evidence.stop='STOP_CONFIRMED';evidence.status='PASS';
}catch(e){evidence.status='FAIL';evidence.error=String(e);process.exitCode=1;try{await client.request('stop');await client.request('shutdown');evidence.stop='STOP_CONFIRMED';}catch{evidence.stop='STOP_UNCONFIRMED';}}
await writeFile(process.argv[2],JSON.stringify(evidence,null,2));if(evidence.stop==='STOP_CONFIRMED')await rm(base,{recursive:true,force:true});
