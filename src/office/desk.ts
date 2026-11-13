// Desk (CONCEPT: "현재 Project·Task를 수행하기 위해 유지하는 Working Context Store"). What a Worker
// knows about the task it is on, kept outside the conversation so a new session, a restart of
// the app or another model can pick the work up:
//   .nidus/local/desk/<project>/<task>.json
// Native working context (progress, findings, next action) has its source of truth here, with a
// checkpoint history against loss. Things whose truth lives elsewhere (task status, reviews,
// files, commits) are only referred to, and are read from their source when context is recovered.
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolCallBlock, ToolSpec } from '../gateway/contract.js';
import type { ToolOutcome } from '../workspace/tools.js';
import type { WorkerToolSet } from '../workspace/worker.js';
import type { BoardTask, Project } from './board.js';

export interface DeskCheckpoint { at: string; kind: 'note' | 'summary' | 'final'; text: string }

export interface Desk {
  project: string;
  task: string;
  employee: string | null;
  status: 'open' | 'closed';
  updatedAt: string;
  /** What is done so far. */
  progress: string;
  /** What was found out that the rest of the task needs. */
  findings: string;
  /** What to do next. */
  next: string;
  /** Where the things referred to are (paths, URLs, commits): pointers, not copies. */
  references: string[];
  /** Earlier states, newest last (at most 10): the defence against a lost or damaged Desk. */
  checkpoints: DeskCheckpoint[];
}

const MAX_FIELD = 6_000;
const MAX_CHECKPOINTS = 10;
const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const clip = (value: unknown, max = MAX_FIELD) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export const deskHasContext = (desk: Desk | null): desk is Desk => !!desk && !!(desk.progress || desk.findings || desk.next || desk.checkpoints.length);

/** The Desk as the Worker reads it. */
export function renderDesk(desk: Desk): string {
  const lines = [
    `Progress: ${desk.progress || '(nothing noted)'}`,
    `Findings: ${desk.findings || '(nothing noted)'}`,
    `Next action: ${desk.next || '(nothing noted)'}`,
  ];
  if (desk.references.length) lines.push(`References: ${desk.references.join(', ')}`);
  const summary = [...desk.checkpoints].reverse().find(c => c.kind === 'summary');
  if (summary) lines.push(`Summary of the earlier session (${summary.at}):\n${summary.text}`);
  return lines.join('\n');
}

export class DeskStore {
  constructor(private readonly directory: string) {}

  private file(project: string, task: string): string | null {
    return safe.test(project) && safe.test(task) ? join(this.directory, project, `${task}.json`) : null;
  }

  /** The task's Desk; a damaged file falls back to the copy kept from the save before. */
  async load(project: string, task: string): Promise<Desk | null> {
    const file = this.file(project, task);
    if (!file) return null;
    for (const path of [file, `${file}.previous`]) {
      try {
        const desk = JSON.parse(await readFile(path, 'utf8')) as Desk;
        if (desk && typeof desk === 'object' && Array.isArray(desk.checkpoints)) return desk;
      } catch {}
    }
    return null;
  }

  private async save(desk: Desk): Promise<void> {
    const file = this.file(desk.project, desk.task);
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    await copyFile(file, `${file}.previous`).catch(() => {});
    const pending = `${file}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(desk, null, 2) + '\n');
    await rename(pending, file);
  }

  /** A text task's deliverable as far as it is written: kept beside the Desk, so a restart does not lose it. */
  async saveDraft(project: string, task: string, text: string): Promise<void> {
    const file = this.file(project, task);
    if (!file) return;
    // In order: a later draft must not be overwritten by an earlier save that finishes late.
    const turn = (this.drafts.get(file) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const pending = `${file}.${randomUUID()}.pending`;
      await writeFile(pending, text);
      await rename(pending, file.replace(/\.json$/, '.draft.md'));
    });
    this.drafts.set(file, turn.catch(() => {}));
    await turn;
  }
  private readonly drafts = new Map<string, Promise<void>>();

  async loadDraft(project: string, task: string): Promise<string | undefined> {
    const file = this.file(project, task);
    if (!file) return undefined;
    try { return await readFile(file.replace(/\.json$/, '.draft.md'), 'utf8') || undefined; } catch { return undefined; }
  }

  private blank(project: string, task: string, employee: string | null): Desk {
    return { project, task, employee, status: 'open', updatedAt: new Date().toISOString(), progress: '', findings: '', next: '', references: [], checkpoints: [] };
  }

  /** The Worker's own update: given fields replace the old ones, which go into the history. */
  async update(project: string, task: string, employee: string | null, patch: { progress?: unknown; findings?: unknown; next?: unknown; references?: unknown }): Promise<Desk> {
    const desk = await this.load(project, task) ?? this.blank(project, task, employee);
    if (desk.progress || desk.findings || desk.next) this.push(desk, 'note', `Progress: ${desk.progress}\nFindings: ${desk.findings}\nNext action: ${desk.next}`);
    if (patch.progress !== undefined) desk.progress = clip(patch.progress);
    if (patch.findings !== undefined) desk.findings = clip(patch.findings);
    if (patch.next !== undefined) desk.next = clip(patch.next, 2_000);
    if (Array.isArray(patch.references)) desk.references = [...new Set([...desk.references, ...patch.references.map(r => clip(r, 300)).filter(Boolean)])].slice(-30);
    Object.assign(desk, { employee: employee ?? desk.employee, status: 'open', updatedAt: new Date().toISOString() });
    await this.save(desk);
    return desk;
  }

  /** A checkpoint made for the Worker: the summary of a compacted session, or the final state of a task. */
  async checkpoint(project: string, task: string, employee: string | null, kind: 'summary' | 'final', text: string): Promise<Desk> {
    const desk = await this.load(project, task) ?? this.blank(project, task, employee);
    this.push(desk, kind, clip(text, 10_000));
    Object.assign(desk, { employee: employee ?? desk.employee, updatedAt: new Date().toISOString(), ...(kind === 'final' ? { status: 'closed' as const } : {}) });
    await this.save(desk);
    return desk;
  }

  private push(desk: Desk, kind: DeskCheckpoint['kind'], text: string): void {
    desk.checkpoints.push({ at: new Date().toISOString(), kind, text });
    // The latest summary is what recovery reads: it outlives the notes around it.
    while (desk.checkpoints.length > MAX_CHECKPOINTS) {
      const note = desk.checkpoints.findIndex(c => c.kind === 'note');
      desk.checkpoints.splice(note < 0 ? 0 : note, 1);
    }
  }
}

export const DESK_TOOL: ToolSpec = {
  name: 'desk_update',
  description: 'Update your Desk: the working context of this task that survives a new session, a restart or another model taking over. Call it when a step is done or you learn something the rest of the task needs. Give only the fields that changed.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    progress: { type: 'string', description: 'What is done so far (replaces the earlier progress note)' },
    findings: { type: 'string', description: 'Facts, values and decisions found that the rest of the task needs (replaces the earlier findings)' },
    next_action: { type: 'string', description: 'What to do next' },
    references: { type: 'array', items: { type: 'string' }, description: 'Paths, URLs or commits to find things again (added to the list)' },
  } },
};

/** A Worker's tools plus its Desk. */
export function withDesk(tools: WorkerToolSet, update: (patch: { progress?: unknown; findings?: unknown; next?: unknown; references?: unknown }) => Promise<Desk>): WorkerToolSet {
  const specs = [...tools.specs.filter(s => s.name !== 'finish'), DESK_TOOL, ...tools.specs.filter(s => s.name === 'finish')];
  return {
    specs,
    async run(call: ToolCallBlock, signal?: AbortSignal): Promise<ToolOutcome> {
      if (call.name !== DESK_TOOL.name) return tools.run(call, signal);
      if (call.inputError) return { content: `Invalid call: ${call.inputError}`, isError: true };
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (input.progress === undefined && input.findings === undefined && input.next_action === undefined && !Array.isArray(input.references)) return { content: 'Error: give at least one of progress, findings, next_action, references.', isError: true };
      try {
        const desk = await update({ progress: input.progress, findings: input.findings, next: input.next_action, references: input.references });
        return { content: `Desk updated (${desk.updatedAt}).`, isError: false };
      } catch (error: any) {
        return { content: `Error: the Desk could not be saved (${String(error?.message ?? error)}). Go on with the task.`, isError: true };
      }
    },
  };
}

/**
 * Context recovery (CONCEPT: Home -> Desk -> Task Board -> Desk update -> work): what a Worker
 * is told when it takes a task up again in a new session. Home is its system prompt. The Task
 * Board is read fresh here; where it and the Desk disagree, the Task Board and the files win.
 */
export function recoveryBrief(project: Project, task: BoardTask, desk: Desk, maxAttempts: number): string {
  const reviews = task.reviews.length ? task.reviews.map((r, i) => `  ${i + 1}. ${r.verdict}${r.feedback ? `: ${r.feedback.slice(0, 800)}` : ''}`).join('\n') : '  (none yet)';
  return [
    '[Context recovery: you are taking this task up again in a new session. Read this before acting.]',
    '',
    `Task Board (source of truth): task ${task.id} "${task.title}" of project ${project.id}; attempt ${Math.max(1, task.attempts)} of ${maxAttempts}.`,
    `Reviews so far:\n${reviews}`,
    '',
    `Your Desk (last updated ${desk.updatedAt}):`,
    renderDesk(desk),
    '',
    'First reconcile: check that what the Desk says is done really is (the files, the commits, the deliverable). Where the Desk disagrees with the Task Board or with what you find, trust those and correct the Desk with desk_update. Then continue from the next action; do not redo what is done.',
  ].join('\n');
}
