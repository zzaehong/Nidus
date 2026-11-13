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

export interface ChatMessage { role: 'user' | 'main'; text: string; at: string; /** Main started a project with this instruction. */ project?: string; model?: string; isError?: boolean }

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
    '- If you are unsure what they want, ask in "reply" and leave "project" null.',
    '- Only one project at a time. When the context says a project is open, leave "project" null; tell them where it stands, and that changes to its plan go through the plan panel (answers and the note to Main), or that it must end or be closed before a new one.',
    'Answer with one JSON object only: {"reply": "what you say to the user, in their language", "project": null or "the instruction"}',
  ].join('\n');
}

/** Main's answer; an answer that is not the JSON asked for is taken as what it says. */
export function parseChat(answer: string): { reply: string; project: string | null } {
  try {
    const raw = extractJson(answer);
    const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
    const project = typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim().slice(0, 8000) : null;
    if (reply || project) return { reply: reply || '계획을 세우겠습니다.', project };
  } catch {}
  return { reply: answer.trim() || '(답이 비어 있습니다)', project: null };
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

  async clear(): Promise<void> {
    this.messages = [];
    await this.deps.store.save(this.messages).catch(() => {});
    this.deps.onChange(this.messages);
  }

  /** The user says something; Main answers, and may start a project. */
  async send(text: string, signal: AbortSignal): Promise<ChatMessage> {
    const said = text.trim().slice(0, 12000);
    if (!said) throw new Error('메시지가 비어 있습니다');
    if (this.busy) throw new Error('Main이 답하는 중입니다');
    this.busy = true;
    try {
      await this.push({ role: 'user', text: said, at: new Date().toISOString() });
      const recent = this.messages.filter(m => !m.isError).slice(-WINDOW);
      const context = await this.deps.context().catch(() => '');
      const conversation: Message[] = recent.map((m, i) => ({
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: [{ type: 'text' as const, text: m.role === 'main'
          ? JSON.stringify({ reply: m.text, project: m.project ?? null })
          // The context goes with the latest message only: it is what is true now.
          : i === recent.length - 1 && context ? `[Context now, not from the user]\n${context}\n\n[The user says]\n${m.text}` : m.text }],
      }));
      // A conversation must start with the user.
      while (conversation.length && conversation[0]!.role !== 'user') conversation.shift();
      const policy: RetryPolicy = this.deps.retryWaits ? { waits: this.deps.retryWaits, rateLimitWaits: this.deps.retryWaits } : {};
      let answer: ChatMessage;
      try {
        const result = await sendWithRetry(this.deps.gateway, { role: 'main', taskId: 'chat' }, { system: chatSystem(), messages: conversation }, signal, policy);
        const raw = result.response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
        const { reply, project } = parseChat(raw);
        answer = { role: 'main', text: reply, at: new Date().toISOString(), model: result.response.model };
        if (project) {
          const why = this.deps.blocked();
          if (why) answer.text = `${reply}\n\n(새 프로젝트를 시작하지 못했습니다: ${why})`;
          else { await this.deps.start(project); answer.project = project; }
        }
      } catch (error: any) {
        answer = { role: 'main', text: `답하지 못했습니다: ${String(error?.message ?? error)}`, at: new Date().toISOString(), isError: true };
      }
      await this.push(answer);
      return answer;
    } finally { this.busy = false; }
  }
}
