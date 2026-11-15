// Auto-fill: candidates for every slot of the assignment table, from the models that are connected
// and have passed the check the slot needs. Nothing here is a judgement about a model's quality:
// the order comes from facts that are on hand — the provider's list price (a stand-in for the
// model's class), the context window, and how fast it has been here — and from two rules the
// user set: the same model is not the only candidate anywhere, and a slot mixes providers so one
// provider's rate limit does not stop the work. The user then edits the result like any other
// candidate list, and a model they took out (an Exclusion) is never put back.
import type { Difficulty, Exclusion, ModelRef } from './assignment.js';
import { excludedFrom, refName, slotId } from './assignment.js';

export interface RankedModel extends ModelRef {
  /** USD per million output tokens from the provider's list, or null when the list has no entry. A stand-in for the model's class. */
  outputPrice: number | null;
  /** What a call costs here: 0 on a free tier, else the list price. */
  costPrice: number | null;
  contextTokens: number | null;
  /** Median duration of recent successful calls here, or null. */
  medianMs: number | null;
  textPassed: boolean;
  toolsPassed: boolean;
  /** Neither check has been run. */
  untested: boolean;
}

export type Strength = 'strong' | 'middle' | 'light';

export interface SlotPlan {
  slot: string;
  role: string;
  difficulty: Difficulty | null;
  /** The user's own candidates, kept in place. */
  kept: string[];
  /** What auto-fill adds after them, in order. */
  added: { ref: string; strength: Strength; why: string }[];
  /** Models that passed the check but were left out, by the user's exclusion. */
  excluded: string[];
}

export interface AutoFillPlan {
  slots: SlotPlan[];
  /** Connected models the slots could use once checked. */
  untested: number;
  /** Models that passed the check the slots need, in all. */
  eligible: number;
}

export const CANDIDATES_PER_SLOT = 3;

/** Thirds of the price order: the most expensive third is "strong". With few models the thirds are small, which is fine. */
export function strengths(models: RankedModel[]): Map<string, Strength> {
  const known = models.filter(m => m.outputPrice !== null).sort((a, b) => b.outputPrice! - a.outputPrice! || (b.contextTokens ?? 0) - (a.contextTokens ?? 0));
  const out = new Map<string, Strength>();
  known.forEach((m, i) => out.set(refName(m), i < known.length / 3 ? 'strong' : i < (2 * known.length) / 3 ? 'middle' : 'light'));
  // No price on the list: placed by context window alone, in the middle.
  for (const m of models) if (!out.has(refName(m))) out.set(refName(m), 'middle');
  return out;
}

/** The order of strengths a slot wants. Planning roles and complex work want the strongest; simple work the lightest (cheapest, usually fastest). */
export function preference(role: string, difficulty: Difficulty | null): Strength[] {
  if (role === 'worker' && difficulty === 'simple') return ['light', 'middle', 'strong'];
  if (role === 'worker' && difficulty === 'normal') return ['middle', 'strong', 'light'];
  return ['strong', 'middle', 'light'];
}

function describe(model: RankedModel, strength: Strength): string {
  const parts = [strength === 'strong' ? '상위 급' : strength === 'middle' ? '중간 급' : '가벼운 급'];
  parts.push(model.costPrice === 0 ? '무료' : model.outputPrice === null ? '가격표 없음' : `출력 $${model.outputPrice}/M`);
  if (model.contextTokens) parts.push(`문맥 ${Math.round(model.contextTokens / 1000)}k`);
  if (model.medianMs) parts.push(`보통 ${Math.round(model.medianMs / 1000)}초`);
  return parts.join(' · ');
}

/**
 * Picks up to CANDIDATES_PER_SLOT models for one slot: the preferred strength first, and within a
 * strength the cheaper and faster first; the second and third choices come from other providers
 * when any exist, so one provider's rate limit does not empty the slot.
 */
export function pickFor(role: string, difficulty: Difficulty | null, pool: RankedModel[], ranked: Map<string, Strength>, kept: string[]): SlotPlan['added'] {
  const order = preference(role, difficulty);
  const byStrength = (m: RankedModel) => order.indexOf(ranked.get(refName(m)) ?? 'middle');
  const sorted = [...pool].filter(m => !kept.includes(refName(m))).sort((a, b) =>
    byStrength(a) - byStrength(b)
    || (order[0] === 'light' ? (a.costPrice ?? Infinity) - (b.costPrice ?? Infinity) : (b.outputPrice ?? -1) - (a.outputPrice ?? -1))
    || (a.medianMs ?? Infinity) - (b.medianMs ?? Infinity)
    || (b.contextTokens ?? 0) - (a.contextTokens ?? 0)
    || refName(a).localeCompare(refName(b)));
  const chosen: RankedModel[] = [];
  const providersUsed = new Set(kept.map(ref => ref.slice(0, ref.indexOf(':'))));
  while (chosen.length + kept.length < CANDIDATES_PER_SLOT && sorted.length) {
    const next = sorted.find(m => !providersUsed.has(m.provider)) ?? sorted[0]!;
    sorted.splice(sorted.indexOf(next), 1);
    chosen.push(next);
    providersUsed.add(next.provider);
  }
  return chosen.map(m => { const strength = ranked.get(refName(m)) ?? 'middle'; return { ref: refName(m), strength, why: describe(m, strength) }; });
}

export interface SlotInput { role: string; difficulty: Difficulty | null; current: ModelRef[]; auto: string[] }

/** The whole plan: every slot, from the connected models, honouring the user's own picks and exclusions. */
export function planAutoFill(slots: SlotInput[], models: RankedModel[], excluded: Exclusion[]): AutoFillPlan {
  const ranked = strengths(models.filter(m => m.textPassed || m.toolsPassed));
  const plans: SlotPlan[] = [];
  let eligible = new Set<string>();
  for (const s of slots) {
    const slot = slotId(s.role, s.difficulty);
    const needsTools = s.role === 'worker';
    const passing = models.filter(m => needsTools ? m.toolsPassed : m.textPassed);
    passing.forEach(m => eligible.add(refName(m)));
    const kept = s.current.map(refName).filter(ref => !s.auto.includes(ref));
    const allowed = passing.filter(m => !excludedFrom(excluded, refName(m), slot));
    const left = passing.filter(m => excludedFrom(excluded, refName(m), slot)).map(refName);
    plans.push({ slot, role: s.role, difficulty: s.difficulty, kept, added: pickFor(s.role, s.difficulty, allowed, ranked, kept), excluded: left });
  }
  return { slots: plans, untested: models.filter(m => m.untested).length, eligible: eligible.size };
}
