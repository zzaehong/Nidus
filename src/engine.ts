import { buildContext, taskContext, softBudgets, type TaskContext } from './routing-context.js';
import { providerMetadata } from './providers.js';
import { cloudflareCredential } from './adapters/cloudflare.js';
import { dollars } from './money.js';
import { randomUUID, createHash } from 'node:crypto';
import { difficulty, modelProfile, rankCandidates, type Candidate, type Difficulty, type Tier } from './router.js';
import { validateAccountPermission, UsageLedger, type TaskKind } from "./ledger.js";
import { deepseekBalance, usageCapabilities, accountReport, adminCredential } from "./provider-usage.js";
import { validateChatRequest } from "./adapters/base.js";
import { adapters } from "./adapters/index.js";
import { classifyModel } from "./classification.js";
import { probeModel } from "./health.js";
import type { CredentialStore } from "./credentials.js";
import { NidusError } from "./errors.js";
import { keyValue } from "./http.js";
import { calculatedCost, priceFor, pricesFor } from "./pricing.js";
import type { ModelSnapshot, ModelStore } from "./storage.js";
import { providerIds, type ChatRequest, type ProviderAdapter, type ProviderId, type RequestOptions } from "./types.js";

export class ConnectivityEngine {
  constructor(private readonly credentials: CredentialStore, private readonly store: ModelStore, private readonly registry: Record<ProviderId, ProviderAdapter> = adapters(), private ledger?: UsageLedger) {}
  private usageLedger() { return this.ledger ??= new UsageLedger(); }
  usage() { return { softBudgets: softBudgets(this.usageLedger().decisionData()), ...this.usageLedger().snapshot(), capabilities: usageCapabilities, routing: this.usageLedger().routes() }; }
  setSoftBudget(provider: ProviderId, usd: unknown) { this.usageLedger().setSoftBudget(provider, usd); return this.usage(); }
  async buildRoutingDecisionContext(task: TaskContext) {
    const normalized = taskContext(task), hashes = new Map<ProviderId, string>();
    const catalogs = await Promise.all(providerIds.map(async provider => {
      let connection: 'credential-present-unverified' | 'disconnected' | 'unknown' = 'unknown';
      try {
        const key = await this.credentials.get(provider);
        hashes.set(provider, key ? createHash('sha256').update(key).digest('hex') : '');
        connection = key ? 'credential-present-unverified' : 'disconnected';
      } catch { /* Missing keychain access is metadata, never a context prerequisite. */ }
      return { provider, snapshot: await this.store.load(provider), connection };
    }));
    const ledger = this.usageLedger();
    return buildContext(normalized, { data: ledger.decisionData(), catalogs,
      permission: (provider, model) => {
        if (!hashes.has(provider)) return { allowed: null, reason: 'credential-unavailable' };
        const p = ledger.executionPermission(provider, model, hashes.get(provider));
        return { allowed: p.allowed, reason: p.reason };
      } });
  }
  setBudget(_scope: unknown, _usd: unknown) { throw new NidusError('unsupported', 'Budget Guard has been removed.'); }
  async accountPermission(provider: ProviderId) {
    const key=await this.credentials.get(provider);
    const hash=key ? createHash('sha256').update(key).digest('hex') : '';
    this.usageLedger().observeCredential(provider,hash);
    return this.usageLedger().accountPermission(provider,hash);
  }
  async setAccountPermission(provider: ProviderId, state: unknown, paidAllowed: unknown, confirmed: unknown, riskAccepted: unknown, accountId: unknown = '', expectedRevision?: unknown) {
    const hash=createHash('sha256').update(await this.key(provider)).digest('hex');
    this.usageLedger().setAccountPermission(provider,state,paidAllowed,confirmed,riskAccepted,hash,accountId,expectedRevision);
    return this.accountPermission(provider);
  }
  async issueConsent(provider: ProviderId, model: unknown, task: unknown, riskAccepted: unknown) {
    if(typeof model!=='string' || !['chat','probe'].includes(String(task)))throw new NidusError('invalid_request','Select model and request task.');
    return this.usageLedger().issueConsent(provider,model,task as TaskKind,createHash('sha256').update(await this.key(provider)).digest('hex'),riskAccepted);
  }
  async syncAccount(provider: ProviderId) {
    if (provider !== 'openai' && provider !== 'anthropic') throw new NidusError('unsupported', 'No connected organization billing API for this provider.');
    const report = await accountReport(provider, adminCredential(provider));
    this.usageLedger().saveAccountReport(report);
    return this.usage();
  }
  async syncBalance(provider: ProviderId) {
    if (provider !== "deepseek") throw new NidusError("unsupported", "Account billing credentials are not connected. Local estimates remain available.");
    const balance = await deepseekBalance(await this.key(provider));
    this.usageLedger().saveBalance(provider, balance.usd, balance.source);
    return this.usage();
  }
  providers() { return providerIds.map(id => ({ id, ...providerMetadata[id], authentication: "api-key", streamingImplemented: false, toolExecutionImplemented: false })); }
  async cachedModels(provider: ProviderId) {
    const saved = await this.store.load(provider);
    return saved ? this.decorate(saved, "cache") : { source: "empty", fetchedAt: null, models: [] };
  }
  private async key(provider: ProviderId): Promise<string> {
    const key=keyValue(await this.credentials.get(provider) ?? '');
    this.usageLedger().observeCredential(provider,createHash('sha256').update(key).digest('hex'));
    return key;
  }
  private snapshot(provider: ProviderId, models: ModelSnapshot["models"]): ModelSnapshot { return { version: 1, provider, fetchedAt: new Date().toISOString(), models }; }
  async connect(provider: ProviderId, inputKey: string, persist = true, options: RequestOptions = {}, accountId?: unknown, billing?: {state: unknown; paidAllowed: unknown; confirmed: unknown; riskAccepted: unknown}) {
    if (provider !== "cloudflare" && accountId !== undefined) throw new NidusError("invalid_request", "Account ID is only supported for Cloudflare.");
    if(billing) validateAccountPermission(billing.state,billing.paidAllowed,billing.confirmed,billing.riskAccepted,'pending-validation',accountId ?? '');
    const key = provider === "cloudflare" ? cloudflareCredential(inputKey,accountId) : keyValue(inputKey);
    const models = await this.registry[provider].listModels(key, options);
    const snapshot = this.snapshot(provider, models);
    const previousKey = persist ? await this.credentials.get(provider) : null;
    if (persist) await this.credentials.set(provider, key);
    try { await this.store.save(snapshot); }
    catch (error) {
      if (persist) {
        try { if (previousKey === null) await this.credentials.delete(provider); else await this.credentials.set(provider, previousKey); }
        catch { throw new NidusError("storage", "Model cache failed and credential rollback failed. Reconnect this provider."); }
      }
      throw error;
    }
    this.usageLedger().invalidateFreeUse(provider);
    this.usageLedger().invalidateAccount(provider);
    if(billing) this.usageLedger().setAccountPermission(provider,billing.state,billing.paidAllowed,billing.confirmed,billing.riskAccepted,createHash('sha256').update(key).digest('hex'),accountId ?? '');
    this.usageLedger().recordHealth(provider, "*", "connected");
    return { provider, accountPermission: await this.accountPermission(provider), authentication: provider === "nvidia" ? "catalog-access-only" : "models-api-verified", chatVerification: "not-run", credentialStorage: persist ? "macos-keychain" : "environment-session", ...this.decorate(snapshot, "api") };
  }
  async models(provider: ProviderId, refresh = false, options: RequestOptions = {}) {
    if (!refresh) { const saved = await this.store.load(provider); if (saved) return this.decorate(saved, "cache"); }
    const models = await this.registry[provider].listModels(await this.key(provider), options);
    const snapshot = this.snapshot(provider, models);
    await this.store.save(snapshot);
    return this.decorate(snapshot, "api");
  }
  private decorate(snapshot: ModelSnapshot, source: string) {
    return { source, fetchedAt: snapshot.fetchedAt, models: snapshot.models.map(m => ({ ...m, classification: classifyModel(m), routingProfile: modelProfile(m.provider, m.id), tierAssignment: this.usageLedger().modelTier(m.provider, m.id), freeUse: this.usageLedger().freeUse(m.provider, m.id), health: { ...this.usageLedger().health(m.provider, m.id), available: this.usageLedger().health(m.provider, m.id).available && this.usageLedger().health(m.provider, '*').available }, pricing: priceFor(snapshot.provider, m.id) })) };
  }
  async detail(provider: ProviderId, model: string, options: RequestOptions = {}) {
    const detail = await this.registry[provider].getModel(await this.key(provider), model, options);
    return { ...detail, classification: classifyModel(detail), tierAssignment: this.usageLedger().modelTier(provider, model), routingProfile: modelProfile(provider, model), pricing: priceFor(provider, model) };
  }
  async pricing(provider: ProviderId) {
    const saved = await this.store.load(provider);
    return { provider, source: "reviewed-static-snapshot", autoRefresh: false, modelSource: saved ? "discovered-cache" : "reviewed-price-records-only", prices: saved ? saved.models.map(m => priceFor(provider, m.id)) : pricesFor(provider) };
  }
  async routingSettings() {
    const models = [];
    for (const provider of providerIds) {
      const cached = await this.cachedModels(provider);
      models.push(...cached.models);
    }
    return { accounts: await Promise.all(providerIds.map(p=>this.accountPermission(p))), ...this.usageLedger().routingSettings(), geminiBilling: this.usageLedger().geminiBilling(), providerPlans: providerIds.map(p=>this.usageLedger().providerPlan(p)), models };
  }
  async approveNvidiaFreeModels(models: unknown, confirmed: unknown, riskAccepted: unknown) {
    const saved=await this.store.load('nvidia');
    if (!Array.isArray(models) || models.some(m=>typeof m!=='string' || !saved?.models.some(item=>item.id===m && classifyModel(item).kind==='text' && item.capabilities.chat!=='unsupported')))
      throw new NidusError('invalid_request','Select discovered NVIDIA text models.');
    const hash=createHash('sha256').update(await this.key('nvidia')).digest('hex');
    this.usageLedger().approveNvidiaFreeModels(models,confirmed,riskAccepted,hash);
    this.usageLedger().setAccountPermission('nvidia','free_only',false,confirmed,riskAccepted,hash);
    return this.routingSettings();
  }
  async setProviderPlan(provider: ProviderId, state: unknown, confirmed: unknown, riskAccepted: unknown) {
    const hash=createHash('sha256').update(await this.key(provider)).digest('hex');
    this.usageLedger().setProviderPlan(provider,state,confirmed,riskAccepted,hash);
    this.usageLedger().setAccountPermission(provider,state==='free'?'free_only':'unknown',false,confirmed,riskAccepted,hash);
    return this.routingSettings();
  }
  async setGeminiBilling(state: unknown, project: unknown, confirmed: unknown, riskAccepted: unknown) {
    const hash = createHash('sha256').update(await this.key('gemini')).digest('hex');
    this.usageLedger().setGeminiBilling(state, project, confirmed, riskAccepted, hash);
    this.usageLedger().setAccountPermission('gemini',state==='free'?'free_only':'unknown',false,confirmed,riskAccepted,hash,project);
    return this.routingSettings();
  }
  async setModelTier(provider: ProviderId, model: unknown, tier: unknown) {
    const saved = await this.store.load(provider);
    if (typeof model !== 'string' || !saved?.models.some(m => m.id === model)) throw new NidusError('invalid_request', 'Select a discovered model.');
    this.usageLedger().setModelTier(provider, model, tier);
    return this.routingSettings();
  }
  async setFreeUse(provider: ProviderId, model: unknown, status: unknown, approved: unknown, accountConfirmed: unknown, chargeRiskAccepted: unknown) {
    const saved = await this.store.load(provider);
    if (typeof model !== 'string' || !saved?.models.some(m => m.id === model)) throw new NidusError('invalid_request', 'Select a discovered model.');
    if (approved === true && chargeRiskAccepted !== true) throw new NidusError('invalid_request', 'Explicitly accept possible paid charges when recording free cost estimates for this model.');
    const hash = createHash('sha256').update(await this.key(provider)).digest('hex');
    this.usageLedger().setFreeUse(provider, model, status, approved, accountConfirmed, hash);
    return this.routingSettings();
  }
  async setRoutingPolicy(task: unknown, tiers: unknown) {
    this.usageLedger().setRoutingPolicy(task, tiers); return this.routingSettings();
  }
  async setAutomaticPaid(allowed: unknown) {
    void allowed; throw new NidusError('unsupported', 'Automatic paid permission gating has been removed.');
  }
  async routePlan(request: ChatRequest, task: unknown = 'normal') {
    const level = difficulty(task);
    validateChatRequest({ ...request, model: 'automatic' });
    const ledger = this.usageLedger(), budget = ledger.snapshot(), settings = ledger.routingSettings();
    const candidates: Candidate[] = [];
    for (const provider of providerIds) {
      const saved = await this.store.load(provider);
      const providerHealth = ledger.health(provider, '*');
      const key=await this.credentials.get(provider);
      const hash=key ? createHash('sha256').update(key).digest('hex') : '';
      ledger.observeCredential(provider,hash);
      for (const model of saved?.models ?? []) {
        const health = ledger.health(provider, model.id);
        const quote = ledger.quote(provider, { ...request, model: model.id },hash);
        candidates.push({ model, tier: ledger.modelTier(provider, model.id).tier, profile: modelProfile(provider, model.id), health: { ...health, available: health.available && providerHealth.available },
          quote,
          pressure: false });
      }
    }
    return { difficulty: level, settings, candidates: rankCandidates(candidates, level, settings.policies[level]), budget: { ...budget.total, level: "disabled", remainingUSD: null },
      excluded: candidates.filter(c => !rankCandidates([c], level, settings.policies[level]).length).map(c => ({ provider: c.model.provider, model: c.model.id, reason: c.quote.reason ?? (!c.health.available ? 'temporarily_unavailable' : 'task_or_grade_incompatible') })) };
  }
  async autoChat(request: ChatRequest, task: unknown = 'normal', options: RequestOptions = {}) {
    if(options.consentToken)throw new NidusError('invalid_request','One-shot consent is only for manual requests.');
    const plan = await this.routePlan(request, task), ledger = this.usageLedger(), routeId = randomUUID();
    for(const c of plan.excluded)ledger.recordRoute(routeId,{provider:c.provider,model:c.model,reason:c.reason,status:'excluded',budget:'disabled',boundUSD:null});
    const excludedProviders = new Set<ProviderId>();
    const transitions: { tier: Tier; provider: ProviderId; model: string; reason: string; status: string; budget: string; boundUSD: string | null; requestId?: string }[] = [];
    let reason = 'initial_selection';
    let freeOnly=false;
    for (const candidate of plan.candidates) {
      const provider = candidate.model.provider, model = candidate.model.id;
      if (excludedProviders.has(provider) || !ledger.health(provider, '*').available || !ledger.health(provider, model).available) continue;
      if (options.signal?.aborted) throw new NidusError('cancelled', 'Automatic request cancelled.');
      const current=await this.accountPermission(provider);
      const quote = ledger.quote(provider, { ...request, model });
      const skipped=current.state==='unknown'?'account_unknown':freeOnly && quote.billingMode!=='free'?'free_only_fallback':quote.reason;
      if(skipped){reason=skipped;ledger.recordRoute(routeId,{provider,model,tier:candidate.tier,reason:skipped,status:'excluded',budget:'disabled',boundUSD:quote.boundUSD});continue;}
      if(quote.billingMode==='free')freeOnly=true;
      const event = { billingMode: quote.billingMode, provider, model, freeUse: ledger.freeUse(provider, model), authorization: quote.billingMode==='free'?'free-only-account':'provider-paid-permission', tier: candidate.tier, reason, status: 'selected', budget: 'disabled', boundUSD: quote.boundUSD };
      transitions.push(event); ledger.recordRoute(routeId, event);
      let result;
      try {
        result = await this.execute(provider, { ...request, model }, 'chat', options, { revision: plan.settings.revision, difficulty: plan.difficulty, tier: candidate.tier, accountRevision: quote.account.revision, billingMode: quote.billingMode });
      } catch (error) {
        const code = error instanceof NidusError ? error.code : 'provider_error';
        const failed = { ...event, status: 'failed', reason: error instanceof NidusError ? error.reason ?? code : code, budget: 'disabled' };
        transitions.push(failed); ledger.recordRoute(routeId, failed);
        // Only explicit rejection categories permit another distinct attempt. Ambiguous delivery stops.
        if (!['execution_permission', 'rate_limit', 'authentication', 'permission', 'missing_key', 'quota', 'not_found', 'unsupported'].includes(code))
          throw new NidusError(code, `Automatic routing stopped (${transitions.filter(t => t.status === 'failed').map(t => t.reason).join(' → ')}). No further request sent; inspect Usage.`, error instanceof NidusError ? error.status : null);
        reason = code;
        if (['authentication', 'permission', 'missing_key', 'quota'].includes(code)) {
          excludedProviders.add(provider); ledger.recordHealth(provider, '*', code, 60);
        } else if (code === 'rate_limit' || code === 'not_found' || code === 'unsupported') {
          const retry = error instanceof NidusError && error.retryAfter && /^\d{1,9}$/.test(error.retryAfter) ? Math.max(1, Number(error.retryAfter)) : 60;
          ledger.recordHealth(provider, model, code, retry);
        }
        continue;
      }
      // Storage errors after successful inference must never trigger fallback.
      const completed = { ...event, status: 'succeeded', requestId: result.requestId };
      transitions.push(completed); ledger.recordRoute(routeId, completed);
      return { ...result, routing: { routeId, difficulty: plan.difficulty, tier: candidate.tier, reason: candidate.reason, boundUSD: quote.boundUSD, estimatedUSD: result.estimatedUSD, budgetLevel: "disabled", transitions } };
    }
    throw new NidusError('unsupported', `No eligible automatic candidate remains (${reason}; ${plan.excluded.map(c => c.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). Select a compatible model or review Tier settings.`);
  }
  async chat(provider: ProviderId, request: ChatRequest, options: RequestOptions = {}) {
    const saved = await this.store.load(provider);
    const known = saved?.models.find(m => m.id === request.model);
    if (known?.capabilities.chat === "unsupported") throw new NidusError("unsupported", "This model does not support the adapter's text generation endpoint.");
    return this.execute(provider, request, "chat", options);
  }
  private async execute(provider: ProviderId, request: ChatRequest, task: TaskKind, options: RequestOptions = {}, automatic?: { revision: number; difficulty: Difficulty; tier: Tier; accountRevision?: number; billingMode?: string }) {
    validateChatRequest(request);
    if (options.signal?.aborted) throw new NidusError("cancelled", "Request cancelled before dispatch.");
    const key = await this.key(provider);
    const ledger = this.usageLedger();
    const reservation = ledger.recordRequest(provider, request, task, automatic, createHash('sha256').update(key).digest('hex'),options.consentToken);
    let headers: Record<string, string> = {};
    let result;
    try {
      result = await this.registry[provider].chat(key, request, { ...options, onHeaders: value => { headers = value; } });
    } catch (error) {
      ledger.settle(reservation, error instanceof NidusError && error.code === "cancelled" ? "cancelled" : "failed", error instanceof NidusError ? error.usage : null, headers);
      ledger.recordHealth(provider, request.model, error instanceof NidusError ? error.code : "provider_error");
      throw error;
    }
    // Keep database failures outside the adapter catch: never retry a settlement or request.
    ledger.settle(reservation, "succeeded", result.usage, headers);
    ledger.recordHealth(provider, request.model, "passed");
    const cost = reservation.billingMode === 'free' ? (result.usage && Number.isSafeInteger(result.usage.inputTokens) && Number.isSafeInteger(result.usage.outputTokens) ? 0n : null) : calculatedCost(reservation.price, result.usage);
    return { ...result, billingMode: reservation.billingMode, estimatedUSD: cost === null ? null : dollars(cost), requestId: reservation.id, budget: { ...ledger.snapshot().total, level: "disabled", remainingUSD: null } };
  }

  async disconnect(provider: ProviderId) { await this.credentials.delete(provider); await this.store.remove(provider); this.usageLedger().invalidateFreeUse(provider); this.usageLedger().invalidateAccount(provider); return { provider, disconnected: true }; }
  async probe(provider: ProviderId, model: string, allowInferred = false, consentToken?: string) {
    const saved = await this.store.load(provider);
    const known = saved?.models.find(m => m.id === model);
    if (!known) throw new NidusError("invalid_request", "Refresh models before testing a discovered model.");
    return probeModel(known, allowInferred, async (request, options) => this.execute(provider, request, "probe", {...options,consentToken}));
  }
}
