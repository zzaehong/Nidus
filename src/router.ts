import { NidusError } from './errors.js';
import type { Model, ProviderId } from './types.js';
import { classifyModel } from './classification.js';
import { money } from './money.js';
export type Difficulty = 'simple' | 'normal' | 'complex';
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
  profile: ReturnType<typeof modelProfile>;
  quote: { allowed: boolean; reason: string | null; boundUSD: string | null };
  health: { status: string | bigint; checkedAt: string | bigint | null; excludedUntil: string | bigint | null; available: boolean };
  pressure: boolean;
}
export function rankCandidates(candidates: Candidate[], task: Difficulty) {
  const grades: Grade[] = task === 'simple' ? ['lightweight', 'general', 'advanced'] : task === 'normal' ? ['general', 'advanced'] : ['advanced'];
  const pressure = candidates.some(c => c.pressure);
  return candidates.filter(c => c.quote.allowed && c.quote.boundUSD !== null && c.health.available && c.model.capabilities.chat !== 'unsupported' && !['image', 'audio', 'video', 'live', 'embedding', 'moderation'].includes(classifyModel(c.model).kind) && grades.includes(c.profile.grade)
    && (task !== 'complex' || (c.profile.coding && c.profile.reasoning)))
    .map(c => ({ ...c, score: (c.quote.boundUSD !== null && money(c.quote.boundUSD) === 0n ? 1000 : 0) + (grades.length - grades.indexOf(c.profile.grade)) * 100,
      reason: `${task}:${c.profile.grade}; ${money(c.quote.boundUSD!) === 0n ? 'verified-zero-bound' : 'paid-budget-checked'}; ${c.pressure ? 'budget-saving' : 'task-fit'}` }))
    .sort((a, b) => {
      // Free first; pressure moves cost ahead of grade, but never admits incompatible grades.
      const free = Number(money(b.quote.boundUSD!) === 0n) - Number(money(a.quote.boundUSD!) === 0n);
      if (free) return free;
      const cost = money(a.quote.boundUSD!) < money(b.quote.boundUSD!) ? -1 : money(a.quote.boundUSD!) > money(b.quote.boundUSD!) ? 1 : 0;
      if (pressure && cost) return cost;
      if (a.score !== b.score) return b.score - a.score;
      if (cost) return cost;
      const date = (b.profile.updatedAt ?? b.profile.releasedAt ?? '').localeCompare(a.profile.updatedAt ?? a.profile.releasedAt ?? '');
      return date || `${a.model.provider}:${a.model.id}`.localeCompare(`${b.model.provider}:${b.model.id}`);
    });
}
