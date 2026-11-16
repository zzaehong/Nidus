import {lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VaultError, type FileIdentity} from './types.js';

/** Read-only helper checks the no-follow root identity before and after reading the volume UUID. */
export function macVolumeIdentity(root: string, identity: FileIdentity): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(fileURLToPath(new URL('../nidus-vault-files', import.meta.url)), [],
      {timeout: 5000, maxBuffer: 4096}, (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          if (error || !result.ok || typeof result.data?.volumeUuid !== 'string' ||
              !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.data.volumeUuid)) {
            reject(new VaultError('volume_identity_unavailable')); return;
          }
          resolve(result.data.volumeUuid);
        } catch { reject(new VaultError('volume_identity_unavailable')); }
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({operation: 'volume', root, identity, path: '.'}));
  });
}

export async function directoryVolumeIdentity(root: string): Promise<string> {
  const s = await lstat(root, {bigint: true});
  if (!s.isDirectory() || s.isSymbolicLink()) throw new VaultError('unsafe_directory');
  return macVolumeIdentity(root, {device: String(s.dev), inode: String(s.ino), birthtimeNs: String(s.birthtimeNs)});
}
