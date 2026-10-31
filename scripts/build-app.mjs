import { mkdir, copyFile, cp, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('The dashboard requires macOS.');
const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync('swift', ['build', '-c', 'release'], { cwd: root, stdio: 'inherit' });
const bin = execFileSync('swift', ['build', '-c', 'release', '--show-bin-path'], { cwd: root, encoding: 'utf8' }).trim();
const contents = join(root, 'dist', 'Nidus.app', 'Contents');
const resources = join(contents, 'Resources');
for (const directory of ['MacOS', 'Resources/bin', 'Resources/dist']) await mkdir(join(contents, directory), { recursive: true });
await copyFile(join(root, 'native', 'Info.plist'), join(contents, 'Info.plist'));
await copyFile(join(bin, 'NidusNativeApp'), join(contents, 'MacOS', 'NidusNativeApp'));
await copyFile(process.execPath, join(resources, 'bin', 'node'));
for (const entry of await readdir(join(root, 'dist'), { withFileTypes: true })) {
  if (entry.name === 'adapters') await cp(join(root, 'dist', entry.name), join(resources, 'dist', entry.name), { recursive: true });
  else if (entry.name.endsWith('.js') || entry.name === 'nidus-keychain') await copyFile(join(root, 'dist', entry.name), join(resources, 'dist', entry.name));
}
console.log('Built dist/Nidus.app (local unsigned development bundle; Node included).');

await mkdir(join(resources, 'm0'), { recursive: true });
for (const name of ['recovery.py', 'lifecycle.py', 'workspace.py']) {
  await copyFile(join(root, 'scripts', 'agent-vm', name), join(resources, 'm0', name));
}
