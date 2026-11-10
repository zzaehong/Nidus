// "nidus gateway ..." commands. JSON on stdout, errors on stderr, like the rest of the CLI.
import { parseArgs } from 'node:util';
import { providerId } from '../adapters/index.js';
import { cloudflareCredential } from '../adapters/cloudflare.js';
import { credentialEnvironment, EnvironmentCredentials, KeychainStore, type CredentialStore } from '../credentials.js';
import { NidusError } from '../errors.js';
import { chatPrompt, secretPrompt } from '../prompt.js';
import { difficulties, type Difficulty } from './assignment.js';
import { textOf, toolCallsOf, userText } from './contract.js';
import { ModelGateway } from './gateway.js';
import type { ProviderClient } from './providers.js';
import { initVault, openVault } from './vault.js';

export const gatewayHelp = `Nidus Model Gateway
  nidus gateway init
  nidus gateway connect <provider> [--env] [--account-id <cloudflare-account-id>]
  nidus gateway models <provider> [--refresh]
  nidus gateway assign --role <role> [--difficulty simple|normal|complex] [--tools]
  nidus gateway ask --role <role> [--difficulty simple|normal|complex] [--system <text>] [--max-output-tokens <n>]
  nidus gateway verify <provider> <model-id>
  nidus gateway usage [--month YYYY-MM]

Every command takes --vault <dir> (default: current directory).
init: creates .nidus/models.json, .nidus/budget.json and .nidus/.gitignore.
connect: hidden key entry, model discovery, macOS Keychain storage. --env uses NIDUS_<PROVIDER>_API_KEY and stores no key.
assign: shows which model a role (and worker difficulty) resolves to, without calling it.
ask: sends one message (stdin or interactive prompt) to the assigned model. May incur provider charges.
verify: runs one real tool-call round trip against a model and records the result. May incur provider charges.
`;

export interface GatewayCliDependencies {
  write?: (text: string) => void;
  readSecret?: () => Promise<string>;
  readPrompt?: () => Promise<string>;
  credentials?: CredentialStore;
  providers?: ProviderClient;
}

function fail(message: string): never {
  throw new NidusError('invalid_request', message);
}

export async function gatewayMain(argv: string[], dependencies: GatewayCliDependencies = {}): Promise<void> {
  const write = dependencies.write ?? (text => { process.stdout.write(text); });
  const print = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);

  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' },
      vault: { type: 'string' },
      env: { type: 'boolean' },
      'account-id': { type: 'string' },
      refresh: { type: 'boolean' },
      role: { type: 'string' },
      difficulty: { type: 'string' },
      tools: { type: 'boolean' },
      system: { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'timeout-ms': { type: 'string' },
      month: { type: 'string' },
    } }));
  } catch {
    fail('Invalid arguments. Use nidus gateway --help. API keys must never be command-line arguments.');
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) { write(gatewayHelp); return; }

  const root = values.vault ?? process.cwd();
  if (command === 'init') {
    const { paths, created } = await initVault(root);
    print({ vault: paths.root, created });
    return;
  }

  const expected: Record<string, number> = { connect: 1, models: 1, assign: 0, ask: 0, verify: 2, usage: 0 };
  if (!(command in expected)) fail('Unknown gateway command. Use nidus gateway --help.');
  if (rest.length !== expected[command]) fail('Unexpected positional arguments. Use nidus gateway --help.');

  const difficulty = values.difficulty as Difficulty | undefined;
  if (difficulty !== undefined && !difficulties.includes(difficulty)) fail('Difficulty must be simple, normal or complex.');
  const timeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
  const options = timeoutMs === undefined ? {} : { timeoutMs };

  const credentials = dependencies.credentials ?? new EnvironmentCredentials(new KeychainStore());
  const gateway = new ModelGateway(await openVault(root), { credentials, providers: dependencies.providers });
  try {
    if (command === 'connect') {
      const provider = providerId(rest[0]!);
      if (values.env) {
        // Session credential from the environment: verify it and cache the model list, store nothing.
        if (!process.env[credentialEnvironment[provider]]) fail(`Set ${credentialEnvironment[provider]} to use --env.`);
        const models = await gateway.refreshModels(provider, options);
        print({ provider, stored: false, models: models.length });
        return;
      }
      const secret = await (dependencies.readSecret ?? secretPrompt)();
      const key = provider === 'cloudflare' ? cloudflareCredential(secret, values['account-id']) : secret;
      const models = await gateway.connect(provider, key, options);
      print({ provider, stored: true, models: models.length });
    } else if (command === 'models') {
      const provider = providerId(rest[0]!);
      if (values.refresh) await gateway.refreshModels(provider, options);
      const { fetchedAt, models } = await gateway.cachedModels(provider);
      print({ provider, fetchedAt, models: models.map(model => ({ id: model.id, name: model.name, capabilities: model.capabilities, limits: model.limits })) });
    } else if (command === 'assign') {
      if (!values.role) fail('--role is required.');
      print(await gateway.assign({ role: values.role, difficulty, needs: { tools: values.tools === true } }));
    } else if (command === 'ask') {
      if (!values.role) fail('--role is required.');
      const maxOutputTokens = values['max-output-tokens'] === undefined ? undefined : Number(values['max-output-tokens']);
      const prompt = await (dependencies.readPrompt ?? chatPrompt)();
      if (!prompt.trim()) fail('A message is required.');
      const result = await gateway.send({ role: values.role, difficulty }, { system: values.system, messages: [userText(prompt)], maxOutputTokens }, options);
      print({
        text: textOf(result.response.content),
        toolCalls: toolCallsOf(result.response.content),
        stopReason: result.response.stopReason,
        provider: result.response.provider,
        model: result.response.model,
        assignment: result.assignment.reason,
        usage: { inputTokens: result.response.usage.inputTokens, outputTokens: result.response.usage.outputTokens, cachedInputTokens: result.response.usage.cachedInputTokens },
        costUSD: result.costUSD,
        warnings: result.warnings,
      });
    } else if (command === 'verify') {
      const provider = providerId(rest[0]!);
      print({ provider, model: rest[1], ...await gateway.verifyTools(provider, rest[1]!, options) });
    } else {
      if (values.month !== undefined && !/^\d{4}-\d{2}$/.test(values.month)) fail('--month must be YYYY-MM.');
      print(gateway.usageSummary(values.month));
    }
  } finally {
    gateway.close();
  }
}
