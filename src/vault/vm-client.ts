import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat} from 'node:fs/promises';
import {VaultRegistry} from './registry.js';
import {VMJournal,readVMFile,safeVMDirectory} from './vm-journal.js';
import {VaultError} from './types.js';
export class VMClient {
 readonly directory:string;
 constructor(private readonly registry=new VaultRegistry()){this.directory=join(registry.directory,'vm-runtime');}
 async request(method:string,args:Record<string,unknown>={},startService=false):Promise<any>{
  if(startService){
   try{await lstat(join(this.directory,'owner'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
    const child=spawn(process.execPath,[fileURLToPath(new URL('./vm-service.js',import.meta.url)),this.registry.directory],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'',NIDUS_VM_IDLE_MS:process.env.NIDUS_VM_IDLE_MS??'300000'}});child.unref();
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    for(let i=0;i<100;i++){try{await lstat(join(this.directory,'control.sock'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
   }
  }
  await safeVMDirectory(this.directory);
  const token=await readVMFile(join(this.directory,'owner','token'));
  const socketPath=join(this.directory,'control.sock'),s=await lstat(socketPath);
  if(!s.isSocket()||s.isSymbolicLink()||s.uid!==process.getuid!()||(s.mode&0o077))throw new VaultError('vm_unsafe_socket');
  return new Promise((resolve,reject)=>{
   const socket=connect(socketPath);socket.setEncoding('utf8');let buffer='';const timer=setTimeout(()=>{socket.destroy();reject(new VaultError('vm_channel_timeout'));},85000);
   const done=(error:Error|null,value?:unknown)=>{clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
   socket.on('connect',()=>socket.write(JSON.stringify({...args,token,method})+'\n'));
   socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>262144){done(new VaultError('vm_channel_limit'));return;}
    if(buffer.includes('\n')){try{const r=JSON.parse(buffer);done(r.error?new VaultError(r.error):null,r.result);}catch{done(new VaultError('vm_channel_invalid'));}}
   });socket.on('error',()=>done(new VaultError('vm_manager_unavailable')));socket.on('end',()=>{if(!buffer.includes('\n'))done(new VaultError('STOP_UNCONFIRMED'));});
  });
 }
 async status(){try{return await this.request('status');}catch{
  const s=await new VMJournal(this.directory).read();let owned=false;try{await lstat(join(this.directory,'owner'));owned=true;}catch{}
  if(owned||!['STOPPED','STOP_CONFIRMED'].includes(s.state)){s.state='STOP_UNCONFIRMED';s.ready=false;}return s;
 }}
}
