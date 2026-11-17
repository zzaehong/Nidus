// What Main is told about the work in progress, so it can answer "where is it stuck?" from facts:
// each Task with its time and reviews, what happened lately (model calls, failures, waits, tools),
// and the state of the models each slot can use.
import type { AssignmentTable, Difficulty } from '../gateway/assignment.js';
import type { ModelHealth } from '../gateway/health.js';
import type { Project } from './board.js';

const clock = (at: Date) => at.toISOString().slice(11, 19);

/** "1시간 12분", "3분", "40초". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  // Under ten minutes the seconds matter: a model that takes 1분 44초 is not one that takes 1분.
  return h ? `${h}시간 ${m % 60}분` : m < 10 && s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
}

/** The latest things that happened, newest last; old ones fall off. */
export class ActivityLog {
  private readonly items: { at: Date; text: string }[] = [];
  constructor(private readonly keep = 80, private readonly now: () => Date = () => new Date()) {}

  add(text: string): void {
    this.items.push({ at: this.now(), text: text.replace(/\s+/g, ' ').trim().slice(0, 300) });
    if (this.items.length > this.keep) this.items.splice(0, this.items.length - this.keep);
  }

  render(limit = 40): string {
    return this.items.slice(-limit).map(i => `${clock(i.at)} ${i.text}`).join('\n');
  }
}

/** Every Task of the project: where it stands, for how long, how many tries, what its Manager said last. */
export function describeProgress(project: Project, now: Date): string {
  const lines = [`Project ${project.id}: ${project.status}, started ${elapsed(now.getTime() - Date.parse(project.createdAt))} ago${project.error ? `; error: ${project.error}` : ''}`];
  for (const t of project.tasks) {
    const started = t.startedAt ? Date.parse(t.startedAt) : null;
    const took = started ? elapsed((t.finishedAt ? Date.parse(t.finishedAt) : now.getTime()) - started) : null;
    const time = took ? (t.finishedAt ? `, took ${took}` : `, running for ${took}`) : '';
    const tries = t.attempts ? `, attempt ${t.attempts}` : '';
    const last = t.reviews.at(-1);
    const review = last ? `\n    last review (${last.verdict}): ${last.feedback.replace(/\s+/g, ' ').slice(0, 300)}` : '';
    const waits = t.status === 'pending' && t.dependsOn.length ? ` (waits for ${t.dependsOn.join(', ')})` : '';
    lines.push(`- ${t.id} [${t.status}] ${t.title} — ${t.where ?? 'vm'}${t.difficulty ? `, ${t.difficulty}` : ''}${tries}${time}${waits}${review}`);
  }
  return lines.join('\n');
}

/**
 * The candidates of each slot and how they are doing: resting (and why, until when), failing,
 * at its quota (Gemini's per-minute or daily limit), or fine with their usual answer time. A slot whose candidates all rest is said to be stuck.
 */
export function describeModels(table: AssignmentTable, health: Map<string, ModelHealth>, now: Date, limited: string[] = []): string {
  const slots: [string, string[]][] = [
    ...Object.entries(table.roles).map(([role, refs]) => [role, refs.map(r => `${r.provider}:${r.model}`)] as [string, string[]]),
    ...(Object.entries(table.worker) as [Difficulty, { provider: string; model: string }[]][]).map(([d, refs]) => [`worker ${d}`, refs.map(r => `${r.provider}:${r.model}`)] as [string, string[]]),
  ];
  const lines: string[] = [];
  for (const [slot, refs] of slots) {
    if (!refs.length) { lines.push(`- ${slot}: no candidates`); continue; }
    let usable = 0;
    const parts = refs.map(ref => {
      const h = health.get(ref);
      const resting = h?.restUntil && h.restUntil > now, capped = limited.includes(ref);
      if (!resting && !capped) usable++;
      const state = capped ? 'at its quota limit (per minute or per day), passed over until it resets' : resting ? `resting ${elapsed(h!.restUntil!.getTime() - now.getTime())} more after ${h!.streak} ${h!.lastError} failure(s)`
        : h?.streak ? `${h.streak} recent ${h.lastError} failure(s)` : 'ok';
      return `${ref} (${state}${h?.medianMs ? `, usually ${elapsed(h.medianMs)}` : ''})`;
    });
    lines.push(`- ${slot}: ${parts.join(' > ')}${usable ? '' : ' — every candidate is resting: calls wait or go to a failing model'}`);
  }
  return lines.join('\n');
}
