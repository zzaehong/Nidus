import { dollars } from './money.js';
import { randomUUID } from 'node:crypto';
import { difficulty, modelProfile, rankCandidates, type Candidate } from './router.js';
import { UsageLedger, type TaskKind } from "./ledger.js";
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
  usage() { return { ...this.usageLedger().snapshot(), capabilities: usageCapabilities, routing: this.usageLedger().routes() }; }
  setBudget(scope: unknown, usd: unknown) { this.usageLedger().setBudget(scope, usd); return this.usage(); }
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
  providers() { return providerIds.map(id => ({ id, authentication: "api-key", streamingImplemented: false, toolExecutionImplemented: false })); }
  async cachedModels(provider: ProviderId) {
    const saved = await this.store.load(provider);
    return saved ? this.decorate(saved, "cache") : { source: "empty", fetchedAt: null, models: [] };
  }
  private async key(provider: ProviderId): Promise<string> { return keyValue(await this.credentials.get(provider) ?? ""); }
  private snapshot(provider: ProviderId, models: ModelSnapshot["models"]): ModelSnapshot { return { version: 1, provider, fetchedAt: new Date().toISOString(), models }; }
  async connect(provider: ProviderId, inputKey: string, persist = true, options: RequestOptions = {}) {
    const key = keyValue(inputKey);
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
    this.usageLedger().recordHealth(provider, "*", "connected");
    return { provider, authentication: "models-api-verified", chatVerification: "not-run", credentialStorage: persist ? "macos-keychain" : "environment-session", ...this.decorate(snapshot, "api") };
  }
  async models(provider: ProviderId, refresh = false, options: RequestOptions = {}) {
    if (!refresh) { const saved = await this.store.load(provider); if (saved) return this.decorate(saved, "cache"); }
    const models = await this.registry[provider].listModels(await this.key(provider), options);
    const snapshot = this.snapshot(provider, models);
    await this.store.save(snapshot);
    return this.decorate(snapshot, "api");
  }
  private decorate(snapshot: ModelSnapshot, source: string) {
    return { source, fetchedAt: snapshot.fetchedAt, models: snapshot.models.map(m => ({ ...m, classification: classifyModel(m), routingProfile: modelProfile(m.provider, m.id), health: this.usageLedger().health(m.provider, m.id), pricing: priceFor(snapshot.provider, m.id) })) };
  }
  async detail(provider: ProviderId, model: string, options: RequestOptions = {}) {
    const detail = await this.registry[provider].getModel(await this.key(provider), model, options);
    return { ...detail, classification: classifyModel(detail), pricing: priceFor(provider, model) };
  }
  async pricing(provider: ProviderId) {
    const saved = await this.store.load(provider);
    return { provider, source: "reviewed-static-snapshot", autoRefresh: false, modelSource: saved ? "discovered-cache" : "reviewed-price-records-only", prices: saved ? saved.models.map(m => priceFor(provider, m.id)) : pricesFor(provider) };
  }
  async routePlan(request: ChatRequest, task: unknown = 'normal') {
    const level = difficulty(task);
    validateChatRequest({ ...request, model: 'automatic' });
    const ledger = this.usageLedger(), budget = ledger.snapshot();
    const candidates: Candidate[] = [];
    for (const provider of providerIds) {
      const saved = await this.store.load(provider);
      const providerHealth = ledger.health(provider, '*');
      for (const model of saved?.models ?? []) {
        const health = ledger.health(provider, model.id);
        candidates.push({ model, profile: modelProfile(provider, model.id), health: { ...health, available: health.available && providerHealth.available },
          quote: ledger.quote(provider, { ...request, model: model.id }),
          pressure: [budget.total, budget.providers.find(p => p.scope === provider)!].some(p => ['warning', 'saving', 'blocked'].includes(p.level)) });
      }
    }
    return { difficulty: level, candidates: rankCandidates(candidates, level), budget: budget.total,
      excluded: candidates.filter(c => !rankCandidates([c], level).length).map(c => ({ provider: c.model.provider, model: c.model.id, reason: c.quote.reason ?? (!c.health.available ? 'temporarily_unavailable' : 'task_or_grade_incompatible') })) };
  }
  async autoChat(request: ChatRequest, task: unknown = 'normal', options: RequestOptions = {}) {
    if (options.budgetException) throw new NidusError('invalid_request', 'Automatic routing cannot approve budget exceptions. Select a model manually.');
    const plan = await this.routePlan(request, task), ledger = this.usageLedger(), routeId = randomUUID();
    const excludedProviders = new Set<ProviderId>();
    const transitions: { provider: ProviderId; model: string; reason: string; status: string; budget: string; boundUSD: string | null; requestId?: string }[] = [];
    let reason = 'initial_selection';
    for (const candidate of plan.candidates) {
      const provider = candidate.model.provider, model = candidate.model.id;
      if (excludedProviders.has(provider) || !ledger.health(provider, '*').available || !ledger.health(provider, model).available) continue;
      if (options.signal?.aborted) throw new NidusError('cancelled', 'Automatic request cancelled.');
      const quote = ledger.quote(provider, { ...request, model });
      const event = { provider, model, reason, status: quote.allowed ? 'selected' : 'blocked', budget: quote.reason ?? 'allowed', boundUSD: quote.boundUSD };
      transitions.push(event); ledger.recordRoute(routeId, event);
      if (!quote.allowed) { reason = quote.reason!; continue; }
      let result;
      try {
        result = await this.chat(provider, { ...request, model }, options);
      } catch (error) {
        const code = error instanceof NidusError ? error.code : 'provider_error';
        const failed = { ...event, status: 'failed', reason: code, budget: code === 'budget' ? 'reservation_rejected' : event.budget };
        transitions.push(failed); ledger.recordRoute(routeId, failed);
        // Only explicit rejection categories permit another distinct attempt. Ambiguous delivery stops.
        if (!['budget', 'rate_limit', 'authentication', 'permission', 'missing_key', 'quota', 'not_found', 'unsupported'].includes(code))
          throw new NidusError(code, `Automatic routing stopped (${transitions.filter(t => t.status === 'failed').map(t => t.reason).join(' → ')}). No further request sent; inspect Usage & Budget.`, error instanceof NidusError ? error.status : null);
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
      return { ...result, routing: { routeId, difficulty: plan.difficulty, reason: candidate.reason, boundUSD: quote.boundUSD, estimatedUSD: result.estimatedUSD, budgetLevel: result.budget.level, transitions } };
    }
    throw new NidusError('budget', `No eligible automatic candidate remains (${reason}; ${plan.excluded.map(c => c.reason).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). Review Usage & Budget or select a compatible model manually.`);
  }
  async chat(provider: ProviderId, request: ChatRequest, options: RequestOptions = {}) {
    const saved = await this.store.load(provider);
    const known = saved?.models.find(m => m.id === request.model);
    if (known?.capabilities.chat === "unsupported") throw new NidusError("unsupported", "This model does not support the adapter's text generation endpoint.");
    return this.execute(provider, request, "chat", options);
  }
  private async execute(provider: ProviderId, request: ChatRequest, task: TaskKind, options: RequestOptions = {}) {
    validateChatRequest(request);
    if (options.budgetException !== undefined && typeof options.budgetException !== "boolean") throw new NidusError("invalid_request", "Explicit exception approval must be boolean.");
    if (options.signal?.aborted) throw new NidusError("cancelled", "Request cancelled before dispatch.");
    const key = await this.key(provider);
    const ledger = this.usageLedger();
    const reservation = ledger.reserve(provider, request, task, options.budgetException === true);
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
    const cost = calculatedCost(reservation.price, result.usage);
    return { ...result, estimatedUSD: cost === null ? null : dollars(cost), requestId: reservation.id, budget: ledger.snapshot().total };
  }

  async disconnect(provider: ProviderId) { await this.credentials.delete(provider); await this.store.remove(provider); return { provider, disconnected: true }; }
  async probe(provider: ProviderId, model: string, allowInferred = false) {
    const saved = await this.store.load(provider);
    const known = saved?.models.find(m => m.id === model);
    if (!known) throw new NidusError("invalid_request", "Refresh models before testing a discovered model.");
    return probeModel(known, allowInferred, async (request, options) => this.execute(provider, request, "probe", options));
  }
}
