import { NidusError } from './errors.js';
import type { Model, ProviderId } from './types.js';
import { classifyModel } from './classification.js';
import { money } from './money.js';
export type Difficulty = 'simple' | 'normal' | 'complex';
export type Tier = 0 | 1 | 2 | 3;
export const defaultTierOrder: Record<Difficulty, Tier[]> = { simple: [1, 2], normal: [2, 1], complex: [3, 2] };
export const gradeTier = (grade: Grade): Tier => ({ lightweight: 1, general: 2, advanced: 3, unknown: 0 } as const)[grade];
export type Grade = 'lightweight' | 'general' | 'advanced' | 'unknown';
export function difficulty(value: unknown = 'normal'): Difficulty {
  if (value !== 'simple' && value !== 'normal' && value !== 'complex') throw new NidusError('invalid_request', 'Difficulty must be simple, normal or complex.');
  return value;
}
// Editorial task classes, not measured performance rankings. Exact reviewed IDs only.
const records: Record<string, { grade: Grade; releasedAt: string | null; source: string; coding: boolean; reasoning: boolean }> = {
  'openai:gpt-4.1-mini': { grade: 'lightweight', releasedAt: '2025-04-14', source: 'https://openai.com/index/gpt-4-1/', coding: true, reasoning: false },
  'openai:gpt-4.1-mini-2025-04-14': { grade: 'lightweight', releasedAt: '2025-04-14', source: 'https://openai.com/index/gpt-4-1/', coding: true, reasoning: false },
  'anthropic:claude-sonnet-4-6': { grade: 'general', releasedAt: '2026-02-17', source: 'https://www.anthropic.com/news/claude-sonnet-4-6', coding: true, reasoning: true },
  'anthropic:claude-opus-4-6': { grade: 'advanced', releasedAt: '2026-02-05', source: 'https://www.anthropic.com/news/claude-opus-4-6', coding: true, reasoning: true },
  'gemini:gemini-3.5-flash-lite': { grade: 'lightweight', releasedAt: null, source: 'https://ai.google.dev/gemini-api/docs/models', coding: false, reasoning: false },
  'gemini:gemini-2.5-flash': { grade: 'general', releasedAt: null, source: 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash', coding: true, reasoning: true },
  'deepseek:deepseek-flash': { grade: 'general', releasedAt: null, source: 'https://api-docs.deepseek.com/quick_start/pricing/', coding: true, reasoning: true },
  'deepseek:deepseek-v4-pro': { grade: 'advanced', releasedAt: null, source: 'https://api-docs.deepseek.com/quick_start/pricing/', coding: true, reasoning: true }
};
export function modelProfile(provider: ProviderId, id: string) {
  const record = records[`${provider}:${id}`];
  return { ...(record ?? { grade: 'unknown' as Grade, releasedAt: null, source: null, coding: false, reasoning: false }), updatedAt: null,
    checkedAt: record ? '2026-10-24T06:00:00Z' : null };
}
export interface Candidate {
  model: Model;
  tier?: Tier;
  profile: ReturnType<typeof modelProfile>;
  quote: { allowed: boolean; reason: string | null; boundUSD: string | null };
  health: { status: string | bigint; checkedAt: string | bigint | null; excludedUntil: string | bigint | null; available: boolean };
  pressure: boolean;
}
export function rankCandidates(candidates: Candidate[], task: Difficulty, order: Tier[] = defaultTierOrder[task]) {
  return candidates.map(c => ({ ...c, tier: c.tier ?? gradeTier(c.profile.grade) }))
    .filter(c => c.tier !== 0 && order.includes(c.tier) && c.quote.allowed && c.quote.boundUSD !== null && c.health.available
      && c.model.capabilities.chat !== 'unsupported'
      && (classifyModel(c.model).kind === 'text' || c.health.status === 'passed' || c.profile.grade !== 'unknown')
      && !['image', 'audio', 'video', 'live', 'embedding', 'moderation'].includes(classifyModel(c.model).kind))
    .map(c => ({ ...c, score: (order.length - order.indexOf(c.tier)) * 100,
      reason: `${task}:tier-${c.tier}; ${money(c.quote.boundUSD!) === 0n ? 'verified-zero-bound' : 'paid-budget-checked'}; ${c.pressure ? 'budget-saving' : 'task-fit'}` }))
    .sort((a, b) => {
      // User tier order is absolute, including during budget warnings and for free candidates.
      const tier = order.indexOf(a.tier) - order.indexOf(b.tier);
      if (tier) return tier;
      const cost = money(a.quote.boundUSD!) < money(b.quote.boundUSD!) ? -1 : money(a.quote.boundUSD!) > money(b.quote.boundUSD!) ? 1 : 0;
      if (cost) return cost;
      const date = (b.profile.updatedAt ?? b.profile.releasedAt ?? '').localeCompare(a.profile.updatedAt ?? a.profile.releasedAt ?? '');
      return date || `${a.model.provider}:${a.model.id}`.localeCompare(`${b.model.provider}:${b.model.id}`);
    });
}
