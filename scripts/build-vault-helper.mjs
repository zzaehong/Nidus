import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
if (process.platform === 'darwin') {
  mkdirSync('dist',{recursive:true});
  execFileSync('swiftc',['native/vault-files.swift','-o','dist/nidus-vault-files'],{stdio:'inherit'});
}
