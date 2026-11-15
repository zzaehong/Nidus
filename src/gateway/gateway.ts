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
import { gatewayProviderIds } from '../types.js';
import { classifyModel } from '../classification.js';
import type { VaultPaths } from './vault.js';
import { hedgeDelayMs, modelHealth, resting, type ModelHealth } from './health.js';
import { geminiProviders, isSplitGemini, manualLimits, moveProviderData, ProviderSettingsStore, tierOf, type ManualLimits, type SplitGemini } from './gemini.js';
import { GoogleAuth, serviceAccountEmail, storedUser, type AuthSource } from './quota/google-auth.js';
import { parseOAuthClient, signIn, type SignInOptions } from './quota/google-login.js';
import { GoogleCloud, projectName, readCloud, cloudProblem, type CloudReader } from './quota/google.js';
import { blockFrom, emptyQuota, localUsage, nextDayStart, pacificDay, quotaRow, QuotaStore, tierEvidence, type ProviderQuota, type QuotaRow } from './quota/quota.js';

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
  /** Google Cloud sign-in and the management APIs, for reading quotas (not model calls). */
  cloudAuth?: GoogleAuth;
  cloud?: CloudReader;
}

/** What the quota screen of a Gemini provider shows. Limits, this Vault's own count and Google's delayed count stay apart. */
export interface QuotaView {
  provider: SplitGemini;
  tier: 'free' | 'paid';
  connected: boolean;
  project: string | null;
  /** Paid only: whether it may be used as a fallback. */
  allowFallback: boolean;
  rows: QuotaRow[];
  /** Models with a known limit that are not shown because nothing here uses them. */
  otherModels: number;
  /** When Google's numbers were last read, and why a source gave nothing. */
  fetchedAt: string | null;
  errors: ProviderQuota['errors'];
  auth: { source: AuthSource; account: string | null } | null;
  billing: ProviderQuota['billing'];
  tierEvidence: ProviderQuota['tier'];
  /** Free only: why calls are refused (the project looks billed). */
  risk: string | null;
  warnings: string[];
  /** When the daily quota starts over. */
  resetAt: string;
  manual: ManualLimits;
  /** The connection from before the split was moved here and the user has not confirmed it yet. */
  migrated: boolean;
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
  providers: { id: ProviderId; name: string; keyURL: string; needsAccountId: boolean; connected: boolean; models: number; fetchedAt: string | null; /** Gemini only: which tier this connection is for. */ tier: 'free' | 'paid' | null; /** A short warning to show beside the name. */ notice: string | null }[];
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
  private readonly settings: ProviderSettingsStore;
  private readonly quotas: QuotaStore;
  private readonly cloudAuth: GoogleAuth;
  private readonly cloud: CloudReader;
  private prepared: Promise<void> | null = null;

  constructor(private readonly paths: VaultPaths, dependencies: GatewayDependencies) {
    this.credentials = dependencies.credentials;
    this.providers = dependencies.providers ?? new ProviderClient();
    this.models = dependencies.models ?? new FileModelStore(paths.modelCache);
    this.now = dependencies.now ?? (() => new Date());
    this.usage = dependencies.usage ?? new UsageLog(paths.usageDb, this.now);
    this.hedgeDelay = dependencies.hedgeDelayMs === undefined ? hedgeDelayMs : dependencies.hedgeDelayMs;
    this.settings = new ProviderSettingsStore(paths.providerSettings);
    this.quotas = new QuotaStore(paths.quotaFile);
    this.cloudAuth = dependencies.cloudAuth ?? new GoogleAuth({ secret: async () => await this.credentials.cloudKey?.get() ?? null });
    this.cloud = dependencies.cloud ?? new GoogleCloud();
  }

  /**
   * Once per Vault: the Gemini connection from before the split into Free and Paid becomes
   * Gemini Free (candidates, model list, check results, recorded calls). Nothing is lost; the
   * user is shown where it went and can move it to Gemini Paid in one step.
   */
  private prepare(): Promise<void> {
    return this.prepared ??= (async () => {
      const settings = await this.settings.load();
      if (settings.geminiMigration) return;
      const found = await moveProviderData(this.paths, this.models, 'gemini', 'gemini-free');
      if (found) this.usage.renameProvider('gemini', 'gemini-free');
      await this.settings.change(s => { s.geminiMigration ??= { at: this.now().toISOString(), to: 'gemini-free', found, keyChecked: false, acknowledged: !found }; });
    })();
  }

  close(): void {
    this.usage.close();
  }

  // --- Availability -------------------------------------------------------

  /** Keys are read once per gateway instance; each Keychain read can prompt the user. */
  private async key(provider: ProviderId): Promise<string | null> {
    if (!this.keys.has(provider)) {
      let key = await this.credentials.get(provider);
      if (key === null && provider === 'gemini-free') key = await this.legacyGeminiKey();
      this.keys.set(provider, key);
    }
    return this.keys.get(provider) ?? null;
  }

  /** The key from before the split, taken over once. The old entry stays for the earlier app. */
  private async legacyGeminiKey(): Promise<string | null> {
    await this.prepare();
    const migration = (await this.settings.load()).geminiMigration;
    if (!migration || migration.keyChecked || migration.to !== 'gemini-free') return null;
    const key = await this.credentials.get('gemini');
    if (key !== null) await this.credentials.set('gemini-free', key);
    await this.settings.change(s => { if (s.geminiMigration) { s.geminiMigration.keyChecked = true; if (key !== null) { s.geminiMigration.found = true; s.geminiMigration.acknowledged = false; } } });
    return key;
  }

  // --- Gemini Free / Paid ---------------------------------------------------

  /** Why Gemini Free must not be called: there is evidence its project is billed. */
  private async billingRisk(): Promise<string | null> {
    const [quota, settings] = await Promise.all([this.quotas.get('gemini-free'), this.settings.load()]);
    const free = settings.providers['gemini-free']?.project, paid = settings.providers['gemini-paid']?.project;
    if (quota.billing?.enabled && quota.project === free) return 'Gemini Free의 프로젝트에 결제 계정이 연결돼 있습니다. 호출하면 과금될 수 있어 멈췄습니다.';
    if (quota.tier?.evidence === 'paid') return `Google이 유료 등급 할당량(${quota.tier.quotaId})으로 답했습니다. Gemini Free의 키가 과금되는 프로젝트의 것으로 보여 멈췄습니다.`;
    if (free && paid && free === paid) return 'Gemini Free와 Gemini Paid가 같은 프로젝트를 쓰고 있습니다. 결제가 연결된 프로젝트의 호출은 무료가 아니어서 멈췄습니다.';
    return null;
  }

  /** Rules of the Gemini providers that are not about a model: no paid fallback unasked, no free calls on a billed project. */
  async refused(ref: { provider: ProviderId; model: string }, index: number): Promise<string | null> {
    if (ref.provider === 'gemini-paid' && index > 0 && !(await this.settings.load()).providers['gemini-paid']?.allowFallback) {
      return 'paid provider is not used as an automatic fallback (allow it in the Gemini Paid settings)';
    }
    if (ref.provider === 'gemini-free' && await this.billingRisk()) return 'the project of Gemini Free looks billed: calls are stopped';
    return null;
  }

  /** Models to pass over for now because of their rate limits: blocked by a 429, or at a known limit by this Vault's own count. */
  private async rateLimited(): Promise<string[]> {
    const now = this.now(), out: string[] = [];
    const settings = await this.settings.load(), all = await this.quotas.load();
    for (const provider of geminiProviders) {
      const quota = all[provider];
      const manual = settings.providers[provider]?.limits ?? {};
      if (!quota && !Object.keys(manual).length) continue;
      const local = localUsage(this.usage.callsSince(provider, pacificDay.dayStart(now)), now, pacificDay);
      for (const model of new Set([...local.keys(), ...Object.keys(quota?.blocks ?? {})])) {
        if (quotaRow(model, quota ?? emptyQuota(), local.get(model), manual, now).status === 'limited') out.push(`${provider}:${model}`);
      }
    }
    return out;
  }

  /** A refused call: the model is left alone until the window the server named has passed, and what the refusal shows about the tier is kept. */
  private async noteRefusal(provider: SplitGemini, model: string, error: NidusError): Promise<void> {
    const now = this.now();
    await this.quotas.update(provider, quota => {
      const block = blockFrom(error.quota, error.retryAfter, now, pacificDay);
      quota.blocks[model] = block;
      // The server's own number is a limit worth knowing where nothing else gave one.
      const value = error.quota?.violations.find(v => v.value !== null)?.value;
      if (block.kind !== 'unknown' && value != null && value > 0 && quota.limits[model]?.[block.kind]?.source !== 'cloud') (quota.limits[model] ??= {})[block.kind] = { value, source: 'server' };
      const evidence = tierEvidence(error.quota);
      if (evidence) quota.tier = { ...evidence, at: now.toISOString() };
      for (const [name, old] of Object.entries(quota.blocks)) if (Date.parse(old.until) <= now.getTime()) delete quota.blocks[name];
    }).catch(() => {});
  }

  async quotaView(provider: SplitGemini, all = false): Promise<QuotaView> {
    await this.prepare();
    const now = this.now();
    const [quota, settings, table] = await Promise.all([this.quotas.get(provider), this.settings.load(), loadTable(this.paths.modelsFile)]);
    const own = settings.providers[provider] ?? {};
    const manual = own.limits ?? {};
    const local = localUsage(this.usage.callsSince(provider, pacificDay.dayStart(now)), now, pacificDay);
    const candidates = [...Object.values(table.roles), ...Object.values(table.worker)].flat().filter(ref => ref.provider === provider).map(ref => ref.model);
    const active = new Set([...candidates, ...local.keys(), ...Object.keys(quota.blocks).filter(m => Date.parse(quota.blocks[m]!.until) > now.getTime()), ...Object.keys(manual).filter(m => m !== '*')]);
    const known = Object.keys(quota.limits).filter(m => m !== '*');
    const models = [...new Set([...active, ...(all ? known : [])])].sort();
    const warnings: string[] = [];
    const other = settings.providers[provider === 'gemini-free' ? 'gemini-paid' : 'gemini-free']?.project;
    if (own.project && other === own.project) warnings.push('Gemini Free와 Gemini Paid가 같은 프로젝트를 가리킵니다. 할당량은 프로젝트 단위라 둘의 사용량이 합쳐지고, 결제가 연결된 프로젝트에는 무료 할당량이 없습니다.');
    if (quota.project && own.project && quota.project !== own.project) warnings.push(`표시된 Google 값은 이전 프로젝트(${quota.project})의 것입니다. 새로고침하세요.`);
    if (provider === 'gemini-paid' && quota.tier?.evidence === 'free') warnings.push(`Google이 무료 등급 할당량(${quota.tier.quotaId})으로 답했습니다. 이 키의 프로젝트는 무료 등급으로 보입니다.`);
    if (provider === 'gemini-paid' && quota.billing && !quota.billing.enabled) warnings.push('이 프로젝트에는 결제 계정이 연결돼 있지 않습니다. 유료 등급이 아닙니다.');
    const migration = settings.geminiMigration;
    return {
      provider, tier: tierOf(provider), connected: await this.hasKey(provider), project: own.project ?? null, allowFallback: own.allowFallback === true,
      rows: models.map(model => quotaRow(model, quota, local.get(model), manual, now)), otherModels: known.filter(m => !models.includes(m)).length,
      fetchedAt: quota.fetchedAt, errors: quota.errors, auth: await this.cloudAuth.available().catch(() => null), billing: quota.billing, tierEvidence: quota.tier,
      risk: provider === 'gemini-free' ? await this.billingRisk() : null, warnings, resetAt: nextDayStart(pacificDay, now).toISOString(), manual,
      migrated: !!migration && migration.to === provider && migration.found && !migration.acknowledged,
    };
  }

  /** Reads the project's limits, Google's own usage count and its billing state. Not a model call. */
  async refreshQuota(provider: SplitGemini): Promise<QuotaView> {
    await this.prepare();
    const project = (await this.settings.load()).providers[provider]?.project;
    if (!project) throw new NidusError('invalid_request', '먼저 이 Provider의 Google Cloud 프로젝트 ID를 입력하세요.');
    const now = this.now();
    try {
      const token = await this.cloudAuth.token();
      await this.quotas.update(provider, async quota => { await readCloud(quota, project, tierOf(provider), token, this.cloud, now, pacificDay); });
    } catch (error) {
      // No sign-in: what was read before is no longer shown as current, and calls go on as before.
      await this.quotas.update(provider, quota => { quota.errors = { auth: cloudProblem(error, 'Google Cloud', '') }; quota.observed = {}; quota.fetchedAt = now.toISOString(); quota.project = project; });
    }
    return this.quotaView(provider);
  }

  async setProviderSettings(provider: SplitGemini, change: { project?: unknown; allowFallback?: unknown; limits?: unknown }): Promise<QuotaView> {
    await this.prepare();
    const project = change.project === undefined ? undefined : change.project === null || change.project === '' ? null : projectName(change.project);
    const limits = change.limits === undefined ? undefined : manualLimits(change.limits);
    await this.settings.change(settings => {
      const own = settings.providers[provider] ??= {};
      if (project !== undefined) { if (project === null) delete own.project; else own.project = project; }
      if (limits !== undefined) own.limits = limits;
      // Only the paid provider has this switch, and only an explicit true turns it on.
      if (change.allowFallback !== undefined && provider === 'gemini-paid') own.allowFallback = change.allowFallback === true;
    });
    return this.quotaView(provider);
  }

  /** Stores the service account key used to read quotas, after checking that Google accepts it. */
  async setCloudKey(json: string): Promise<{ account: string }> {
    const slot = this.credentials.cloudKey;
    if (!slot) throw new NidusError('unsupported', 'This credential store cannot keep a Google Cloud key.');
    const account = serviceAccountEmail(json);
    await new GoogleAuth({ secret: async () => json }).token();
    await slot.set(json);
    this.cloudAuth.reset();
    return { account };
  }

  /**
   * Signs in with a Google account in the browser and stores the refresh token in the Keychain.
   * The OAuth client comes from the file the user chose; without one, the client of an earlier
   * sign-in is reused (signing in again after the token expired). Nothing but the account's address comes back.
   */
  async signInCloud(clientJson: string | null, options: SignInOptions = {}): Promise<{ account: string | null }> {
    const slot = this.credentials.cloudKey;
    if (!slot) throw new NidusError('unsupported', 'This credential store cannot keep a Google Cloud sign-in.');
    let client = clientJson ? parseOAuthClient(clientJson) : null;
    if (!client) {
      const previous = storedUser(await slot.get() ?? '');
      if (!previous) throw new NidusError('invalid_request', 'Choose the OAuth client file first.');
      client = { clientId: previous.client_id, clientSecret: previous.client_secret };
    }
    const user = await signIn(client, options);
    await slot.set(JSON.stringify(user));
    this.cloudAuth.reset();
    return { account: user.account ?? null };
  }

  async clearCloudKey(): Promise<void> {
    await this.credentials.cloudKey?.delete();
    this.cloudAuth.reset();
  }

  /** Moves a Gemini connection to the other tier: key, model list, candidates, check results and settings. */
  async moveGemini(from: SplitGemini, to: SplitGemini): Promise<void> {
    await this.prepare();
    if (from === to) throw new NidusError('invalid_request', 'Choose the other Gemini provider.');
    const key = await this.key(from);
    if (key === null) throw new NidusError('missing_key', `No API key connected for ${from}.`);
    if (await this.key(to) !== null) throw new NidusError('invalid_request', `${providerMetadata[to].name}에 이미 다른 키가 연결돼 있습니다. 먼저 그 연결을 해제하세요.`);
    await this.credentials.set(to, key);
    await this.credentials.delete(from);
    this.keys.set(to, key); this.keys.set(from, null);
    await moveProviderData(this.paths, this.models, from, to);
    await this.settings.change(settings => {
      const moved = settings.providers[from];
      if (moved) { settings.providers[to] = { ...moved, allowFallback: false }; delete settings.providers[from]; }
      if (settings.geminiMigration) Object.assign(settings.geminiMigration, { to, acknowledged: true, keyChecked: true });
    });
    const quota = await this.quotas.get(from);
    await this.quotas.update(to, target => { Object.assign(target, quota, { billing: null, tier: quota.tier }); });
    await this.quotas.update(from, target => { Object.assign(target, emptyQuota()); });
  }

  /** The user has seen where the earlier Gemini connection went. */
  async acknowledgeGeminiMigration(): Promise<void> {
    await this.settings.change(settings => { if (settings.geminiMigration) settings.geminiMigration.acknowledged = true; });
  }

  async hasKey(provider: ProviderId): Promise<boolean> {
    await this.prepare();
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
    await this.prepare();
    if (provider === 'gemini') throw new NidusError('invalid_request', 'Connect the key to Gemini Free or Gemini Paid.');
    const models = await this.providers.listModels(provider, key, options);
    await this.credentials.set(provider, key);
    this.keys.set(provider, key);
    await this.models.save({ version: 1, provider, fetchedAt: this.now().toISOString(), models });
    return models;
  }

  async refreshModels(provider: ProviderId, options: RequestOptions = {}): Promise<Model[]> {
    await this.prepare();
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
    await this.prepare();
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
    await this.prepare();
    const health = this.health();
    const avoid = [...new Set([...(target.avoid ?? []), ...resting(health, this.now()), ...await this.rateLimited()])];
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
    // The free provider never makes a call that may be charged, however the call was reached.
    if (provider === 'gemini-free') {
      const risk = await this.billingRisk();
      if (risk) throw new NidusError('billing_risk', risk);
    }
    // The paid provider's prices are Gemini's; the free one's calls cost nothing.
    const cost = (usage: ModelResponse['usage'] | null | undefined) => provider === 'gemini-free' ? (usage ? 0n : null) : calculatedCost(priceFor(provider === 'gemini-paid' ? 'gemini' : provider, model), usage);

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
        usage: failure?.usage ?? null, costNano: cost(failure?.usage), durationMs: Date.now() - started });
      if (failure && isSplitGemini(provider) && (failure.code === 'rate_limit' || failure.code === 'quota')) await this.noteRefusal(provider, model, failure);
      throw error;
    }

    const costNano = cost(response.usage);
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
    await this.prepare();
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
    await this.prepare();
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

    const settings = await this.settings.load();
    const risk = await this.billingRisk();
    // The connection from before the split is not offered any more: it became Gemini Free.
    const providers = await Promise.all(gatewayProviderIds.map(async id => {
      const snapshot = await this.models.load(id);
      const migrated = settings.geminiMigration && settings.geminiMigration.to === id && settings.geminiMigration.found && !settings.geminiMigration.acknowledged;
      return { id, name: providerMetadata[id].name, keyURL: providerMetadata[id].keyURL, needsAccountId: providerMetadata[id].accountId,
        connected: await this.hasKey(id), models: snapshot?.models.length ?? 0, fetchedAt: snapshot?.fetchedAt ?? null,
        tier: isSplitGemini(id) ? tierOf(id) : null,
        notice: id === 'gemini-free' && risk ? '과금 위험: 호출 멈춤' : migrated ? '이전 Gemini 연결을 옮김' : null };
    }));

    const usage = this.usage.summary();
    const budget = await loadBudget(this.paths.budgetFile);
    return { vault: this.paths.root, slots, providers, usage, budgetUSD: budget === null ? null : dollars(budget),
      budgetWarning: budgetWarning(budget, this.usage.monthCost(usage.month), usage.month)?.message ?? null,
      health: Object.fromEntries([...health].map(([ref, h]) => [ref, { streak: h.streak, lastError: h.lastError, restUntil: h.restUntil && h.restUntil > now ? h.restUntil.toISOString() : null, medianMs: h.medianMs }])) };
  }

  /** Text models of a provider with their tool support, for choosing candidates. */
  async modelChoices(provider: ProviderId): Promise<ModelChoice[]> {
    await this.prepare();
    const checks = await this.checks();
    const { models } = await this.cachedModels(provider);
    return models.filter(model => classifyModel(model).kind === 'text' && model.capabilities.chat !== 'unsupported').map(model => {
      const check = checks[refName({ provider, model: model.id })];
      return { id: model.id, name: model.name, text: check?.text ?? 'untested', tools: check?.tools ?? 'untested', detail: check?.detail ?? null, checkedAt: check?.checkedAt ?? null };
    });
  }

  /** Replaces the ordered candidates of one slot ("roles.<role>" or "worker.<difficulty>"). */
  async setCandidates(slot: string, candidates: unknown): Promise<void> {
    await this.prepare();
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
