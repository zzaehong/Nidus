// What Main is told about the work in progress, so it can answer "where is it stuck?" from facts:
// each Task with its time and reviews, what happened lately (model calls, failures, waits, tools),
// and the state of the models each slot can use.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssignmentTable, Difficulty } from '../gateway/assignment.js';
import type { UsageSummary } from '../gateway/usage.js';
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

/**
 * The latest things that happened, newest last; old ones fall off. With a file (JSON lines) it
 * survives a restart of the app, so Main still knows what happened before.
 */
export class ActivityLog {
  private readonly items: { at: Date; text: string }[] = [];
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly keep = 80, private readonly now: () => Date = () => new Date(), private readonly file?: string) {}

  /** Reads what the file kept and trims it to the last `keep` entries. A missing or damaged file is a fresh start. */
  static async open(file: string, keep = 200, now?: () => Date): Promise<ActivityLog> {
    const log = new ActivityLog(keep, now, file);
    const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    for (const line of lines) {
      try { const x = JSON.parse(line); if (typeof x.at === 'string' && typeof x.text === 'string') log.items.push({ at: new Date(x.at), text: x.text }); } catch {}
    }
    log.items.splice(0, Math.max(0, log.items.length - keep));
    if (lines.length > log.items.length) await writeFile(file, log.items.map(i => JSON.stringify({ at: i.at.toISOString(), text: i.text })).join('\n') + '\n').catch(() => {});
    return log;
  }

  add(text: string): void {
    const item = { at: this.now(), text: text.replace(/\s+/g, ' ').trim().slice(0, 300) };
    this.items.push(item);
    if (this.items.length > this.keep) this.items.splice(0, this.items.length - this.keep);
    const file = this.file;
    // shortcut: the file grows until the next open trims it; a day of work is a few thousand lines.
    if (file) this.writing = this.writing.then(() => mkdir(dirname(file), { recursive: true })).then(() => appendFile(file, JSON.stringify({ at: item.at.toISOString(), text: item.text }) + '\n')).catch(() => {});
  }

  /** Resolves when everything added so far is on disk. */
  flushed(): Promise<void> { return this.writing; }

  render(limit = 40): string {
    return this.items.slice(-limit).map(i => `${i.at.toISOString().slice(5, 10)} ${clock(i.at)} ${i.text}`).join('\n');
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

const finishedAt = (p: Project) => p.tasks.map(t => t.finishedAt).filter((x): x is string => !!x).sort().at(-1);

/** Earlier projects, newest first, one line each: how they ended, how long, which Tasks did not get done. */
export function describeHistory(projects: Project[]): string {
  return projects.map(p => {
    const end = finishedAt(p);
    const took = end ? `, took ${elapsed(Date.parse(end) - Date.parse(p.createdAt))}` : '';
    const done = p.tasks.filter(t => t.status === 'done').length;
    const missed = p.tasks.filter(t => t.status === 'blocked' || t.status === 'skipped').map(t => `${t.id} ${t.status}`);
    return `- ${p.id} [${p.status}${p.closed ? ', closed' : ''}${took}] ${p.instruction.replace(/\s+/g, ' ').slice(0, 120)} — tasks ${done}/${p.tasks.length} done${missed.length ? ` (${missed.join(', ')})` : ''}${p.error ? `; error: ${p.error.slice(0, 160)}` : ''}`;
  }).join('\n');
}

/** This month's calls: totals, and the models that fail most. */
export function describeUsage(usage: UsageSummary): string {
  const failed = usage.groups.reduce((n, g) => n + g.failed, 0);
  const byModel = new Map<string, { calls: number; failed: number }>();
  for (const g of usage.groups) { const k = `${g.provider}:${g.model}`, x = byModel.get(k) ?? { calls: 0, failed: 0 }; x.calls += g.calls; x.failed += g.failed; byModel.set(k, x); }
  const worst = [...byModel].filter(([, x]) => x.failed).sort((a, b) => b[1].failed - a[1].failed).slice(0, 5).map(([k, x]) => `${k} ${x.failed}/${x.calls} failed`);
  return `${usage.month}: ${usage.calls} calls, ${failed} failed, $${Number(usage.costUSD).toFixed(2)}${usage.unknownCostCalls ? ` (+${usage.unknownCostCalls} calls of unknown price)` : ''}${worst.length ? `\nMost failures: ${worst.join('; ')}` : ''}`;
}

export interface MainDeskInput {
  now: Date;
  /** Running, VM, who uses it, what waits for the user. */
  state: string;
  project: Project | null;
  activity: ActivityLog;
  models: string;
  history: Project[];
  usage: string;
}

/**
 * Main's Desk: everything Main needs to know about the work and Nidus itself, as one page. It is
 * built from the facts (boards, the call log, the activity log), never written by a model, and
 * kept on disk so a restart or another Main model starts from the same picture.
 */
export function renderMainDesk(d: MainDeskInput): string {
  const open = d.project && !d.project.closed && !['done', 'failed'].includes(d.project.status) ? d.project : null;
  const earlier = d.history.filter(p => p.id !== open?.id).slice(0, 8);
  return [
    `# Main Desk — ${d.now.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    `## Now\n${d.state}`,
    `## Open project\n${open ? `${open.instruction.replace(/\s+/g, ' ').slice(0, 300)}\nPlan: ${open.summary.slice(0, 600)}\n${describeProgress(open, d.now)}${open.questions.some(q => !q.answer) ? '\nQuestions to the user in the plan panel are not answered yet.' : ''}` : 'None.'}`,
    `## Recent activity (UTC, newest last)\n${d.activity.render() || '(nothing yet)'}`,
    `## Models by slot (candidate order)\n${d.models || '(unknown)'}`,
    `## Earlier projects (newest first)\n${describeHistory(earlier) || '(none)'}`,
    `## This month\n${d.usage || '(unknown)'}`,
  ].join('\n\n') + '\n';
}
