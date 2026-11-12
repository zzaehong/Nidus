// What Main and Managers are asked, and how their JSON answers are read and checked.
// They work in text only (no tools): Main plans and reports, Managers brief and review.
import { difficulties, type Difficulty } from '../gateway/assignment.js';
import { placeOf, type BoardTask, type CompletionContract, type Project, type Team } from './board.js';

export class PlanError extends Error {}

/** The JSON object in a model's answer: a fenced block, or the outermost braces. */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter((c): c is string => !!c && c.trim().startsWith('{'));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new PlanError('answer is not a JSON object');
}

const text = (value: unknown, field: string, max = 4000): string => {
  if (typeof value !== 'string' || !value.trim()) throw new PlanError(`${field} must be a non-empty string`);
  return value.trim().slice(0, max);
};
const optionalText = (value: unknown, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value: unknown, field: string, max: number): unknown[] => {
  if (!Array.isArray(value)) throw new PlanError(`${field} must be a list`);
  if (value.length > max) throw new PlanError(`${field}: at most ${max}`);
  return value;
};
const id = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw new PlanError(`${field}: an id of lowercase letters, digits and dashes`);
  return value;
};

export interface Plan { summary: string; roadmap: string[]; teams: Team[]; tasks: Omit<BoardTask, 'status' | 'attempts' | 'reviews'>[]; questions: string[] }

/** Reads and checks Main's plan: known teams, unique ids, existing dependencies, no cycles. */
export function parsePlan(answer: string): Plan {
  const raw = extractJson(answer);
  const teams = list(raw.teams, 'teams', 4).map((t: any) => ({ id: id(t?.id, 'team id'), name: text(t?.name, 'team name', 80), focus: text(t?.focus, 'team focus', 400) }));
  if (!teams.length) throw new PlanError('at least one team');
  const teamIds = new Set(teams.map(t => t.id));
  const tasks = list(raw.tasks, 'tasks', 12).map((t: any) => {
    const contract: CompletionContract = {
      goal: text(t?.goal, 'task goal', 2000), scope: optionalText(t?.scope, 2000), constraints: optionalText(t?.constraints, 2000),
      acceptance: list(t?.acceptance ?? [], 'acceptance', 10).map(a => text(a, 'acceptance item', 500)),
      verification: optionalText(t?.verification, 1000),
    };
    if (!contract.acceptance.length) throw new PlanError(`task ${t?.id}: at least one acceptance criterion`);
    const team = id(t?.team, 'task team');
    if (!teamIds.has(team)) throw new PlanError(`task ${t?.id}: unknown team ${team}`);
    if (t?.where !== undefined && t.where !== 'desk' && t.where !== 'vm') throw new PlanError(`task ${t?.id}: where must be "desk" or "vm"`);
    return { id: id(t?.id, 'task id'), team, title: text(t?.title, 'task title', 200), where: t?.where === 'desk' ? 'desk' as const : 'vm' as const, contract, dependsOn: list(t?.dependsOn ?? [], 'dependsOn', 12).map(d => id(d, 'dependency')) };
  });
  if (!tasks.length) throw new PlanError('at least one task');
  const ids = new Set<string>();
  for (const t of tasks) { if (ids.has(t.id)) throw new PlanError(`duplicate task id ${t.id}`); ids.add(t.id); }
  for (const t of tasks) for (const d of t.dependsOn) if (!ids.has(d) || d === t.id) throw new PlanError(`task ${t.id}: unknown dependency ${d}`);
  // Every task must be reachable: no dependency cycles.
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const next = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d)));
    if (!next.length) throw new PlanError('dependencies form a cycle');
    for (const t of next) done.add(t.id);
  }
  return {
    summary: text(raw.summary, 'summary', 3000),
    roadmap: list(raw.roadmap ?? [], 'roadmap', 12).map(r => text(r, 'roadmap step', 400)),
    teams, tasks,
    questions: list(raw.questions ?? [], 'questions', 6).map(q => text(q, 'question', 600)),
  };
}

export function parseBrief(answer: string): { difficulty: Difficulty; instructions: string } {
  const raw = extractJson(answer);
  if (!difficulties.includes(raw.difficulty)) throw new PlanError(`difficulty must be one of ${difficulties.join(', ')}`);
  return { difficulty: raw.difficulty, instructions: text(raw.instructions, 'instructions', 12000) };
}

export function parseReview(answer: string): { verdict: 'accept' | 'revise' | 'blocked'; feedback: string; summary: string; verification: string } {
  const raw = extractJson(answer);
  if (!['accept', 'revise', 'blocked'].includes(raw.verdict)) throw new PlanError('verdict must be accept, revise or blocked');
  return { verdict: raw.verdict, feedback: optionalText(raw.feedback, 4000), summary: text(raw.summary, 'summary', 4000), verification: optionalText(raw.verification, 2000) };
}

// --- prompts ---------------------------------------------------------------------

const WORKERS = [
  'Workers do the actual work, one task at a time, in one of two places:',
  '- desk: no VM. The Worker reads the user\'s Git repository (the Vault, committed state: list, read, search files) and the results of earlier tasks, and produces a text deliverable: writing, analysis, summaries, translation, plans, designs, code written out as text. No shell, no internet, no browser, no changes to files. It starts at once and needs no approvals.',
  '- vm: an isolated Linux VM with a copy of the repository at /workspace, a shell (Python, Node.js, git; long commands and background servers are possible), a real Chromium browser the user can watch and take over, web search, and internet access that the user approves per site. Every vm task works in the same workspace; at the end the user reviews the combined changes before they become a branch in their repository. The VM is started only when the first vm task begins.',
  'Earlier tasks\' deliverables are handed to the tasks that depend on them, so a desk task can draft something that a later vm task writes into the repository.',
].join('\n');

export function mainPlanSystem(): string {
  return [
    'You are Main, the lead of an AI team in Nidus. You talk with the user, turn their request into a plan, and later review the final result. You do not do the work yourself and have no tools.',
    WORKERS,
    'Teams are led by Managers. A Manager briefs a Worker for each task and reviews the result against the task\'s completion contract.',
    '',
    'Make a plan for the request:',
    '- summary: what will be delivered, in the user\'s language.',
    '- roadmap: the main steps, in order (short phrases).',
    '- teams: 1-4 teams this request needs (id, name, focus). Prefer fewer teams.',
    '- tasks: 1-12 tasks. Each is a unit a Worker can finish and a Manager can check: id, team, title, where ("desk" or "vm"), goal, scope, constraints, acceptance (observable criteria, a list), verification (how to check them), dependsOn (ids of tasks that must finish first).',
    '- where: "desk" whenever the task only needs thinking and writing over the request, the user\'s answers, earlier results and the repository\'s files. "vm" only when it must run commands or code, create or change files in the repository, or use the internet or a browser. A request that needs no vm task never starts the VM. If the user wants a deliverable saved as a file in their repository, a vm task must write it.',
    '- questions: only what you truly need from the user before starting (preferences, missing facts, choices with real trade-offs). Ask none if the request is clear; never ask what the team can find out itself.',
    '',
    'Write titles, summary, roadmap, contracts and questions in the user\'s language. Ids are lowercase letters, digits and dashes.',
    'Answer with one JSON object only:',
    '{"summary": "...", "roadmap": ["..."], "teams": [{"id": "research", "name": "...", "focus": "..."}], "tasks": [{"id": "t1", "team": "research", "title": "...", "where": "desk", "goal": "...", "scope": "...", "constraints": "...", "acceptance": ["..."], "verification": "...", "dependsOn": []}], "questions": ["..."]}',
  ].join('\n');
}

export function planRequest(instruction: string, repository: string): string {
  return `User request:\n${instruction}\n\nThe user's repository (the Vault), for context:\n${repository}`;
}

export function answersMessage(project: Project, note: string): string {
  const answered = project.questions.map(q => `Q: ${q.text}\nA: ${q.answer?.trim() || '(no answer; decide sensibly)'}`).join('\n\n');
  return `The user answered your questions${note ? ' and added a note' : ''}.\n\n${answered}${note ? `\n\nNote from the user:\n${note}` : ''}\n\nRevise the plan accordingly and answer with the full JSON plan again. Ask further questions only if still necessary.`;
}

function projectContext(project: Project, task: BoardTask): string {
  const team = project.teams.find(t => t.id === task.team);
  const others = project.tasks.filter(t => t.id !== task.id).map(t => `- ${t.id} [${t.status}] ${t.title}${t.result ? `: ${t.result.summary.slice(0, 600)}` : ''}`).join('\n');
  return [
    `Project request: ${project.instruction}`,
    `Plan: ${project.summary}`,
    project.questions.length ? `User's answers:\n${project.questions.map(q => `- ${q.text} -> ${q.answer || '(none)'}`).join('\n')}` : '',
    `Your team: ${team?.name} (${team?.focus})`,
    `Other tasks:\n${others || '(none)'}`,
    '',
    `Task ${task.id}: ${task.title}`,
    `Runs at: ${placeOf(task) === 'desk' ? 'desk (no VM: reads the repository, writes a text deliverable)' : 'vm (the shared workspace VM)'}`,
    `Goal: ${task.contract.goal}`,
    `Scope: ${task.contract.scope || '-'}`,
    `Constraints: ${task.contract.constraints || '-'}`,
    `Acceptance criteria:\n${task.contract.acceptance.map(a => `- ${a}`).join('\n')}`,
    `Verification: ${task.contract.verification || '-'}`,
    inputsOf(project, task, 4000),
  ].filter(Boolean).join('\n');
}

/** The deliverables of the tasks this one depends on, for its Manager and its Worker. */
export function inputsOf(project: Project, task: BoardTask, limit = 20000): string {
  const inputs = task.dependsOn.map(d => project.tasks.find(t => t.id === d)).filter((t): t is BoardTask => !!t?.output);
  if (!inputs.length) return '';
  const each = Math.floor(limit / inputs.length);
  return `Deliverables of earlier tasks this one builds on:\n${inputs.map(t => `--- ${t.id} ${t.title} ---\n${t.output!.length > each ? `${t.output!.slice(0, each)}\n… (${t.output!.length - each} more characters)` : t.output}`).join('\n\n')}`;
}

/** What the Worker is first told: the Manager's brief and the deliverables it builds on. */
export function workerBrief(project: Project, task: BoardTask): string {
  const inputs = inputsOf(project, task);
  return `${task.brief ?? ''}${inputs ? `\n\n${inputs}` : ''}`;
}

export function managerSystem(): string {
  return [
    'You are a Manager in Nidus. You lead one team: for each task you brief a Worker and then review what it delivered against the task\'s completion contract. You do not do the work yourself and have no tools.',
    WORKERS,
    'Workers come in three difficulty levels that map to stronger or cheaper models: simple (routine, well-defined), normal (most tasks), complex (hard reasoning, large changes, many steps). Choose the cheapest level that can do the task well.',
    'Be strict in reviews: accept only when the acceptance criteria are met and verified, not when the Worker merely says so.',
  ].join('\n');
}

export function briefRequest(project: Project, task: BoardTask): string {
  return `${projectContext(project, task)}\n\nWrite the Worker's instructions: what to do, where (paths, sites), how to verify each acceptance criterion, and what to report in its summary. For a vm task say what to commit; for a desk task say what the deliverable must contain (the deliverables listed above are given to the Worker with your instructions). Be concrete. Answer with one JSON object only:\n{"difficulty": "simple|normal|complex", "instructions": "..."}`;
}

export function reviewRequest(project: Project, task: BoardTask, evidence: string, attempt: number, maxAttempts: number): string {
  return [
    projectContext(project, task),
    '',
    `Worker's work (attempt ${attempt} of ${maxAttempts}):`,
    evidence,
    '',
    'Review it against the acceptance criteria. verdict: "accept" if met and verified; "revise" with concrete feedback if it can be fixed' + (attempt >= maxAttempts ? ' (no attempts are left: choose accept or blocked)' : '') + '; "blocked" if it cannot be done (missing access, a decision only the user can make) and say why.',
    'summary: the task result for the record, in the user\'s language. verification: how the criteria were checked.',
    'Answer with one JSON object only: {"verdict": "accept|revise|blocked", "feedback": "...", "summary": "...", "verification": "..."}',
  ].join('\n');
}

export function finalRequest(project: Project): string {
  const tasks = project.tasks.map(t => {
    const output = t.output ? `\n  Deliverable (${placeOf(t)}):\n${t.output.slice(0, 6000)}${t.output.length > 6000 ? '\n  …' : ''}` : '';
    return `- ${t.id} ${t.title} [${t.status}, ${placeOf(t)}]\n  ${t.result ? `${t.result.summary}\n  Verified: ${t.result.verification}` : t.reviews.at(-1)?.feedback ?? ''}${output}`;
  }).join('\n');
  const changes = project.workspace
    ? 'The combined changes in the repository will be shown to them for approval.'
    : 'No task used the VM, so nothing in their repository changed; the user reads desk deliverables in the task list, so point to them rather than repeating them in full.';
  return `All tasks have ended. Request: ${project.instruction}\nPlan: ${project.summary}\n\nTasks:\n${tasks}\n\nWrite the final report for the user, in their language: what was delivered, how it was checked, what is unfinished or blocked and why, and what they should review or decide next. ${changes} Plain text, concise.`;
}
