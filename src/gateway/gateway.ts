// The Model Gateway: assignment, credentials, the provider call and the usage record in one place.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { CredentialStore } from '../credentials.js';
import { NidusError } from '../errors.js';
import { dollars } from '../money.js';
import { calculatedCost, priceFor } from '../pricing.js';
import { FileModelStore, type ModelStore } from '../storage.js';
import type { Model, ProviderId, RequestOptions } from '../types.js';
import { assign, loadTable, refName, type Assignment, type AssignTarget, type Availability, type Difficulty } from './assignment.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, textOf, toolCallsOf, userText, type Message, type ModelRequest, type ModelResponse, type StreamEvent, type ToolSpec } from './contract.js';
import { ProviderClient } from './providers.js';
import { budgetWarning, loadBudget, monthOf, UsageLog, type UsageSummary, type Warning } from './usage.js';
import type { VaultPaths } from './vault.js';

export interface CallTarget {
  role: string;
  difficulty?: Difficulty;
  agentId?: string;
  taskId?: string;
}

/** A request without a model: the gateway chooses it. */
export type GatewayRequest = Omit<ModelRequest, 'model'>;

export interface GatewayResult {
  response: ModelResponse;
  assignment: Assignment;
  costUSD: string | null;
  warnings: Warning[];
}

export interface GatewayDependencies {
  credentials: CredentialStore;
  providers?: ProviderClient;
  models?: ModelStore;
  usage?: UsageLog;
  now?: () => Date;
}

const probeTool: ToolSpec = {
  name: 'add',
  description: 'Adds two integers and returns the sum.',
  inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
};

export class ModelGateway implements Availability {
  private readonly credentials: CredentialStore;
  private readonly providers: ProviderClient;
  private readonly models: ModelStore;
  private readonly usage: UsageLog;
  private readonly now: () => Date;
  private readonly keys = new Map<ProviderId, string | null>();

  constructor(private readonly paths: VaultPaths, dependencies: GatewayDependencies) {
    this.credentials = dependencies.credentials;
    this.providers = dependencies.providers ?? new ProviderClient();
    this.models = dependencies.models ?? new FileModelStore(paths.modelCache);
    this.now = dependencies.now ?? (() => new Date());
    this.usage = dependencies.usage ?? new UsageLog(paths.usageDb, this.now);
  }

  close(): void {
    this.usage.close();
  }

  // --- Availability -------------------------------------------------------

  /** Keys are read once per gateway instance; each Keychain read can prompt the user. */
  private async key(provider: ProviderId): Promise<string | null> {
    if (!this.keys.has(provider)) this.keys.set(provider, await this.credentials.get(provider));
    return this.keys.get(provider) ?? null;
  }

  async hasKey(provider: ProviderId): Promise<boolean> {
    return await this.key(provider) !== null;
  }

  async cachedModel(provider: ProviderId, model: string): Promise<Model | null> {
    return (await this.models.load(provider))?.models.find(candidate => candidate.id === model) ?? null;
  }

  private async verified(): Promise<Record<string, { tools: 'supported'; checkedAt: string }>> {
    try {
      return JSON.parse(await readFile(this.paths.verifiedFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new NidusError('storage', 'Could not read verified model capabilities.');
    }
  }

  async toolsVerified(provider: ProviderId, model: string): Promise<boolean> {
    return (await this.verified())[refName({ provider, model })]?.tools === 'supported';
  }

  // --- Credentials and model discovery -------------------------------------

  /** Verifies the key by listing models, then stores the key and the model list. */
  async connect(provider: ProviderId, key: string, options: RequestOptions = {}): Promise<Model[]> {
    const models = await this.providers.listModels(provider, key, options);
    await this.credentials.set(provider, key);
    this.keys.set(provider, key);
    await this.models.save({ version: 1, provider, fetchedAt: this.now().toISOString(), models });
    return models;
  }

  async refreshModels(provider: ProviderId, options: RequestOptions = {}): Promise<Model[]> {
    const key = await this.key(provider);
    if (!key) throw new NidusError('missing_key', `No API key connected for ${provider}.`);
    const models = await this.providers.listModels(provider, key, options);
    await this.models.save({ version: 1, provider, fetchedAt: this.now().toISOString(), models });
    return models;
  }

  async cachedModels(provider: ProviderId): Promise<{ fetchedAt: string | null; models: Model[] }> {
    const snapshot = await this.models.load(provider);
    return { fetchedAt: snapshot?.fetchedAt ?? null, models: snapshot?.models ?? [] };
  }

  // --- Calls ---------------------------------------------------------------

  async assign(target: AssignTarget): Promise<Assignment> {
    return assign(await loadTable(this.paths.modelsFile), target, this);
  }

  /** Chooses the model for the role and difficulty, calls it and records the usage. */
  async send(target: CallTarget, request: GatewayRequest, options: RequestOptions = {}): Promise<GatewayResult> {
    const assignment = await this.assign({ role: target.role, difficulty: target.difficulty, needs: { tools: Boolean(request.tools?.length) } });
    return this.call(assignment, target, request, options);
  }

  /** Same call as send, delivered as stream events. Wires do not stream yet, so the response arrives whole. */
  async *stream(target: CallTarget, request: GatewayRequest, options: RequestOptions = {}): AsyncGenerator<StreamEvent, GatewayResult> {
    const result = await this.send(target, request, options);
    const text = textOf(result.response.content);
    if (text) yield { type: 'text_delta', text };
    for (const call of toolCallsOf(result.response.content)) yield { type: 'tool_call', call };
    yield { type: 'done', response: result.response };
    return result;
  }

  private async call(assignment: Assignment, target: CallTarget, request: GatewayRequest, options: RequestOptions): Promise<GatewayResult> {
    const { provider, model } = assignment;
    const key = await this.key(provider);
    if (!key) throw new NidusError('missing_key', `No API key connected for ${provider}.`);

    // Stay inside the model's own output limit when it is known.
    const wanted = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const maxOutputTokens = assignment.outputTokenLimit ? Math.min(wanted, assignment.outputTokenLimit) : wanted;
    const full: ModelRequest = { ...request, model, maxOutputTokens };

    const record = { role: target.role, difficulty: target.difficulty ?? null, agentId: target.agentId, taskId: target.taskId,
      provider, model, reason: assignment.reason, candidateIndex: assignment.candidateIndex };
    const started = Date.now();
    let response: ModelResponse;
    try {
      response = await this.providers.send(provider, key, full, options);
    } catch (error) {
      const failure = error instanceof NidusError ? error : null;
      // Failed requests can still report billed tokens.
      this.usage.record({ ...record, status: failure?.code === 'cancelled' ? 'cancelled' : 'failed', errorCode: failure?.code ?? 'provider_error',
        usage: failure?.usage ?? null, costNano: calculatedCost(priceFor(provider, model), failure?.usage), durationMs: Date.now() - started });
      throw error;
    }

    const costNano = calculatedCost(priceFor(provider, model), response.usage);
    this.usage.record({ ...record, status: 'succeeded', stopReason: response.stopReason, usage: response.usage, costNano, durationMs: Date.now() - started });

    const warnings: Warning[] = [];
    if (costNano === null) warnings.push({ code: 'cost_unknown', message: `No reviewed price for ${refName(assignment)}; this call is not counted toward the budget.` });
    const month = monthOf(this.now());
    const over = budgetWarning(await loadBudget(this.paths.budgetFile), this.usage.monthCost(month), month);
    if (over) warnings.push(over);

    return { response, assignment, costUSD: costNano === null ? null : dollars(costNano), warnings };
  }

  /**
   * Runs one real tool round trip against a specific model and remembers a success,
   * so assignment can treat the model's tool support as confirmed.
   */
  async verifyTools(provider: ProviderId, model: string, options: RequestOptions = {}): Promise<{ supported: boolean; detail: string }> {
    const cached = await this.cachedModel(provider, model);
    const assignment: Assignment = { provider, model, role: 'probe', difficulty: null, candidateIndex: 0, reason: 'tool support check', skipped: [], outputTokenLimit: cached?.limits.outputTokens ?? null };
    const target: CallTarget = { role: 'probe' };
    const messages: Message[] = [userText('Call the add tool with a=17 and b=25, then tell me the sum.')];
    const request = { system: 'You have one tool. Use it when asked.', tools: [probeTool], maxOutputTokens: 2048 };

    const first = await this.call(assignment, target, { ...request, messages }, options);
    const calls = toolCallsOf(first.response.content);
    const call = calls[0];
    if (!call || call.name !== 'add') return { supported: false, detail: 'The model did not call the tool.' };
    if (call.inputError) return { supported: false, detail: `The model sent invalid tool input (${call.inputError}).` };

    messages.push({ role: 'assistant', content: first.response.content });
    messages.push({ role: 'user', content: calls.map(item => ({ type: 'tool_result' as const, callId: item.id, content: '42', isError: false })) });
    const second = await this.call(assignment, target, { ...request, messages }, options);
    if (!textOf(second.response.content).includes('42')) return { supported: false, detail: 'The model did not use the tool result in its answer.' };

    const verified = await this.verified();
    verified[refName({ provider, model })] = { tools: 'supported', checkedAt: this.now().toISOString() };
    await mkdir(dirname(this.paths.verifiedFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.verifiedFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(verified, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.paths.verifiedFile);
    return { supported: true, detail: 'Tool call round trip succeeded.' };
  }

  usageSummary(month?: string): UsageSummary {
    return this.usage.summary(month);
  }
}
