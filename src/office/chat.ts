// Talking with Main directly. The user chats; Main answers itself when that is enough, and
// starts a project (the plan -> approval -> work flow) when the user wants work done.
//   .nidus/local/main-chat.json   the conversation (last 200 messages)
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../gateway/contract.js';
import { sendWithRetry, type RetryPolicy, type WorkerGateway } from '../workspace/worker.js';
import { extractJson } from './plan.js';
import { mainSystem } from './roles.js';

export interface ChatMessage { role: 'user' | 'main'; text: string; at: string; /** Main started a project with this instruction. */ project?: string; model?: string; /** With `model`, names the call ("provider:model") for the user's judgement. */ provider?: string; isError?: boolean }

const KEEP = 200;
/** Turns sent to the model with each message. */
const WINDOW = 24;

export class ChatStore {
  constructor(private readonly file: string) {}

  async load(): Promise<ChatMessage[]> {
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(list) ? list.filter(m => (m?.role === 'user' || m?.role === 'main') && typeof m.text === 'string') : [];
    } catch { return []; }
  }

  async save(messages: ChatMessage[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const pending = `${this.file}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(messages.slice(-KEEP), null, 2) + '\n');
    await rename(pending, this.file);
  }
}

export function chatSystem(): string {
  return [
    mainSystem(),
    '',
    'Right now the user is talking with you directly, in a chat.',
    '- Answer yourself when that is enough: a question, a discussion, advice, something about the team, the projects or the Library that you can answer from what this conversation and the context below show. Be direct and brief. Never claim work was done that was not, and do not invent the contents of files you have not been shown.',
    '- When the user wants work done (anything that needs Workers: research, reading or changing files, code, documents, the web), start a project: put a complete instruction in "project", self-contained, with everything agreed in this chat that the plan needs. In "reply" say that you are making a plan and that they will approve it before work starts. Do not start a project for something you can simply answer.',
    '- When the user asks to tidy, clean up or organize the Library (the team\'s lessons and decisions: merging duplicates, putting away what is not worth keeping), set "library" to "tidy" and say in "reply" that you are starting; the result follows as its own message. This is not a project.',
    '- When the user asks to connect, link, classify, file or organize their own notes in the Library, set "library" to "connect": the Library Manager reads the notes and makes suggestions (links between notes; moves if the user has set filing rules), which the user approves one by one in the panel beside this chat. Nothing changes before that. This is not a project either.',
    '- If you are unsure what they want, ask in "reply" and leave "project" null.',
    '- Only one project at a time. When the context says a project is open, leave "project" null; tell them where it stands, and that changes to its plan go through the plan panel (answers and the note to Main), or that it must end or be closed before a new one.',
    'Answer with one JSON object only: {"reply": "what you say to the user, in their language", "project": null or "the instruction", "library": null or "tidy" or "connect"}',
  ].join('\n');
}

/** Main's answer; an answer that is not the JSON asked for is taken as what it says. */
export function parseChat(answer: string): { reply: string; project: string | null; library: 'tidy' | 'connect' | null } {
  try {
    const raw = extractJson(answer);
    const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
    const project = typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim().slice(0, 8000) : null;
    const library = !project && (raw.library === 'tidy' || raw.library === 'connect') ? raw.library as 'tidy' | 'connect' : null;
    if (reply || project || library) return { reply: reply || (library === 'tidy' ? 'Library를 정리하겠습니다.' : library ? '노트를 살펴보고 제안을 만들겠습니다.' : '계획을 세우겠습니다.'), project, library };
  } catch {}
  return { reply: answer.trim() || '(답이 비어 있습니다)', project: null, library: null };
}

export interface MainChatDeps {
  gateway: WorkerGateway;
  store: ChatStore;
  /** What Main should know now: the open project, the staff, what the Library holds. */
  context(): Promise<string>;
  /** Whether a new project may start now; if not, why (shown to the user). */
  blocked(): string | null;
  /** Starts planning a project for this instruction. */
  start(instruction: string): Promise<void>;
  /** Starts tidying the Library (a Dream Sequence) in the background; its report comes as a note. Throws if it cannot start now. */
  tidy?(): void;
  /** Starts looking over the user's notes for links and moves to suggest, in the background. Throws if it cannot start now. */
  connect?(): void;
  onChange(messages: ChatMessage[]): void;
  retryWaits?: number[];
}

export class MainChat {
  messages: ChatMessage[] = [];
  private busy = false;

  constructor(private readonly deps: MainChatDeps) {}

  async load(): Promise<void> {
    this.messages = await this.deps.store.load();
    this.deps.onChange(this.messages);
  }

  private async push(message: ChatMessage): Promise<void> {
    this.messages.push(message);
    await this.deps.store.save(this.messages).catch(() => {});
    this.deps.onChange(this.messages);
  }

  /** Something Main says on its own: the report of work that ran beside the conversation. `by` names the model that wrote it, as "provider:model". */
  async note(text: string, isError = false, by?: string): Promise<ChatMessage> {
    const split = by?.indexOf(':') ?? -1;
    const who = by && split > 0 ? { provider: by.slice(0, split), model: by.slice(split + 1) } : {};
    const message: ChatMessage = { role: 'main', text, at: new Date().toISOString(), ...who, ...(isError ? { isError } : {}) };
    await this.push(message);
    return message;
  }

  async clear(): Promise<void> {
    this.messages = [];
    await this.deps.store.save(this.messages).catch(() => {});
    this.deps.onChange(this.messages);
  }

  /** The conversation as the model sees it: Main's consecutive messages as one turn, the context with the latest user message only. */
  private async conversation(closing?: string): Promise<Message[]> {
    // What Main said in a row (an answer, then a report of its own) is one turn for the model.
    const recent: ChatMessage[] = [];
    for (const m of this.messages.filter(m => !m.isError).slice(-WINDOW)) {
      const before = recent[recent.length - 1];
      if (m.role === 'main' && before?.role === 'main') recent[recent.length - 1] = { ...before, text: `${before.text}\n\n${m.text}`, project: before.project ?? m.project };
      else recent.push(m);
    }
    const context = await this.deps.context().catch(() => '');
    const conversation: Message[] = recent.map((m, i) => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: [{ type: 'text' as const, text: m.role === 'main'
        ? JSON.stringify({ reply: m.text, project: m.project ?? null, library: null })
        // The context goes with the latest message only: it is what is true now.
        : i === recent.length - 1 && !closing && context ? `[Context now, not from the user]\n${context}\n\n[The user says]\n${m.text}` : m.text }],
    }));
    // Something that happened, told to Main in the user's turn but not by the user.
    if (closing) conversation.push({ role: 'user', content: [{ type: 'text', text: `${context ? `[Context now, not from the user]\n${context}\n\n` : ''}${closing}` }] });
    // A conversation must start with the user.
    while (conversation.length && conversation[0]!.role !== 'user') conversation.shift();
    return conversation;
  }

  private get policy(): RetryPolicy { return this.deps.retryWaits ? { waits: this.deps.retryWaits, rateLimitWaits: this.deps.retryWaits } : {}; }

  /**
   * The project Main started for the user has ended: Main answers the user's request in the
   * conversation, from the results — the findings themselves, not a pointer to the task list.
   * Waits for a turn in progress; when Main cannot answer, the team's report is said as it is.
   */
  async conclude(brief: string, report: string, signal: AbortSignal): Promise<ChatMessage> {
    for (let waited = 0; this.busy && waited < 120_000 && !signal.aborted; waited += 500) await new Promise(r => setTimeout(r, 500));
    if (this.busy) return this.note(report, false);
    this.busy = true;
    try {
      const closing = `[The project you started for the user has ended. This is not the user speaking.]\n${brief}\n\nNow answer the user's request yourself, in the conversation's language. Give the substance: the findings, the result, the deliverable's content when it is text (restate or quote it; never tell the user to look it up elsewhere). Say plainly what was not done or could not be verified. Do not start a project or a library action: "project": null, "library": null.`;
      const conversation = await this.conversation(closing);
      let answer: ChatMessage;
      try {
        const result = await sendWithRetry(this.deps.gateway, { role: 'main', taskId: 'chat' }, { system: chatSystem(), messages: conversation }, signal, this.policy);
        const raw = result.response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
        answer = { role: 'main', text: parseChat(raw).reply, at: new Date().toISOString(), model: result.response.model, provider: result.response.provider };
      } catch (error: any) {
        answer = { role: 'main', text: `결과를 정리해 답하지 못했습니다 (${String(error?.message ?? error)}). 팀의 보고를 그대로 전합니다.\n\n${report}`, at: new Date().toISOString() };
      }
      await this.push(answer);
      return answer;
    } finally { this.busy = false; }
  }

  /** The user says something; Main answers, and may start a project. */
  async send(text: string, signal: AbortSignal): Promise<ChatMessage> {
    const said = text.trim().slice(0, 12000);
    if (!said) throw new Error('메시지가 비어 있습니다');
    if (this.busy) throw new Error('Main이 답하는 중입니다');
    this.busy = true;
    try {
      await this.push({ role: 'user', text: said, at: new Date().toISOString() });
      const conversation = await this.conversation();
      const policy = this.policy;
      let answer: ChatMessage;
      let wants: 'tidy' | 'connect' | null = null;
      try {
        const result = await sendWithRetry(this.deps.gateway, { role: 'main', taskId: 'chat' }, { system: chatSystem(), messages: conversation }, signal, policy);
        const raw = result.response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
        const { reply, project, library } = parseChat(raw);
        answer = { role: 'main', text: reply, at: new Date().toISOString(), model: result.response.model, provider: result.response.provider };
        if (project) {
          const why = this.deps.blocked();
          if (why) answer.text = `${reply}\n\n(새 프로젝트를 시작하지 못했습니다: ${why})`;
          else { await this.deps.start(project); answer.project = project; }
        }
        wants = library;
      } catch (error: any) {
        answer = { role: 'main', text: `답하지 못했습니다: ${String(error?.message ?? error)}`, at: new Date().toISOString(), isError: true };
      }
      await this.push(answer);
      // After the answer, so the report never comes before it.
      if (wants) {
        try {
          const start = wants === 'tidy' ? this.deps.tidy : this.deps.connect;
          if (!start) throw new Error('지금은 할 수 없습니다');
          start();
        } catch (error: any) { await this.note(`${wants === 'tidy' ? 'Library 정리' : '노트 살펴보기'}를 시작하지 못했습니다: ${String(error?.message ?? error)}`, true); }
      }
      return answer;
    } finally { this.busy = false; }
  }
}
