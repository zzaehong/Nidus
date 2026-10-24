import { UsageLedger, type TaskKind } from "./ledger.js";
import { deepseekBalance, usageCapabilities } from "./provider-usage.js";
import { validateChatRequest } from "./adapters/base.js";
import { adapters } from "./adapters/index.js";
import { classifyModel } from "./classification.js";
import { probeModel } from "./health.js";
import type { CredentialStore } from "./credentials.js";
import { NidusError } from "./errors.js";
import { keyValue } from "./http.js";
import { priceFor, pricesFor } from "./pricing.js";
import type { ModelSnapshot, ModelStore } from "./storage.js";
import { providerIds, type ChatRequest, type ProviderAdapter, type ProviderId, type RequestOptions } from "./types.js";

export class ConnectivityEngine {
  constructor(private readonly credentials: CredentialStore, private readonly store: ModelStore, private readonly registry: Record<ProviderId, ProviderAdapter> = adapters(), private ledger?: UsageLedger) {}
  private usageLedger() { return this.ledger ??= new UsageLedger(); }
  usage() { return { ...this.usageLedger().snapshot(), capabilities: usageCapabilities }; }
  setBudget(scope: unknown, usd: unknown) { this.usageLedger().setBudget(scope, usd); return this.usage(); }
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
    return { source, fetchedAt: snapshot.fetchedAt, models: snapshot.models.map(m => ({ ...m, classification: classifyModel(m), pricing: priceFor(snapshot.provider, m.id) })) };
  }
  async detail(provider: ProviderId, model: string, options: RequestOptions = {}) {
    const detail = await this.registry[provider].getModel(await this.key(provider), model, options);
    return { ...detail, classification: classifyModel(detail), pricing: priceFor(provider, model) };
  }
  async pricing(provider: ProviderId) {
    const saved = await this.store.load(provider);
    return { provider, source: "reviewed-static-snapshot", autoRefresh: false, modelSource: saved ? "discovered-cache" : "reviewed-price-records-only", prices: saved ? saved.models.map(m => priceFor(provider, m.id)) : pricesFor(provider) };
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
    try {
      const result = await this.registry[provider].chat(key, request, { ...options, onHeaders: value => { headers = value; } });
      ledger.settle(reservation, "succeeded", result.usage, headers);
      return { ...result, requestId: reservation.id, budget: ledger.snapshot().total };
    } catch (error) {
      // Settlement errors leave the durable reservation intact. Never send a retry here.
      if (!(error instanceof NidusError && error.code === "storage")) {
        ledger.settle(reservation, error instanceof NidusError && error.code === "cancelled" ? "cancelled" : "failed", error instanceof NidusError ? error.usage : null, headers);
      }
      throw error;
    }
  }
  async disconnect(provider: ProviderId) { await this.credentials.delete(provider); await this.store.remove(provider); return { provider, disconnected: true }; }
  async probe(provider: ProviderId, model: string, allowInferred = false) {
    const saved = await this.store.load(provider);
    const known = saved?.models.find(m => m.id === model);
    if (!known) throw new NidusError("invalid_request", "Refresh models before testing a discovered model.");
    return probeModel(known, allowInferred, async (request, options) => this.execute(provider, request, "probe", options));
  }
}
