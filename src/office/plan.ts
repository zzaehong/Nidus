// What Main and Managers are asked, and how their JSON answers are read and checked.
// They work in text only (no tools): Main plans and reports, Managers brief and review.
// Who they are (their system prompts) is in roles.ts; this file holds what each request asks.
import { difficulties, type Difficulty } from '../gateway/assignment.js';
import { placeOf, workerFor, type BoardTask, type CompletionContract, type Keep, type Project, type ProjectEmployee, type Team } from './board.js';
import { describeStaff, type Staff } from './home.js';

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

export interface Plan { summary: string; roadmap: string[]; teams: Team[]; staff: ProjectEmployee[]; tasks: Omit<BoardTask, 'status' | 'attempts' | 'reviews'>[]; questions: string[] }

const NO_STAFF: Staff = { version: 1, groups: [], employees: [] };
const keepOf = (value: unknown): Keep => value === 'permanent' ? 'permanent' : 'temporary';

/**
 * Reads and checks Main's plan: known teams, unique ids, existing dependencies, no cycles.
 * Teams named by the id of a standing Group are that Group with its people; other teams, and
 * "hires", are proposals the user approves with the plan.
 */
export function parsePlan(answer: string, standing: Staff = NO_STAFF): Plan {
  const raw = extractJson(answer);
  const teams: Team[] = list(raw.teams, 'teams', 4).map((t: any) => {
    const teamId = id(t?.id, 'team id');
    const known = standing.groups.find(g => g.id === teamId);
    if (known) return { ...known };
    return { id: teamId, name: text(t?.name, 'team name', 80), focus: text(t?.focus, 'team focus', 400), proposed: true, keep: keepOf(t?.keep), ...(optionalText(t?.reason, 400) ? { reason: optionalText(t?.reason, 400) } : {}) };
  });
  if (!teams.length) throw new PlanError('at least one team');
  if (new Set(teams.map(t => t.id)).size !== teams.length) throw new PlanError('duplicate team id');
  const teamIds = new Set(teams.map(t => t.id));
  const staff: ProjectEmployee[] = teams.flatMap(t => t.proposed ? [] : standing.employees.filter(e => e.group === t.id));
  const taken = new Set([...standing.employees.map(e => e.id), ...staff.map(e => e.id)]);
  const fresh = (wanted: string) => { let candidate = wanted.slice(0, 32), n = 2; while (taken.has(candidate)) candidate = `${wanted.slice(0, 28)}-${n++}`; taken.add(candidate); return candidate; };
  for (const h of list(raw.hires ?? [], 'hires', 4) as any[]) {
    const hireId = id(h?.id, 'hire id');
    if (taken.has(hireId)) throw new PlanError(`hire ${hireId}: that id is already an employee`);
    const team = teams.find(t => t.id === h?.team);
    if (!team) throw new PlanError(`hire ${hireId}: unknown team ${h?.team}`);
    taken.add(hireId);
    staff.push({ id: hireId, name: text(h?.name, 'hire name', 80), group: team.id, kind: 'worker', role: text(h?.role, 'hire role', 80),
      principles: list(h?.principles ?? [], 'principles', 6).map(p => text(p, 'principle', 500)), proposed: true,
      // Nobody stays longer than their team.
      keep: team.proposed && team.keep === 'temporary' ? 'temporary' : keepOf(h?.keep), ...(optionalText(h?.reason, 400) ? { reason: optionalText(h?.reason, 400) } : {}) });
  }
  // Every team works with one Manager and at least one Worker: what a proposal left out is filled in.
  for (const team of teams) {
    const keep = team.proposed ? team.keep : 'temporary';
    if (!staff.some(e => e.group === team.id && e.kind === 'manager')) staff.push({ id: fresh(`${team.id.slice(0, 24)}-manager`), name: `${team.name} 팀장`, group: team.id, kind: 'manager', role: 'Manager', principles: [], proposed: true, keep });
    if (!staff.some(e => e.group === team.id && e.kind === 'worker')) staff.push({ id: fresh(`${team.id.slice(0, 25)}-worker`), name: `${team.name} 담당`, group: team.id, kind: 'worker', role: 'Generalist', principles: [], proposed: true, keep });
  }
  const tasks = list(raw.tasks, 'tasks', 12).map((t: any) => {
    const contract: CompletionContract = {
      goal: text(t?.goal, 'task goal', 2000), scope: optionalText(t?.scope, 2000), constraints: optionalText(t?.constraints, 2000),
      acceptance: list(t?.acceptance ?? [], 'acceptance', 10).map(a => text(a, 'acceptance item', 500)),
      verification: optionalText(t?.verification, 1000),
    };
    if (!contract.acceptance.length) throw new PlanError(`task ${t?.id}: at least one acceptance criterion`);
    const team = id(t?.team, 'task team');
    if (!teamIds.has(team)) throw new PlanError(`task ${t?.id}: unknown team ${team}`);
    // "desk" is what text tasks were called before 2026-11-13.
    if (t?.where !== undefined && t.where !== 'text' && t.where !== 'vm' && t.where !== 'desk') throw new PlanError(`task ${t?.id}: where must be "text" or "vm"`);
    const workers = staff.filter(e => e.group === team && e.kind === 'worker');
    if (t?.assignee !== undefined && t.assignee !== null && !workers.some(w => w.id === t.assignee)) throw new PlanError(`task ${t?.id}: assignee ${t.assignee} is not a worker of team ${team}`);
    return { id: id(t?.id, 'task id'), team, title: text(t?.title, 'task title', 200), assignee: (t?.assignee as string | undefined) ?? workers[0]!.id, where: t?.where === 'text' || t?.where === 'desk' ? 'text' as const : 'vm' as const, contract, dependsOn: list(t?.dependsOn ?? [], 'dependsOn', 12).map(d => id(d, 'dependency')) };
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
    teams, staff, tasks,
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

/** How Main answers with a plan; part of the first planning message. */
export const PLAN_FORMAT = [
  'Make a plan for the request:',
  '- summary: what will be delivered.',
  '- roadmap: the main steps, in order (short phrases).',
  '- teams: 1-4 teams this request needs. Use the standing teams listed above by their id whenever one fits (give only {"id": "..."}). Only when none fits, propose a new team: {"id", "name", "focus", "keep", "reason"}. Prefer fewer teams.',
  '- hires (optional, at most 4): a Worker with a role a team lacks for this request: {"id", "team", "name", "role", "keep", "reason"}. Do not hire for work a standing Worker can do.',
  '- keep: "temporary" (only for this request; the default) or "permanent" (joins the standing staff; only when the need will clearly come back). The user approves proposals together with the plan.',
  '- tasks: 1-12 tasks. Each is a unit a Worker can finish and a Manager can check: id, team, assignee (the id of a Worker of that team; leave out to give it to the first Worker of the team), title, where ("text" or "vm"), goal, scope, constraints, acceptance (observable criteria, a list), verification (how to check them), dependsOn (ids of tasks that must finish first).',
  '- where: "text" whenever the task only needs thinking and writing over the request, the user\'s answers, earlier results and the repository\'s files. "vm" only when it must run commands or code, create or change files in the repository, or use the internet or a browser. A request that needs no vm task never starts the VM. If the user wants a deliverable saved as a file in their repository, a vm task must write it.',
  '- questions: only what you truly need from the user before starting. Ask none if the request is clear.',
  'Ids are lowercase letters, digits and dashes. Answer with one JSON object only:',
  '{"summary": "...", "roadmap": ["..."], "teams": [{"id": "research"}], "hires": [], "tasks": [{"id": "t1", "team": "research", "assignee": "researcher", "title": "...", "where": "text", "goal": "...", "scope": "...", "constraints": "...", "acceptance": ["..."], "verification": "...", "dependsOn": []}], "questions": ["..."]}',
].join('\n');

export function planRequest(instruction: string, repository: string, standing?: Staff, knowledge?: string): string {
  const teams = standing ? `\n\nThe standing teams of this Vault (they keep their identity across requests):\n${describeStaff(standing)}` : '';
  const learned = knowledge ? `\n\nFrom the Library, what earlier projects taught (apply what fits: put it into task constraints, or tell Workers which document to read with library_read):\n${knowledge}` : '';
  return `User request:\n${instruction}\n\nThe user's repository (the Vault), for context:\n${repository}${teams}${learned}\n\n${PLAN_FORMAT}`;
}

export function answersMessage(project: Project, note: string): string {
  const answered = project.questions.map(q => `Q: ${q.text}\nA: ${q.answer?.trim() || '(no answer; decide sensibly)'}`).join('\n\n');
  return `The user answered your questions${note ? ' and added a note' : ''}.\n\n${answered}${note ? `\n\nNote from the user:\n${note}` : ''}\n\nRevise the plan accordingly and answer with the full JSON plan again, in the same format. Ask further questions only if still necessary.`;
}

function projectContext(project: Project, task: BoardTask): string {
  const team = project.teams.find(t => t.id === task.team);
  const others = project.tasks.filter(t => t.id !== task.id).map(t => `- ${t.id} [${t.status}] ${t.title}${t.result ? `: ${t.result.summary.slice(0, 600)}` : ''}`).join('\n');
  return [
    `Project request: ${project.instruction}`,
    `Plan: ${project.summary}`,
    project.questions.length ? `User's answers:\n${project.questions.map(q => `- ${q.text} -> ${q.answer || '(none)'}`).join('\n')}` : '',
    `Your team: ${team?.name} (${team?.focus})`,
    (() => { const worker = workerFor(project, task); return worker ? `The Worker on this task: ${worker.name} (${worker.role})${worker.principles.length ? `; their principles: ${worker.principles.join(' / ')}` : ''}` : ''; })(),
    `Other tasks:\n${others || '(none)'}`,
    '',
    `Task ${task.id}: ${task.title}`,
    `Runs at: ${placeOf(task) === 'text' ? 'text (no VM: reads the repository, writes a text deliverable)' : 'vm (the shared workspace VM)'}`,
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

export function briefRequest(project: Project, task: BoardTask): string {
  return `${projectContext(project, task)}\n\nWrite the Worker's instructions: what to do, where (paths, sites), how to verify each acceptance criterion, and what to report in its summary. For a vm task say what to commit; for a text task say what the deliverable must contain (the deliverables listed above are given to the Worker with your instructions). Be concrete. Answer with one JSON object only:\n{"difficulty": "simple|normal|complex", "instructions": "..."}`;
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
    : 'No task used the VM, so nothing in their repository changed; the user reads text deliverables in the task list, so point to them rather than repeating them in full.';
  return `All tasks have ended. Request: ${project.instruction}\nPlan: ${project.summary}\n\nTasks:\n${tasks}\n\nWrite the final report for the user, in their language: what was delivered, how it was checked, what is unfinished or blocked and why, and what they should review or decide next. ${changes} Plain text, concise.`;
}
