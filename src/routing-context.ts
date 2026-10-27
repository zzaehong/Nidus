import { NidusError } from './errors.js';
import { dollars } from './money.js';
import { priceFor, type Price } from './pricing.js';
import { difficulty, gradeTier, modelProfile, rankCandidates, type Difficulty, type Tier } from './router.js';
import { providerIds, type ProviderId, type Model } from './types.js';
import type { ModelSnapshot } from './storage.js';
import type { UsageLedger } from './ledger.js';

export interface TaskContext {
  type: 'chat' | 'probe' | 'coding' | 'analysis' | 'summary' | 'other';
  difficulty: Difficulty;
  requiredCapabilities: ('text' | 'reasoning' | 'coding' | 'vision' | 'tools' | 'streaming')[];
  inputCharacters: number | null;
  estimatedInputTokens: number | null;
}
export interface UsageContext {
  requests: number; inputTokens: number | null; outputTokens: number | null; unknownTokenRequests: number;
  estimatedUSD: string | null; confirmedUSD: string | null; knownSpendUSD: string | null;
  unknownCostRequests: number; estimatedRequests: number; confirmedRequests: number; freeAttestedRequests: number; priceVersions: string[];
}
export interface SoftBudgetContext {
  provider: ProviderId; targetUSD: string | null; updatedAt: string | null;
  usage: UsageContext; utilizationPercent: number | null; knownUtilizationPercent: number | null;
  state: 'unset' | 'incomplete' | 'within' | 'exceeded'; enforcement: 'none';
}
export interface ModelContext {
  provider: ProviderId; model: string; tier: Tier; tierSource: string | null; tierCheckedAt: string | null; userModified: boolean;
  capabilities: Model['capabilities'] & { coding: 'supported' | 'unknown'; reasoning: 'supported' | 'unknown' };
  limits: Model['limits']; catalogFetchedAt: string; catalogAgeSeconds: number | null;
  connection: 'credential-present-unverified' | 'disconnected' | 'unknown';
  health: { status: string; checkedAt: string | null; cooldownUntil: string | null; providerCooldownUntil: string | null; providerStatus: string; providerCheckedAt: string | null; available: boolean; verifiedAvailable: boolean | null };
  usage: UsageContext;
  recent: { since: string; completedRequests: number; successRate: number | null; failures: number; cancelled: number; lastCallAt: string | null; lastError: string | null; lastErrorAt: string | null; observedRoutingFailures: number; observedRateLimitEvents: number; errorHistoryScope: 'automatic-route-events-only' };
  cost: { officialPrice: Price; basis: 'stored-ledger-estimates-including-free-attestation'; unknown: boolean };
  permission: { allowed: boolean | null; reason: string | null };
  requiredCapabilitiesSatisfied: boolean;
}
export interface RoutingDecisionContext {
  schemaVersion: 1; generatedAt: string; dataAsOf: { ledger: string | null; catalog: Record<ProviderId, string | null> };
  month: string; scope: 'nidus-local-only'; task: TaskContext; models: ModelContext[];
  providers: SoftBudgetContext[];
  routingPolicy: { revision: number; tierPriorities: Record<Difficulty, Tier[]>; allowedModels: string[]; executableCandidates: string[]; semantics: 'advisory-snapshot-recheck-before-execution' };
}
// Optional external decision engines consume this DTO; no implementation or network dependency.
export interface RoutingDecisionEngine { decide(context: RoutingDecisionContext): Promise<{ provider: ProviderId; model: string; reason: string }>; }
export type DecisionData = ReturnType<UsageLedger['decisionData']>;
type Row = DecisionData['models'][number];
export function taskContext(value: unknown): TaskContext {
  if (!value || typeof value !== 'object') throw new NidusError('invalid_request', 'Task context is required.');
  const t = value as Record<string, unknown>;
  if (Object.keys(t).some(k => !['type','difficulty','requiredCapabilities','inputCharacters','estimatedInputTokens'].includes(k))) throw new NidusError('invalid_request', 'Task context must not contain content or extra fields.');
  if (!['chat','probe','coding','analysis','summary','other'].includes(String(t.type))) throw new NidusError('invalid_request','Invalid task type.');
  const required = t.requiredCapabilities ?? ['text'];
  if (!Array.isArray(required) || required.some(c => !['text','reasoning','coding','vision','tools','streaming'].includes(c)) || new Set(required).size !== required.length) throw new NidusError('invalid_request','Invalid required capabilities.');
  const size = (v: unknown) => { if (v == null) return null; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new NidusError('invalid_request','Invalid input size.'); return v; };
  return { type: t.type as TaskContext['type'], difficulty: difficulty(t.difficulty), requiredCapabilities: required as TaskContext['requiredCapabilities'], inputCharacters: size(t.inputCharacters), estimatedInputTokens: size(t.estimatedInputTokens) };
}
const number = (v: Row[string] | undefined) => v == null ? null : Number(v);
const usd = (v: Row[string] | undefined) => v == null ? null : dollars(v as bigint);
export function usageContext(row?: Row): UsageContext {
  return { requests: Number(row?.requests ?? 0), inputTokens: number(row?.input), outputTokens: number(row?.output), unknownTokenRequests: Number(row?.unknown_tokens ?? 0),
    estimatedUSD: usd(row?.estimated), confirmedUSD: usd(row?.confirmed), knownSpendUSD: usd(row?.spend), unknownCostRequests: Number(row?.unknown ?? 0), estimatedRequests: Number(row?.estimated_count ?? 0), confirmedRequests: Number(row?.confirmed_count ?? 0), freeAttestedRequests: Number(row?.free_count ?? 0), priceVersions: row?.versions ? String(row.versions).split(',') : [] };
}
export function softBudgets(data: DecisionData): SoftBudgetContext[] {
  return providerIds.map(provider => {
    const row = data.budgets.find(b => b.provider === provider), use = data.providers.find(r => r.provider === provider), usage = usageContext(use);
    const target = row?.amount as bigint | undefined, spent = use?.spend as bigint | null | undefined;
    const known = target != null && target > 0n && spent != null ? Number(spent * 10000n / target) / 100 : null;
    return { provider, targetUSD: usd(target), updatedAt: row?.updated_at as string ?? null, usage, knownUtilizationPercent: known,
      utilizationPercent: usage.unknownCostRequests ? null : known,
      state: target == null ? 'unset' : spent != null && spent > target ? 'exceeded' : usage.unknownCostRequests ? 'incomplete' : 'within', enforcement: 'none' };
  });
}
export interface ContextSources {
  data: DecisionData;
  catalogs: { provider: ProviderId; snapshot: ModelSnapshot | null; connection: ModelContext['connection'] }[];
  permission: (provider: ProviderId, model: string) => ModelContext['permission'];
}
export function buildContext(task: TaskContext, sources: ContextSources): RoutingDecisionContext {
  task = taskContext(task);
  const {data, catalogs} = sources;
  const index = (rows: Row[]) => new Map(rows.map(r => [`${r.provider}:${r.model}`, r]));
  const stats = index(data.models), recent = index(data.recent), tiers = index(data.tiers), health = index(data.health), last = index(data.lastCalls), routeFailures = index(data.routeFailures);
  const models: ModelContext[] = [], originals = new Map<string, Model>();
  const dates = Object.fromEntries(providerIds.map(p => [p, null])) as Record<ProviderId, string | null>;
  for (const catalog of catalogs) {
    const snapshot = catalog.snapshot; dates[catalog.provider] = snapshot?.fetchedAt ?? null;
    for (const m of snapshot?.models ?? []) {
      const key = `${catalog.provider}:${m.id}`;
      if (m.provider !== catalog.provider || originals.has(key)) continue;
      originals.set(key, m);
      const profile = modelProfile(m.provider, m.id), t = tiers.get(key), h = health.get(key), ph = health.get(`${m.provider}:*`), r = recent.get(key);
      const available = [h, ph].every(x => !x?.until_at || String(x.until_at) <= data.at);
      const capability = (c: TaskContext['requiredCapabilities'][number]) => c === 'text' ? m.capabilities.chat === 'supported' : c === 'coding' || c === 'reasoning' ? profile[c] : m.capabilities[c] === 'supported';
      const age = (Date.parse(data.at) - Date.parse(snapshot!.fetchedAt)) / 1000;
      const usage = usageContext(stats.get(key));
      models.push({ provider: m.provider, model: m.id, tier: t ? Number(t.tier) as Tier : gradeTier(profile.grade), tierSource: t?.source as string ?? profile.source, tierCheckedAt: t?.checked_at as string ?? profile.checkedAt, userModified: t?.user_modified === 1n,
        capabilities: { chat: m.capabilities.chat ?? 'unknown', streaming: m.capabilities.streaming ?? 'unknown', tools: m.capabilities.tools ?? 'unknown', vision: m.capabilities.vision ?? 'unknown', coding: profile.coding ? 'supported' : 'unknown', reasoning: profile.reasoning ? 'supported' : 'unknown' },
        limits: { inputTokens: m.limits?.inputTokens ?? null, outputTokens: m.limits?.outputTokens ?? null, contextTokens: m.limits?.contextTokens ?? null },
        catalogFetchedAt: snapshot!.fetchedAt, catalogAgeSeconds: Number.isFinite(age) && age >= 0 ? age : null, connection: catalog.connection,
        health: { status: String(h?.status ?? 'unknown'), checkedAt: h?.at as string ?? null, cooldownUntil: h?.until_at as string ?? null, providerCooldownUntil: ph?.until_at as string ?? null, providerStatus: String(ph?.status ?? 'unknown'), providerCheckedAt: ph?.at as string ?? null, available, verifiedAvailable: !available ? false : h?.status === 'passed' ? true : null },
        usage, recent: { since: data.since, completedRequests: Number(r?.requests ?? 0), successRate: r?.requests ? Number(r.successes) / Number(r.requests) : null, failures: Number(r?.failures ?? 0), cancelled: Number(r?.cancelled ?? 0), lastCallAt: last.get(key)?.at as string ?? null,
          lastError: h && h.status !== 'passed' ? String(h.status) : null, lastErrorAt: h && h.status !== 'passed' ? String(h.at) : null, observedRoutingFailures: Number(routeFailures.get(key)?.failures ?? 0), observedRateLimitEvents: Number(routeFailures.get(key)?.rate_limits ?? 0), errorHistoryScope: 'automatic-route-events-only' },
        cost: { officialPrice: priceFor(m.provider, m.id), basis: 'stored-ledger-estimates-including-free-attestation', unknown: usage.unknownCostRequests > 0 || usage.knownSpendUSD === null },
        permission: sources.permission(m.provider, m.id), requiredCapabilitiesSatisfied: task.requiredCapabilities.every(capability) });
    }
  }
  const allowed = models.filter(m => data.settings.policies[task.difficulty].includes(m.tier) && m.tier !== 0);
  const eligible = allowed.filter(m => m.connection === 'credential-present-unverified' && m.permission.allowed && m.requiredCapabilitiesSatisfied);
  const ranked = rankCandidates(eligible.map(m => ({ model: originals.get(`${m.provider}:${m.model}`)!, tier: m.tier, profile: modelProfile(m.provider,m.model), quote: { allowed: true, reason: null, boundUSD: null }, health: { status: m.health.status, checkedAt: m.health.checkedAt, excludedUntil: m.health.cooldownUntil, available: m.health.available }, pressure: false })), task.difficulty, data.settings.policies[task.difficulty]);
  return { schemaVersion: 1, generatedAt: data.at, dataAsOf: { ledger: data.ledgerUpdatedAt as string | null, catalog: dates }, month: data.month, scope: 'nidus-local-only', task, models, providers: softBudgets(data),
    routingPolicy: { revision: data.settings.revision, tierPriorities: data.settings.policies, allowedModels: allowed.map(m => `${m.provider}:${m.model}`), executableCandidates: ranked.map(m => `${m.model.provider}:${m.model.id}`), semantics: 'advisory-snapshot-recheck-before-execution' } };
}
