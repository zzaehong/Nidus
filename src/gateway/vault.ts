// Layout of the .nidus directory inside an Agent Vault.
//
//   .nidus/models.json   assignment table        (tracked by Git)
//   .nidus/budget.json   vault budget            (tracked by Git)
//   .nidus/.gitignore    excludes local/
//   .nidus/local/        usage database and model cache (not tracked)
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NidusError } from '../errors.js';

export interface VaultPaths {
  root: string;
  nidus: string;
  local: string;
  modelsFile: string;
  budgetFile: string;
  gitignore: string;
  usageDb: string;
  modelCache: string;
  verifiedFile: string;
}

export function vaultPaths(root: string): VaultPaths {
  const base = resolve(root);
  const nidus = join(base, '.nidus');
  const local = join(nidus, 'local');
  return {
    root: base,
    nidus,
    local,
    modelsFile: join(nidus, 'models.json'),
    budgetFile: join(nidus, 'budget.json'),
    gitignore: join(nidus, '.gitignore'),
    usageDb: join(local, 'usage.sqlite'),
    modelCache: join(local, 'models'),
    verifiedFile: join(local, 'models', 'verified.json'),
  };
}

const emptyTable = {
  version: 1,
  roles: { main: [], 'lead-manager': [], manager: [] },
  worker: { simple: [], normal: [], complex: [] },
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Creates the .nidus layout. Existing files are never overwritten. Returns the paths it created. */
export async function initVault(root: string): Promise<{ paths: VaultPaths; created: string[] }> {
  const paths = vaultPaths(root);
  if (!await exists(paths.root)) throw new NidusError('storage', 'Vault directory does not exist.');
  const created: string[] = [];
  try {
    await mkdir(paths.nidus, { recursive: true });
    await mkdir(paths.modelCache, { recursive: true, mode: 0o700 });
    if (await writeIfMissing(paths.modelsFile, `${JSON.stringify(emptyTable, null, 2)}\n`)) created.push(paths.modelsFile);
    if (await writeIfMissing(paths.budgetFile, `${JSON.stringify({ version: 1, monthlyUSD: null }, null, 2)}\n`)) created.push(paths.budgetFile);
    if (await writeIfMissing(paths.gitignore, 'local/\n')) {
      created.push(paths.gitignore);
    } else {
      // Runtime data must stay out of Git even when the file predates this layout.
      const current = await readFile(paths.gitignore, 'utf8');
      if (!current.split('\n').some(line => line.trim() === 'local/')) {
        await writeFile(paths.gitignore, `${current.replace(/\n?$/, '\n')}local/\n`);
      }
    }
  } catch (error) {
    if (error instanceof NidusError) throw error;
    throw new NidusError('storage', 'Could not initialize the .nidus directory.');
  }
  return { paths, created };
}

/** Resolves the layout of an initialized vault. */
export async function openVault(root: string): Promise<VaultPaths> {
  const paths = vaultPaths(root);
  if (!await exists(paths.modelsFile)) throw new NidusError('storage', 'No .nidus/models.json in this directory. Run "nidus gateway init" in the vault first.');
  await mkdir(paths.modelCache, { recursive: true, mode: 0o700 });
  return paths;
}
