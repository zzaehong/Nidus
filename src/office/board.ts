// Task Board (CONCEPT: "Task 배정·실행 상태·작업 이력의 Source of Truth") for one user request.
// A Project holds Main's plan, the teams it chose, and Tasks with a Completion Contract.
// Kept in the Vault's .nidus/local/board/<project>.json.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../gateway/contract.js';
import type { Difficulty } from '../gateway/assignment.js';

export type ProjectStatus = 'planning' | 'waiting_user' | 'running' | 'reviewing' | 'done' | 'stopped' | 'failed';
export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked' | 'skipped';

export interface Team { id: string; name: string; focus: string }

/** What the Task must achieve and how completion is judged (CONCEPT: Completion Contract). */
export interface CompletionContract {
  goal: string;
  scope: string;
  constraints: string;
  acceptance: string[];
  verification: string;
}

export interface TaskReview { verdict: 'accept' | 'revise' | 'blocked'; feedback: string; at: string }

export interface BoardTask {
  id: string;
  team: string;
  title: string;
  contract: CompletionContract;
  dependsOn: string[];
  status: TaskStatus;
  difficulty?: Difficulty;
  brief?: string;
  attempts: number;
  reviews: TaskReview[];
  result?: { summary: string; verification: string };
  startedAt?: string;
  finishedAt?: string;
}

export interface Question { id: string; text: string; answer?: string }

export interface Project {
  id: string;
  instruction: string;
  createdAt: string;
  status: ProjectStatus;
  summary: string;
  roadmap: string[];
  teams: Team[];
  tasks: BoardTask[];
  questions: Question[];
  /** Main's conversation while planning, so a revision builds on what was said. */
  conversation: Message[];
  report?: string;
  /** The user dismissed it from the Work tab; it stays on the board as history. */
  closed?: boolean;
  /** The workspace task (VM /workspace, branch nidus/<workspace>) the project works in. */
  workspace?: string;
  error?: string;
}

export function projectId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `p-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export class BoardStore {
  constructor(private readonly directory: string) {}

  async save(project: Project): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, `${project.id}.json`), pending = `${file}.pending`;
    await writeFile(pending, JSON.stringify(project, null, 2) + '\n');
    await rename(pending, file);
  }

  /** The most recent project, if any. */
  async latest(): Promise<Project | null> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter(n => /^p-[\d-]+\.json$/.test(n)).sort(); } catch { return null; }
    const last = names.at(-1);
    if (!last) return null;
    try { return JSON.parse(await readFile(join(this.directory, last), 'utf8')) as Project; } catch { return null; }
  }
}

/** Tasks whose dependencies are done, in plan order. */
export function readyTasks(project: Project): BoardTask[] {
  const done = new Set(project.tasks.filter(t => t.status === 'done').map(t => t.id));
  return project.tasks.filter(t => t.status === 'pending' && t.dependsOn.every(d => done.has(d)));
}

/** Pending tasks that can never run because something they need is blocked or skipped. */
export function unreachable(project: Project): BoardTask[] {
  const failed = new Set(project.tasks.filter(t => t.status === 'blocked' || t.status === 'skipped').map(t => t.id));
  let changed = true;
  const out: BoardTask[] = [];
  while (changed) {
    changed = false;
    for (const t of project.tasks) {
      if (t.status === 'pending' && !out.includes(t) && t.dependsOn.some(d => failed.has(d))) { out.push(t); failed.add(t.id); changed = true; }
    }
  }
  return out;
}
