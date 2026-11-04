import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
if(process.platform==='darwin'){
 mkdirSync('dist',{recursive:true});
 execFileSync('swiftc',['native/vault-vm.swift','-o','dist/nidus-vault-vm'],{stdio:'inherit'});
 execFileSync('codesign',['--force','--sign','-','--entitlements','native/vault-vm.entitlements','dist/nidus-vault-vm'],{stdio:'inherit'});
 const source=process.env.NIDUS_VM_BUILD_ASSETS;
 if(source){
  // Explicit build input only. Runtime never downloads or trusts a model-selected image.
  execFileSync('python3',['scripts/vault-vm/prepare.py',source],{stdio:'inherit'});
  mkdirSync('dist/vm-assets',{recursive:true});const manifest={profile:process.env.NIDUS_VM_DEVELOPMENT_ROOT?'development':'offline',...JSON.parse(readFileSync(join(source,'features.json'),'utf8'))};
  for(const name of ['Image','initrd']){copyFileSync(join(source,name),join('dist/vm-assets',name));manifest[name]=createHash('sha256').update(readFileSync(join(source,name))).digest('hex');}
  writeFileSync('dist/vm-assets/manifest.json',JSON.stringify(manifest,null,2));
 }else if(!existsSync('dist/vm-assets/manifest.json'))console.log('VM assets absent: app will fail closed until an explicit verified asset build.');
}
