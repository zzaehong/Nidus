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
import { assign, difficulties, loadTable, parseRef, refName, saveTable, type Assignment, type AssignTarget, type Availability, type Difficulty } from './assignment.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, textOf, toolCallsOf, userText, type Message, type ModelRequest, type ModelResponse, type StreamEvent, type ToolSpec } from './contract.js';
import { ProviderClient } from './providers.js';
import { budgetWarning, loadBudget, monthOf, saveBudget, UsageLog, type UsageSummary, type Warning } from './usage.js';
import { providerMetadata } from '../providers.js';
import { providerIds } from '../types.js';
import { classifyModel } from '../classification.js';
import type { VaultPaths } from './vault.js';
import { hedgeDelayMs, modelHealth, resting, type ModelHealth } from './health.js';

export interface CallTarget {
  role: string;
  difficulty?: Difficulty;
  /** Candidates to pass over if another one is available ("provider:model"). */
  avoid?: string[];
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
  /**
   * When a call has not answered after this long, the next candidate is asked too and the first
   * answer wins (default: from the model's usual time, 20-60 s). null turns this off.
   */
  hedgeDelayMs?: ((medianMs: number | null) => number) | null;
}

export interface SlotView {
  id: string;
  role: string;
  difficulty: Difficulty | null;
  candidates: string[];
  resolved: string | null;
  reason: string | null;
  problem: string | null;
}

export interface VaultOverview {
  vault: string;
  slots: SlotView[];
  providers: { id: ProviderId; name: string; keyURL: string; needsAccountId: boolean; connected: boolean; models: number; fetchedAt: string | null }[];
  usage: UsageSummary;
  budgetUSD: string | null;
  budgetWarning: string | null;
  /** How each model has done lately ("provider:model"): resting models are passed over. */
  health: Record<string, { streak: number; lastError: string | null; restUntil: string | null; medianMs: number | null }>;
}

export type CheckOutcome = 'passed' | 'failed' | 'inconclusive';

export interface ModelCheck {
  text: CheckOutcome;
  tools: CheckOutcome;
  detail: string;
}

interface StoredCheck {
  text?: 'passed' | 'failed';
  tools?: 'passed' | 'failed';
  detail: string;
  checkedAt: string;
}

/** Errors that say the model itself cannot do this, as opposed to a passing condition of the service. */
const definiteFailures = ['not_found', 'invalid_request', 'permission', 'unsupported'];

export interface ModelChoice {
  id: string;
  name: string;
  /** Result of the last real check: plain text replies, and a tool call round trip. */
  text: 'passed' | 'failed' | 'untested';
  tools: 'passed' | 'failed' | 'untested';
  detail: string | null;
  checkedAt: string | null;
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
  private readonly hedgeDelay: ((medianMs: number | null) => number) | null;
  private readonly keys = new Map<ProviderId, string | null>();

  constructor(private readonly paths: VaultPaths, dependencies: GatewayDependencies) {
    this.credentials = dependencies.credentials;
    this.providers = dependencies.providers ?? new ProviderClient();
    this.models = dependencies.models ?? new FileModelStore(paths.modelCache);
    this.now = dependencies.now ?? (() => new Date());
    this.usage = dependencies.usage ?? new UsageLog(paths.usageDb, this.now);
    this.hedgeDelay = dependencies.hedgeDelayMs === undefined ? hedgeDelayMs : dependencies.hedgeDelayMs;
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

  private async checks(): Promise<Record<string, StoredCheck>> {
    try {
      return JSON.parse(await readFile(this.paths.checksFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new NidusError('storage', 'Could not read model check results.');
    }
  }

  async toolsVerified(provider: ProviderId, model: string): Promise<boolean> {
    return (await this.checks())[refName({ provider, model })]?.tools === 'passed';
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
  /** How each model has done over the last day (failures in a row, rest, usual time). */
  health(): Map<string, ModelHealth> {
    return modelHealth(this.usage.recentCalls(new Date(this.now().getTime() - 24 * 3600_000)));
  }

  /**
   * Chooses the model for the role and difficulty, calls it and records the usage.
   * Models that keep failing rest for a while and are passed over while the slot has another
   * candidate. A call that takes much longer than usual is sent to the next candidate as well;
   * the first answer is used and the slower call is stopped and noted, so it moves back.
   */
  async send(target: CallTarget, request: GatewayRequest, options: RequestOptions = {}): Promise<GatewayResult> {
    const health = this.health();
    const avoid = [...new Set([...(target.avoid ?? []), ...resting(health, this.now())])];
    const needs = { tools: Boolean(request.tools?.length) };
    const first = await this.assign({ role: target.role, difficulty: target.difficulty, needs, avoid });
    const firstRef = refName(first);
    const tagged = (error: unknown, ref: string) => {
      // Callers that switch models on failures need to know which one failed.
      if (error && typeof error === 'object') (error as { modelRef?: string }).modelRef = ref;
      return error;
    };
    const attempt = (assignment: Assignment) => {
      const stop = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
      const lost: { value: 'slow' | 'unused' | null } = { value: null };
      const promise = this.call(assignment, target, request, { ...options, signal }, lost);
      return { promise, ref: refName(assignment), cancel: (why: 'slow' | 'unused') => { lost.value = why; stop.abort(); } };
    };
    const a = attempt(first);
    if (!this.hedgeDelay) return a.promise.catch(error => { throw tagged(error, a.ref); });
    const delay = this.hedgeDelay(health.get(firstRef)?.medianMs ?? null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), delay); });
    const settled = a.promise.then(() => 'done' as const, () => 'done' as const);
    if (await Promise.race([settled, late]) === 'done' || options.signal?.aborted) {
      clearTimeout(timer);
      return a.promise.catch(error => { throw tagged(error, a.ref); });
    }
    let second: Assignment | null = null;
    try { second = await assign(await loadTable(this.paths.modelsFile), { role: target.role, difficulty: target.difficulty, needs, avoid: [...avoid, firstRef] }, this); } catch {}
    if (!second || refName(second) === firstRef) return a.promise.catch(error => { throw tagged(error, a.ref); });
    const b = attempt(second);
    const both = [a, b];
    return new Promise<GatewayResult>((resolve, reject) => {
      let failures = 0, firstError: unknown;
      for (const run of both) {
        run.promise.then(result => {
          // The late first model is noted as slow; a backup that was not needed is not held against it.
          for (const other of both) if (other !== run) other.cancel(other === a ? 'slow' : 'unused');
          const note = `${a.ref}이(가) ${Math.round(delay / 1000)}초 안에 답하지 않아 ${b.ref}에게도 보냈고, ${run.ref}의 답을 썼습니다.`;
          resolve({ ...result, warnings: [...result.warnings, { code: 'hedged', message: note }] });
        }, error => {
          if (run === a) firstError = error;
          if (++failures === both.length) reject(tagged(firstError ?? error, a.ref));
        });
      }
    });
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

  private async call(assignment: Assignment, target: CallTarget, request: GatewayRequest, options: RequestOptions, lost: { value: 'slow' | 'unused' | null } = { value: null }): Promise<GatewayResult> {
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
      // Stopped because another candidate answered first: noted as slow, which counts against it.
      const errorCode = lost.value ?? failure?.code ?? 'provider_error';
      this.usage.record({ ...record, status: failure?.code === 'cancelled' || lost.value ? 'cancelled' : 'failed', errorCode,
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
   * Checks a specific model with real calls: a tool round trip, and a plain text
   * reply when the tool exchange does not prove text output. Definite results are
   * remembered; rate limits, timeouts and server errors are reported as
   * inconclusive and leave any earlier result in place.
   */
  async checkModel(provider: ProviderId, model: string, options: RequestOptions = {}): Promise<ModelCheck> {
    const cached = await this.cachedModel(provider, model);
    const assignment: Assignment = { provider, model, role: 'probe', difficulty: null, candidateIndex: 0, reason: 'model check', skipped: [], outputTokenLimit: cached?.limits.outputTokens ?? null };
    const target: CallTarget = { role: 'probe' };
    const check: ModelCheck = { text: 'inconclusive', tools: 'inconclusive', detail: '' };
    let tryText = true;

    try {
      const messages: Message[] = [userText('Call the add tool with a=17 and b=25, then tell me the sum.')];
      const request = { system: 'You have one tool. Use it when asked.', tools: [probeTool], maxOutputTokens: 2048 };
      const first = await this.call(assignment, target, { ...request, messages }, options);
      const calls = toolCallsOf(first.response.content);
      const call = calls[0];
      if (!call || call.name !== 'add' || call.inputError) {
        check.tools = 'failed';
        check.detail = !call || call.name !== 'add' ? 'The model did not call the tool.' : `The model sent invalid tool input (${call.inputError}).`;
        // Any text it produced still shows that plain text output works.
        if (textOf(first.response.content).trim()) { check.text = 'passed'; tryText = false; }
      } else {
        messages.push({ role: 'assistant', content: first.response.content });
        messages.push({ role: 'user', content: calls.map(item => ({ type: 'tool_result' as const, callId: item.id, content: '42', isError: false })) });
        const second = await this.call(assignment, target, { ...request, messages }, options);
        if (textOf(second.response.content).includes('42')) {
          check.tools = 'passed';
          check.text = 'passed';
          check.detail = 'Tool call round trip succeeded.';
          tryText = false;
        } else {
          check.tools = 'failed';
          check.detail = 'The model did not use the tool result in its answer.';
        }
      }
    } catch (error) {
      const code = error instanceof NidusError ? error.code : 'provider_error';
      check.detail = `Tool call failed (${code}).`;
      if (code === 'not_found') {
        // The model cannot be called at all with this key.
        check.tools = 'failed';
        check.text = 'failed';
        tryText = false;
      } else if (definiteFailures.includes(code)) {
        check.tools = 'failed';
      } else if (code === 'rate_limit' || code === 'timeout' || code === 'cancelled') {
        tryText = false;
      }
    }

    if (tryText) {
      try {
        const reply = await this.call(assignment, target, { messages: [userText('Reply with the single word OK.')], maxOutputTokens: 1024 }, options);
        check.text = textOf(reply.response.content).trim() ? 'passed' : 'failed';
        if (check.text === 'failed') check.detail += ` Text reply was empty (${reply.response.stopReason}).`;
      } catch (error) {
        const code = error instanceof NidusError ? error.code : 'provider_error';
        if (definiteFailures.includes(code)) check.text = 'failed';
        check.detail += ` Text call failed (${code}).`;
      }
    }

    if (check.text !== 'inconclusive' || check.tools !== 'inconclusive') {
      const all = await this.checks();
      const key = refName({ provider, model });
      all[key] = {
        ...all[key],
        ...(check.text !== 'inconclusive' ? { text: check.text } : {}),
        ...(check.tools !== 'inconclusive' ? { tools: check.tools } : {}),
        detail: check.detail.trim(),
        checkedAt: this.now().toISOString(),
      };
      await mkdir(dirname(this.paths.checksFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.paths.checksFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.paths.checksFile);
    }
    check.detail = check.detail.trim();
    return check;
  }

  async disconnect(provider: ProviderId): Promise<void> {
    await this.credentials.delete(provider);
    this.keys.set(provider, null);
    await this.models.remove(provider);
  }

  // --- Views for the app -----------------------------------------------------

  /** Everything the vault overview shows: each slot with the model it resolves to, providers, usage and budget. */
  async overview(): Promise<VaultOverview> {
    const table = await loadTable(this.paths.modelsFile);
    const targets: { id: string; target: AssignTarget; candidates: string[] }[] = [
      ...Object.entries(table.roles).map(([role, list]) => ({ id: `roles.${role}`, target: { role }, candidates: list.map(refName) })),
      ...difficulties.map(difficulty => ({ id: `worker.${difficulty}`, target: { role: 'worker', difficulty }, candidates: table.worker[difficulty].map(refName) })),
    ];
    const health = this.health();
    const now = this.now();
    const avoid = resting(health, now);
    const slots: SlotView[] = [];
    for (const { id, target, candidates } of targets) {
      const view: SlotView = { id, role: target.role, difficulty: target.difficulty ?? null, candidates, resolved: null, reason: null, problem: null };
      try {
        // Workers do the tool work; main and managers plan and review in text.
        const chosen = await assign(table, { ...target, needs: { tools: target.role === 'worker' }, avoid }, this);
        view.resolved = refName(chosen);
        view.reason = chosen.reason;
      } catch (error) {
        view.problem = error instanceof NidusError ? error.message : 'Could not resolve this slot.';
      }
      slots.push(view);
    }

    const providers = await Promise.all(providerIds.map(async id => {
      const snapshot = await this.models.load(id);
      return { id, name: providerMetadata[id].name, keyURL: providerMetadata[id].keyURL, needsAccountId: providerMetadata[id].accountId,
        connected: await this.hasKey(id), models: snapshot?.models.length ?? 0, fetchedAt: snapshot?.fetchedAt ?? null };
    }));

    const usage = this.usage.summary();
    const budget = await loadBudget(this.paths.budgetFile);
    return { vault: this.paths.root, slots, providers, usage, budgetUSD: budget === null ? null : dollars(budget),
      budgetWarning: budgetWarning(budget, this.usage.monthCost(usage.month), usage.month)?.message ?? null,
      health: Object.fromEntries([...health].map(([ref, h]) => [ref, { streak: h.streak, lastError: h.lastError, restUntil: h.restUntil && h.restUntil > now ? h.restUntil.toISOString() : null, medianMs: h.medianMs }])) };
  }

  /** Text models of a provider with their tool support, for choosing candidates. */
  async modelChoices(provider: ProviderId): Promise<ModelChoice[]> {
    const checks = await this.checks();
    const { models } = await this.cachedModels(provider);
    return models.filter(model => classifyModel(model).kind === 'text' && model.capabilities.chat !== 'unsupported').map(model => {
      const check = checks[refName({ provider, model: model.id })];
      return { id: model.id, name: model.name, text: check?.text ?? 'untested', tools: check?.tools ?? 'untested', detail: check?.detail ?? null, checkedAt: check?.checkedAt ?? null };
    });
  }

  /** Replaces the ordered candidates of one slot ("roles.<role>" or "worker.<difficulty>"). */
  async setCandidates(slot: string, candidates: unknown): Promise<void> {
    if (!Array.isArray(candidates)) throw new NidusError('invalid_request', 'Candidates must be an array.');
    const refs = candidates.map(parseRef);
    if (new Set(refs.map(refName)).size !== refs.length) throw new NidusError('invalid_request', 'A model can appear only once in a slot.');
    const table = await loadTable(this.paths.modelsFile);
    const [group, name] = [slot.slice(0, slot.indexOf('.')), slot.slice(slot.indexOf('.') + 1)];
    if (group === 'worker' && difficulties.includes(name as Difficulty)) table.worker[name as Difficulty] = refs;
    else if (group === 'roles' && table.roles[name]) table.roles[name] = refs;
    else throw new NidusError('invalid_request', 'Unknown slot.');
    await saveTable(this.paths.modelsFile, table);
  }

  setBudget(monthlyUSD: string | null): Promise<void> {
    return saveBudget(this.paths.budgetFile, monthlyUSD);
  }

  usageSummary(month?: string): UsageSummary {
    return this.usage.summary(month);
  }
}
