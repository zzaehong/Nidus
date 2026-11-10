// App bridge: one JSON request on stdin, one { result } or { error } envelope on stdout, then exit.
// Keys arrive only on stdin and are never written to stdout, stderr or argv.
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { providerId } from '../adapters/index.js';
import { cloudflareCredential } from '../adapters/cloudflare.js';
import { KeychainStore, type CredentialStore } from '../credentials.js';
import { NidusError, publicError } from '../errors.js';
import { difficulties, type Difficulty } from './assignment.js';
import { textOf, userText } from './contract.js';
import { ModelGateway } from './gateway.js';
import type { ProviderClient } from './providers.js';
import { initVault, openVault, vaultPaths } from './vault.js';

export interface BridgeDependencies {
  credentials?: CredentialStore;
  providers?: ProviderClient;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new NidusError('invalid_request', `"${name}" is required.`);
  return value;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function dispatch(input: unknown, dependencies: BridgeDependencies = {}): Promise<unknown> {
  if (!input || typeof input !== 'object') throw new NidusError('invalid_request', 'Invalid request.');
  const request = input as Record<string, unknown>;
  const method = text(request.method, 'method');
  if (method === 'ping') return { ready: true };

  const root = text(request.vault, 'vault');
  if (method === 'vault-status') {
    const paths = vaultPaths(root);
    return { vault: paths.root, exists: await isDirectory(paths.root), initialized: await isDirectory(paths.nidus) && await stat(paths.modelsFile).then(() => true, () => false) };
  }
  if (method === 'vault-init') {
    const { paths, created } = await initVault(root);
    return { vault: paths.root, created };
  }

  const gateway = new ModelGateway(await openVault(root), { credentials: dependencies.credentials ?? new KeychainStore(), providers: dependencies.providers });
  try {
    switch (method) {
      case 'overview':
        return await gateway.overview();
      case 'models':
        return await gateway.modelChoices(providerId(text(request.provider, 'provider')));
      case 'connect': {
        const provider = providerId(text(request.provider, 'provider'));
        const secret = text(request.key, 'key');
        const models = await gateway.connect(provider, provider === 'cloudflare' ? cloudflareCredential(secret, request.accountId) : secret);
        return { provider, models: models.length };
      }
      case 'refresh': {
        const provider = providerId(text(request.provider, 'provider'));
        return { provider, models: (await gateway.refreshModels(provider)).length };
      }
      case 'disconnect':
        await gateway.disconnect(providerId(text(request.provider, 'provider')));
        return { disconnected: true };
      case 'set-candidates':
        await gateway.setCandidates(text(request.slot, 'slot'), request.candidates);
        return await gateway.overview();
      case 'set-budget':
        await gateway.setBudget(request.monthlyUSD === null || request.monthlyUSD === '' ? null : text(request.monthlyUSD, 'monthlyUSD'));
        return await gateway.overview();
      case 'verify': {
        const provider = providerId(text(request.provider, 'provider'));
        return await gateway.verifyTools(provider, text(request.model, 'model'));
      }
      case 'ask': {
        const difficulty = request.difficulty === undefined || request.difficulty === null ? undefined : request.difficulty as Difficulty;
        if (difficulty !== undefined && !difficulties.includes(difficulty)) throw new NidusError('invalid_request', 'Invalid difficulty.');
        const system = typeof request.system === 'string' && request.system.trim() ? request.system : undefined;
        const result = await gateway.send({ role: text(request.role, 'role'), difficulty }, { system, messages: [userText(text(request.prompt, 'prompt'))] });
        return {
          text: textOf(result.response.content),
          stopReason: result.response.stopReason,
          model: `${result.response.provider}:${result.response.model}`,
          reason: result.assignment.reason,
          inputTokens: result.response.usage.inputTokens,
          outputTokens: result.response.usage.outputTokens,
          costUSD: result.costUSD,
          warnings: result.warnings.map(warning => warning.message),
        };
      }
      default:
        throw new NidusError('invalid_request', 'Unknown method.');
    }
  } finally {
    gateway.close();
  }
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new NidusError('invalid_request', 'Request exceeds 1 MiB.');
  }
  process.stdout.write(JSON.stringify({ result: await dispatch(JSON.parse(input)) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stdout.write(JSON.stringify({ error: publicError(error).toJSON() }));
  });
}
