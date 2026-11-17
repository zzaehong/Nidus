// The instruction structure: the user instructs Main; Main plans (roadmap, teams, tasks with a
// completion contract) and asks what it needs; after the user approves the plan, each task goes
// to its team's Manager, who briefs a Worker and reviews the result; Main reports at the end.
// Tasks whose dependencies are done run side by side, each with its own Manager and Worker
// conversation (up to maxParallel). A text task runs without the VM (text over the Vault's
// files); vm tasks share one workspace VM, which the work dependency hands to one Worker at a
// time, so one Worker can use it while another's result is being reviewed.
// Main and Managers work in text only.
import type { Message } from '../gateway/contract.js';
import type { Difficulty } from '../gateway/assignment.js';
import { sendWithRetry, type RetryPolicy, type WorkerGateway, type WorkerOutcome } from '../workspace/worker.js';
import { BoardStore, managerFor, projectId, readyTasks, unreachable, workerFor, type BoardTask, type Project } from './board.js';
import { identity, type HomeStore, type Staff } from './home.js';
import type { DeskStore } from './desk.js';
import { knowledgeRequest, parseKnowledge, recordProject, type Library } from './library.js';
import { PlanError, answersMessage, briefRequest, finalRequest, parseBrief, parsePlan, parseReview, planRequest, reviewRequest, workerBrief } from './plan.js';
import { mainSystem, managerSystem } from './roles.js';
import { checkDecision, decisionNote, decisionText, type Agenda } from './meeting.js';

export type OfficeEvent =
  | { type: 'project'; project: Project }
  | { type: 'message'; from: 'main' | 'manager'; taskId?: string; title: string; text: string; /** "provider:model" of the call that produced this, for the user's judgement. */ model?: string; difficulty?: Difficulty; /** Main's final report of the project: it is also said in the conversation. */ final?: true }
  | { type: 'retry'; from: string; attempt: number; error: string };

export interface OfficeDeps {
  gateway: WorkerGateway;
  store: BoardStore;
  /** The Vault's standing staff (Home). Without it every team is made up for the request. */
  home?: HomeStore;
  /** Workers' Desks: a task that ends gets its final checkpoint. */
  desk?: DeskStore;
  /** The Library: Main sees what earlier projects taught, and a finished project is written into it. */
  library?: Library;
  /** A short description of the Vault's repository for Main (file list, README). */
  repository(): Promise<string>;
  /**
   * Has a Worker do a task (or continue it after a review) where it runs (a text task, or the shared
   * workspace VM) and returns what happened with evidence for the Manager: summary, tool trail,
   * and the changes since the task began (vm) or the deliverable (text, also as output).
   */
  work(task: BoardTask, instruction: string, difficulty: Difficulty, signal: AbortSignal, revision: boolean): Promise<{ outcome: WorkerOutcome; evidence: string; output?: string }>;
  onEvent(event: OfficeEvent): void;
  retryWaits?: number[];
  /** Tasks run at once, at most (default 3). */
  maxParallel?: number;
}

export const DEFAULT_PARALLEL = 3;

/** A Worker gets this many tries per task: the first and up to two revisions. */
export const MAX_ATTEMPTS = 3;

/** Questions a task may put to the user (Meeting Room); a decision does not use up a try. */
export const MAX_ESCALATIONS = 2;

export class Office {
  project: Project | null = null;
  /** Tasks waiting for the user's decision, woken by decide(). */
  private readonly waiting = new Map<string, () => void>();

  constructor(private readonly deps: OfficeDeps) {}

  private get retry(): RetryPolicy {
    return this.deps.retryWaits ? { waits: this.deps.retryWaits, rateLimitWaits: this.deps.retryWaits } : {};
  }

  /** Saves in order: with tasks side by side, a later state must never be overwritten by an earlier one. */
  private saving: Promise<void> = Promise.resolve();

  private async publish(): Promise<void> {
    if (!this.project) return;
    const snapshot = structuredClone(this.project);
    const saved = this.saving.then(() => this.deps.store.save(snapshot));
    this.saving = saved.catch(() => {});
    await saved;
    this.deps.onEvent({ type: 'project', project: snapshot });
  }

  /** A model call whose JSON answer is parsed; a malformed answer is asked for once more. */
  private async ask<T>(role: 'main' | 'manager', system: string, messages: Message[], parse: (text: string) => T, signal: AbortSignal, taskId?: string): Promise<{ value: T; text: string; model: string }> {
    const conversation = [...messages];
    for (let attempt = 0; ; attempt++) {
      const result = await sendWithRetry(this.deps.gateway, { role, taskId: taskId ?? this.project?.id }, { system, messages: conversation }, signal,
        this.retry, (n, error) => this.deps.onEvent({ type: 'retry', from: role, attempt: n, error }));
      const text = result.response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
      try {
        return { value: parse(text), text, model: `${result.response.provider}:${result.response.model}` };
      } catch (error) {
        if (!(error instanceof PlanError) || attempt >= 1) throw new Error(`${role === 'main' ? 'Main' : 'Manager'}의 답을 읽지 못했습니다: ${(error as Error).message}`);
        conversation.push({ role: 'assistant', content: [{ type: 'text', text }] }, { role: 'user', content: [{ type: 'text', text: `That answer could not be used: ${(error as Error).message}. Answer again with the JSON object only.` }] });
      }
    }
  }

  // --- Meeting Room -----------------------------------------------------------------

  /** Puts a matter to the user. The agenda is saved with the project before anyone is told. */
  private async raise(from: Agenda['from'], taskId: string | null, draft: Pick<Agenda, 'title' | 'background' | 'reasoning' | 'options' | 'recommendation'>, model?: string): Promise<Agenda> {
    const project = this.project!;
    const agenda: Agenda = { id: `a${(project.agendas?.length ?? 0) + 1}`, from, taskId, ...draft, at: new Date().toISOString() };
    (project.agendas ??= []).push(agenda);
    await this.publish();
    this.deps.onEvent({ type: 'message', from: from === 'manager' ? 'manager' : 'main', taskId: taskId ?? undefined, title: `Meeting Room · ${agenda.title}`, text: `${agenda.background}\n\n선택지:\n${agenda.options.map((o, i) => `${i + 1}. ${o.label}${o.impact ? ` — ${o.impact}` : ''}`).join('\n')}${agenda.recommendation ? `\n\n추천: ${agenda.recommendation}` : ''}`, ...(model ? { model } : {}) });
    return agenda;
  }

  /** Waits until the user decides on the agenda (or the work is stopped). */
  private decision(agenda: Agenda, signal: AbortSignal): Promise<void> {
    if (agenda.decision || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { this.waiting.delete(agenda.id); resolve(); };
      this.waiting.set(agenda.id, done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The user's decision on an agenda. It is kept with the project, noted on the Task's Desk, and
   * written into the Library when the user marked it as one to keep; the waiting Task goes on.
   */
  async decide(agendaId: string, input: { kind: unknown; option?: unknown; note?: unknown; remember?: unknown }): Promise<Agenda> {
    const project = this.project;
    const agenda = project?.agendas?.find(a => a.id === agendaId);
    if (!project || !agenda) throw new Error('그런 안건이 없습니다');
    agenda.decision = checkDecision(agenda, input);
    if (agenda.taskId) await this.deps.desk?.checkpoint(project.id, agenda.taskId, workerFor(project, project.tasks.find(t => t.id === agenda.taskId)!)?.id ?? null, 'note', `Meeting Room "${agenda.title}": ${decisionText(agenda)}`).catch(() => {});
    if (agenda.decision.remember && this.deps.library) {
      const note = decisionNote(agenda);
      const date = agenda.decision.at.slice(0, 10);
      await this.deps.library.write('Decisions', note.title, ['---', 'type: decision', `project: ${project.id}`, `date: ${date}`, 'decided-by: user', 'author: Nidus', '---', `# ${note.title}`, '', note.text].join('\n')).catch(() => {});
    }
    await this.publish();
    this.deps.onEvent({ type: 'message', from: 'main', taskId: agenda.taskId ?? undefined, title: `Meeting Room · 결정: ${agenda.title}`, text: decisionText(agenda) });
    this.waiting.get(agenda.id)?.();
    return agenda;
  }

  // --- planning -------------------------------------------------------------------

  async plan(instruction: string, signal: AbortSignal): Promise<Project> {
    this.project = { id: projectId(), instruction, createdAt: new Date().toISOString(), status: 'planning', summary: '', roadmap: [], teams: [], tasks: [], questions: [], conversation: [] };
    this.project.conversation.push({ role: 'user', content: [{ type: 'text', text: planRequest(instruction, await this.deps.repository(), await this.deps.home?.staff(), await this.deps.library?.digest().catch(() => '')) }] });
    await this.publish();
    return this.revise(signal);
  }

  /** The user's answers (by question id) and an optional note; Main revises the plan. */
  async reply(answers: Record<string, string>, note: string, signal: AbortSignal): Promise<Project> {
    const project = this.requireStatus('waiting_user');
    for (const q of project.questions) if (typeof answers[q.id] === 'string') q.answer = answers[q.id]!.slice(0, 4000);
    project.conversation.push({ role: 'user', content: [{ type: 'text', text: answersMessage(project, note.trim().slice(0, 4000)) }] });
    project.status = 'planning';
    await this.publish();
    return this.revise(signal);
  }

  private async revise(signal: AbortSignal): Promise<Project> {
    const project = this.project!;
    try {
      const standing: Staff | undefined = await this.deps.home?.staff();
      const { value: plan, text, model } = await this.ask('main', mainSystem(), project.conversation, answer => parsePlan(answer, standing), signal);
      project.conversation.push({ role: 'assistant', content: [{ type: 'text', text }] });
      Object.assign(project, { summary: plan.summary, roadmap: plan.roadmap, teams: plan.teams, staff: plan.staff, status: 'waiting_user' as const });
      project.tasks = plan.tasks.map(t => ({ ...t, status: 'pending' as const, attempts: 0, reviews: [] }));
      // Answers given so far stay with the questions Main asks again.
      const previous = new Map(project.questions.map(q => [q.text, q.answer]));
      project.questions = plan.questions.map((text, i) => ({ id: `q${i + 1}`, text, ...(previous.get(text) ? { answer: previous.get(text) } : {}) }));
      const asked = project.questions.length ? `\n\n질문:\n${project.questions.map(q => `- ${q.text}`).join('\n')}` : '';
      this.deps.onEvent({ type: 'message', from: 'main', title: '계획', text: `${plan.summary}${asked}`, model });
    } catch (error) {
      if (signal.aborted) { project.status = 'stopped'; }
      else { project.status = 'failed'; project.error = String((error as Error).message ?? error); }
    }
    await this.publish();
    return project;
  }

  private requireStatus(...statuses: Project['status'][]): Project {
    if (!this.project || !statuses.includes(this.project.status)) throw new Error('지금 할 수 있는 일이 아닙니다');
    return this.project;
  }

  // --- execution ------------------------------------------------------------------

  /** The user approved the plan: tasks run in order until all have ended, then Main reports. */
  async execute(signal: AbortSignal): Promise<Project> {
    const project = this.requireStatus('waiting_user', 'stopped');
    // Approving the plan approves its proposals: permanent ones join the Vault's standing staff.
    const groups = project.teams.filter(t => t.proposed && t.keep === 'permanent');
    const people = (project.staff ?? []).filter(e => e.proposed && e.keep === 'permanent');
    if (this.deps.home && (groups.length || people.length)) {
      await this.deps.home.add(groups.map(({ id, name, focus }) => ({ id, name, focus })), people.map(({ proposed, keep, reason, ...employee }) => employee));
      for (const item of [...groups, ...people]) item.proposed = false;
      this.deps.onEvent({ type: 'message', from: 'main', title: '상설 직원 추가', text: [...groups.map(g => `팀 ${g.name}`), ...people.map(e => `${e.name} (${e.role})`)].join(', ') });
    }
    project.status = 'running';
    project.error = undefined;
    // A task interrupted by a stop starts over; one waiting for a decision picks the question up again.
    for (const t of project.tasks) if (t.status === 'in_progress' || t.status === 'review' || t.status === 'waiting_user') t.status = 'pending';
    await this.publish();
    const limit = Math.max(1, this.deps.maxParallel ?? DEFAULT_PARALLEL);
    const active = new Map<string, Promise<void>>();
    const inner = new AbortController();
    const stopAll = () => inner.abort();
    signal.addEventListener('abort', stopAll, { once: true });
    let failure: unknown;
    try {
      for (;;) {
        if (signal.aborted) { await Promise.allSettled(active.values()); throw new Error('stopped'); }
        for (const t of unreachable(project)) {
          t.status = 'skipped';
          t.reviews.push({ verdict: 'blocked', feedback: '선행 Task가 완료되지 못해 진행하지 않았습니다', at: new Date().toISOString() });
        }
        // Start what is ready, up to the limit; then wait for any running task to end.
        for (const task of readyTasks(project)) {
          if (active.size >= limit || failure) break;
          active.set(task.id, this.runTask(task, inner.signal).catch(error => {
            // One task's Manager failing ends the run: the others stop too.
            failure ??= error;
            inner.abort();
          }).finally(() => active.delete(task.id)));
        }
        if (!active.size) break;
        await Promise.race(active.values());
        if (failure) { await Promise.allSettled(active.values()); throw failure; }
      }
      project.status = 'reviewing';
      await this.publish();
      const result = await sendWithRetry(this.deps.gateway, { role: 'main', taskId: project.id }, { system: mainSystem(), messages: [{ role: 'user', content: [{ type: 'text', text: finalRequest(project) }] }] }, signal, this.retry);
      project.report = result.response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim();
      this.deps.onEvent({ type: 'message', from: 'main', title: '최종 보고', text: project.report, model: `${result.response.provider}:${result.response.model}`, final: true });
      // Knowledge Integration (CONCEPT): the project is not over until what it taught is in the Library.
      if (this.deps.library && project.tasks.some(t => t.status === 'done')) {
        try {
          const { value: knowledge } = await this.ask('main', mainSystem(), [{ role: 'user', content: [{ type: 'text', text: knowledgeRequest(project) }] }], parseKnowledge, signal);
          project.knowledge = await recordProject(this.deps.library, project, knowledge);
          this.deps.onEvent({ type: 'message', from: 'main', title: 'Library에 기록', text: project.knowledge.join('\n') });
        } catch (error) {
          if (signal.aborted) throw error;
          this.deps.onEvent({ type: 'message', from: 'main', title: 'Library에 기록하지 못했습니다', text: String((error as Error).message ?? error) });
        }
      }
      project.status = 'done';
    } catch (error) {
      if (signal.aborted) project.status = 'stopped';
      else { project.status = 'failed'; project.error = String((error as Error).message ?? error); }
      // A task cut short starts over when the project goes on.
      for (const t of project.tasks) if (t.status === 'in_progress' || t.status === 'review') t.status = 'pending';
      // A task still waiting for the user keeps waiting: its agenda stays open.
    } finally {
      signal.removeEventListener('abort', stopAll);
    }
    await this.publish();
    return project;
  }

  private async runTask(task: BoardTask, signal: AbortSignal): Promise<void> {
    const project = this.project!;
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    await this.publish();
    const manager = managerFor(project, task), worker = workerFor(project, task);
    const managerPrompt = managerSystem(manager ? identity(manager, project.teams.find(t => t.id === task.team)) : undefined);
    const at = async (status: 'started' | 'working' | 'review' | 'done' | 'blocked') => {
      await Promise.all([worker?.id, manager?.id].map(employee => this.deps.home?.setState({ employee: employee ?? '', project: project.id, task: task.id, status })));
    };
    await at('started');
    const asked = (project.agendas ?? []).filter(a => a.taskId === task.id);
    // A question to the user still open from before a restart: the task picks up where it stopped.
    const pending = asked.find(a => !a.applied);
    let difficulty: Difficulty;
    if (pending && task.brief && task.difficulty) difficulty = task.difficulty;
    else {
      const brief = await this.ask('manager', managerPrompt, [{ role: 'user', content: [{ type: 'text', text: briefRequest(project, task) }] }], parseBrief, signal, task.id);
      task.brief = brief.value.instructions;
      task.difficulty = difficulty = brief.value.difficulty;
      this.deps.onEvent({ type: 'message', from: 'manager', taskId: task.id, title: `${manager ? `${manager.name} → ${worker?.name ?? 'Worker'} · ` : ''}${task.title} · Worker 지시 (난이도 ${difficulty})`, text: brief.value.instructions, model: brief.model, difficulty });
      await this.publish();
    }

    let instruction = workerBrief(project, task);
    let escalations = asked.length;
    // Waits for the user's decision on the agenda; returns the instruction to go on with, or null when the user said not to do it.
    const awaitDecision = async (agenda: Agenda): Promise<string | null> => {
      task.status = 'waiting_user';
      await this.publish();
      await at('blocked');
      await this.decision(agenda, signal);
      if (signal.aborted) throw new Error('stopped');
      agenda.applied = true;
      task.reviews.push({ verdict: 'decided', feedback: decisionText(agenda), at: new Date().toISOString() });
      if (agenda.decision!.kind === 'reject') {
        task.status = 'blocked';
        task.result = { summary: `사용자가 진행하지 않기로 했습니다: ${agenda.title}${agenda.decision!.note ? ` (${agenda.decision!.note})` : ''}`, verification: 'Meeting Room 결정' };
        task.finishedAt = new Date().toISOString();
        await at('blocked');
        await this.publish();
        return null;
      }
      await this.publish();
      return `Your Manager put a question to the user: "${agenda.title}". ${decisionText(agenda)}\nGo on with the task accordingly: do what the decision calls for, verify the acceptance criteria again, and finish with an updated summary.`;
    };
    let revision = false;
    if (pending) {
      const next = await awaitDecision(pending);
      if (next === null) return;
      instruction = next; revision = true;
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      task.attempts = attempt;
      task.status = 'in_progress';
      await this.publish();
      await at('working');
      const { outcome, evidence, output } = await this.deps.work(task, instruction, difficulty, signal, revision || attempt > 1);
      revision = false;
      if (signal.aborted) throw new Error('stopped');
      if (output !== undefined) task.output = output.slice(0, 60000);
      task.status = 'review';
      await this.publish();
      const history = task.reviews.length ? `\nEarlier reviews:\n${task.reviews.map((r, i) => `${i + 1}. ${r.verdict}: ${r.feedback}`).join('\n')}\n` : '';
      const outcomeText = outcome.status === 'finished' ? `Worker's summary: ${outcome.summary}` : outcome.status === 'stopped' ? `The Worker stopped early: ${outcome.detail}` : `The Worker failed: ${outcome.error}`;
      await at('review');
      const review = await this.ask('manager', managerPrompt, [{ role: 'user', content: [{ type: 'text', text: reviewRequest(project, task, `${outcomeText}\n${history}\n${evidence}`, attempt, MAX_ATTEMPTS, escalations < MAX_ESCALATIONS) }] }], parseReview, signal, task.id);
      if (review.value.verdict === 'escalate' && review.value.agenda && escalations < MAX_ESCALATIONS) {
        escalations++;
        task.reviews.push({ verdict: 'escalate', feedback: review.value.agenda.title, at: new Date().toISOString() });
        const agenda = await this.raise('manager', task.id, review.value.agenda, review.model);
        const next = await awaitDecision(agenda);
        if (next === null) return;
        instruction = next; revision = true;
        // The decision does not use up a try.
        attempt--;
        continue;
      }
      let verdict = review.value.verdict === 'escalate' ? 'blocked' as const : review.value.verdict;
      // No tries left: a task that still needs work is blocked, not quietly accepted.
      if (verdict === 'revise' && attempt >= MAX_ATTEMPTS) verdict = 'blocked';
      task.reviews.push({ verdict, feedback: review.value.feedback, at: new Date().toISOString() });
      const label = { accept: '통과', revise: '수정 요청', blocked: '진행 불가' }[verdict];
      this.deps.onEvent({ type: 'message', from: 'manager', taskId: task.id, title: `${manager ? `${manager.name} · ` : ''}${task.title} · 검토: ${label}`, text: verdict === 'accept' ? review.value.summary : review.value.feedback || review.value.summary, model: review.model, difficulty: task.difficulty });
      if (verdict !== 'revise') {
        task.status = verdict === 'accept' ? 'done' : 'blocked';
        await at(task.status);
        await this.deps.desk?.checkpoint(project.id, task.id, worker?.id ?? null, 'final', `${label}: ${review.value.summary}`).catch(() => {});
        task.result = { summary: review.value.summary, verification: review.value.verification };
        task.finishedAt = new Date().toISOString();
        await this.publish();
        return;
      }
      instruction = `Your Manager reviewed the work and asks for changes (attempt ${attempt + 1} of ${MAX_ATTEMPTS}):\n${review.value.feedback}\n\n${task.where === 'text' ? 'Fix this and finish again with the complete, updated deliverable and summary.' : 'Fix this, verify the acceptance criteria again, commit, and finish with an updated summary.'}`;
    }
  }

}
