// App bridge: one JSON request on stdin, one { result } or { error } envelope on stdout, then exit.
// Keys arrive only on stdin and are never written to stdout, stderr or argv.
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { KeychainStore, type CredentialStore } from '../credentials.js';
import { NidusError, publicError } from '../errors.js';
import { difficulties, type Difficulty } from './assignment.js';
import { textOf, userText } from './contract.js';
import { ModelGateway } from './gateway.js';
import { isSplitGemini, providerId, type SplitGemini } from './gemini.js';
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

function gemini(value: unknown): SplitGemini {
  const provider = text(value, 'provider');
  if (!isSplitGemini(provider)) throw new NidusError('invalid_request', 'Quotas are available for Gemini Free and Gemini Paid.');
  return provider;
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
        if (provider === 'cloudflare') {
          const { models, accountId, discovered } = await gateway.connectCloudflare(secret, request.accountId);
          return { provider, models: models.length, accountId, discovered };
        }
        const models = await gateway.connect(provider, secret);
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
      case 'auto-fill':
        return await gateway.autoFill(request.apply === true);
      case 'exclude-model':
        await gateway.excludeModel({ ref: request.ref, scope: request.scope, role: request.role, difficulty: request.difficulty, note: request.note, taskId: request.taskId });
        return await gateway.overview();
      case 'restore-model':
        await gateway.restoreModel(request.ref, request.slot);
        return await gateway.overview();
      case 'set-budget':
        await gateway.setBudget(request.monthlyUSD === null || request.monthlyUSD === '' ? null : text(request.monthlyUSD, 'monthlyUSD'));
        return await gateway.overview();
      case 'check': {
        const provider = providerId(text(request.provider, 'provider'));
        return await gateway.checkModel(provider, text(request.model, 'model'));
      }
      case 'quota':
        return await gateway.quotaView(gemini(request.provider), request.all === true);
      case 'quota-refresh':
        return await gateway.refreshQuota(gemini(request.provider));
      case 'provider-settings':
        return await gateway.setProviderSettings(gemini(request.provider), { project: request.project, allowFallback: request.allowFallback, limits: request.limits });
      case 'gemini-move':
        await gateway.moveGemini(gemini(request.from), gemini(request.to));
        return await gateway.overview();
      case 'gemini-acknowledge':
        await gateway.acknowledgeGeminiMigration();
        return await gateway.overview();
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
