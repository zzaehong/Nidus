// Builds a local, unsigned development app bundle with Node and the compiled engine inside.
//   node scripts/build-app.mjs          -> dist/Nidus Base.app (earlier provider dashboard)
//   node scripts/build-app.mjs nidus    -> dist/Nidus.app      (Vault-based app)
import { mkdir, cp, readdir } from 'node:fs/promises';
import { atomicCopy as copyFile } from './atomic-copy.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('The app requires macOS.');

const variants = {
  base: {
    app: 'Nidus Base.app', product: 'NidusNativeApp', plist: 'Info.plist',
    directories: ['adapters', 'vault', 'tools', 'agent', 'gateway', 'vm-assets'],
    helpers: ['nidus-keychain', 'nidus-vault-files', 'nidus-vault-vm'],
  },
  // The Vault app with the Work tab: the workspace engine, the VM image and the VM helper.
  nidus: {
    app: 'Nidus.app', product: 'Nidus', plist: 'Nidus-Info.plist',
    directories: ['adapters', 'vault', 'tools', 'agent', 'gateway', 'workspace', 'vm-assets'],
    helpers: ['nidus-keychain', 'nidus-vault-files', 'nidus-vault-vm'],
  },
};
const variant = variants[process.argv[2] ?? 'base'];
if (!variant) throw new Error(`Unknown app variant. Use one of: ${Object.keys(variants).join(', ')}.`);

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync('swift', ['build', '-c', 'release', '--product', variant.product], { cwd: root, stdio: 'inherit' });
const bin = execFileSync('swift', ['build', '-c', 'release', '--show-bin-path'], { cwd: root, encoding: 'utf8' }).trim();

const contents = join(root, 'dist', variant.app, 'Contents');
const resources = join(contents, 'Resources');
for (const directory of ['MacOS', 'Resources/bin', 'Resources/dist']) await mkdir(join(contents, directory), { recursive: true });
await copyFile(join(root, 'native', variant.plist), join(contents, 'Info.plist'));
await copyFile(join(bin, variant.product), join(contents, 'MacOS', variant.product));
await copyFile(process.execPath, join(resources, 'bin', 'node'));

for (const entry of await readdir(join(root, 'dist'), { withFileTypes: true })) {
  if (entry.isDirectory()) {
    if (variant.directories.includes(entry.name)) await cp(join(root, 'dist', entry.name), join(resources, 'dist', entry.name), { recursive: true });
  } else if (entry.name.endsWith('.js') || variant.helpers.includes(entry.name)) {
    await copyFile(join(root, 'dist', entry.name), join(resources, 'dist', entry.name));
  }
}
console.log(`Built dist/${variant.app} (local unsigned development bundle; Node included).`);
