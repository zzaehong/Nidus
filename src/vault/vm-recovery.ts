import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,lstat,rename,rmdir,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeVMDirectory,readVMFile} from './vm-journal.js';
import {initialVMStatus} from './vm-protocol.js';
import {VaultError} from './types.js';
const exec=promisify(execFile);
export function hasVMProcesses(commands:string,args:string){
 return commands.split('\n').some(line=>/(?:^|\/)nidus-vault-vm\s*$/.test(line.trim()))||args.split('\n').some(line=>/(?:^|\s)(?:[^\s]*\/)?vm-service\.js(?:\s|$)/.test(line));
}
async function assertNoVMProcesses(){
 if(process.platform!=='darwin')throw new VaultError('vm_recovery_platform');
 try{const [commands,args]=await Promise.all([exec('/bin/ps',['-axo','comm='],{timeout:5000,maxBuffer:4*1024*1024}),exec('/bin/ps',['-axo','args='],{timeout:5000,maxBuffer:8*1024*1024})]);if(hasVMProcesses(commands.stdout,args.stdout))throw new VaultError('vm_recovery_process_active');}
 catch(e){if(e instanceof VaultError)throw e;throw new VaultError('vm_recovery_inspection_failed');}
}
/** Explicit cold recovery only. Preserve old evidence/cache; never claim guest cleanup or reuse dirty disks. */
export async function archiveStoppedRuntime(directory:string,inspect=assertNoVMProcesses){
 const parent=dirname(directory),lock=join(parent,'vm-recovery-lock');await safeVMDirectory(parent);await safeVMDirectory(directory);
 try{await mkdir(lock,{mode:0o700});}catch{throw new VaultError('vm_recovery_busy');}
 try{
  const before=await lstat(directory),raw=await readVMFile(join(directory,'state.json'));
  await inspect();await new Promise(r=>setTimeout(r,150));await inspect();
  const after=await lstat(directory);if(before.ino!==after.ino||before.dev!==after.dev||raw!==await readVMFile(join(directory,'state.json')))throw new VaultError('vm_recovery_state_changed');
  const archive=join(parent,'vm-runtime-archive-'+randomUUID());await rename(directory,archive);
  const fd=await open(parent,'r');try{await fd.sync();}finally{await fd.close();}
  return {...initialVMStatus(),recovered:true,archivePath:archive,statusSource:'cold-recovery',recoveryNote:'이전 실행 결과는 보관했으며 정리 성공으로 변경하지 않았습니다. 이전 캐시는 재사용하지 않습니다.'};
 }finally{await rmdir(lock);}
}
