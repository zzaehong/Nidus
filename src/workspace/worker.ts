// One Worker on one task: model calls through the Model Gateway (role "worker", the difficulty
// the instructor chose), tools in the workspace VM, until the model calls finish, the user
// stops it or a limit is reached. Every step is reported as an event for the app.
// A follow-up instruction continues the same conversation and workspace.
import type { ContentBlock, Message, ToolCallBlock, ToolSpec } from '../gateway/contract.js';
import type { Difficulty } from '../gateway/assignment.js';
import type { CallTarget, GatewayRequest, GatewayResult } from '../gateway/gateway.js';
import type { RequestOptions } from '../types.js';
import type { ToolOutcome } from './tools.js';
import { workerSystem } from '../office/roles.js';
import { DEFAULT_COMPACT, SUMMARY_SYSTEM, applySummary, clearOldResults, conversationChars, summaryCut, transcript, type CompactLimits } from './compact.js';

/** The tools a Worker gets: the workspace VM's (WorkerTools) or the desk's (DeskTools). */
export interface WorkerToolSet {
  readonly specs: ToolSpec[];
  run(call: ToolCallBlock, signal?: AbortSignal): Promise<ToolOutcome>;
}

export interface WorkerGateway {
  send(target: CallTarget, request: GatewayRequest, options?: RequestOptions): Promise<GatewayResult>;
}

export interface WorkerLimits { modelCalls: number; toolCalls: number; ms: number }
/** Safety valves against a runaway loop, not work budgets: no time limit (ms 0); the user stops it. */
export const DEFAULT_LIMITS: WorkerLimits = { modelCalls: 200, toolCalls: 600, ms: 0 };

export type WorkerEvent =
  | { type: 'instruction'; text: string }
  | { type: 'model'; text: string; provider: string; model: string; costUSD: string | null; inputTokens: number; outputTokens: number; warnings: string[] }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean; ms: number }
  | { type: 'retry'; attempt: number; error: string; waitMs: number }
  /** The conversation was made smaller: old tool results cleared, or the start summarized. */
  | { type: 'compacted'; how: 'cleared' | 'summarized'; beforeChars: number; afterChars: number; model?: string }
  | { type: 'finished'; summary: string }
  | { type: 'stopped'; reason: 'user' | 'limit'; detail: string }
  | { type: 'failed'; error: string };

export type WorkerOutcome = { status: 'finished'; summary: string } | { status: 'stopped'; reason: 'user' | 'limit'; detail: string } | { status: 'failed'; error: string };

/** Errors worth another try: the provider or the network, not the request itself. */
const TRANSIENT = new Set(['provider_error', 'rate_limit', 'network', 'timeout']);
/** Errors of one model (missing, unsupported, out of quota): another candidate may well work. */
const MODEL_FAULT = new Set(['not_found', 'unsupported', 'quota', 'invalid_response']);
export const RETRY_WAITS = [5_000, 15_000];
/** Rate limits pass after a while: wait longer (about five minutes in all) before giving up. */
export const RATE_LIMIT_WAITS = [15_000, 30_000, 60_000, 90_000, 120_000];
/** How long a rate-limited model is passed over when its slot has another candidate. */
export const COOLDOWN_MS = 90_000;
/** Models that just hit a rate limit, shared by every caller in this process (Main, Managers, Workers). */
const cooling = new Map<string, number>();

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export interface RetryPolicy { waits?: number[]; rateLimitWaits?: number[]; cooldownMs?: number }

/**
 * One model call through the Gateway, tried again on transient provider errors. A model that
 * failed that way (rate limit, server error, network, timeout) cools down and the next candidate
 * of the same slot is used at once; only when there is none does the call wait (longer for rate
 * limits). Free endpoints fail often; a slot with candidates from two providers keeps going.
 */
export async function sendWithRetry(gateway: WorkerGateway, target: CallTarget, request: GatewayRequest, signal: AbortSignal, policy: RetryPolicy | number[] = {}, onRetry?: (attempt: number, error: string, waitMs: number) => void): Promise<GatewayResult> {
  const { waits = RETRY_WAITS, rateLimitWaits = RATE_LIMIT_WAITS, cooldownMs = COOLDOWN_MS } = Array.isArray(policy) ? { waits: policy, rateLimitWaits: policy } : policy;
  let waited = 0, rateWaited = 0, switches = 0;
  for (let attempt = 1; ; attempt++) {
    const now = Date.now();
    const avoid = [...cooling].filter(([, until]) => until > now).map(([ref]) => ref);
    try {
      // Slow providers take minutes for a long context, but a hung one should not hold the task.
      return await gateway.send({ ...target, ...(avoid.length ? { avoid } : {}) }, request, { signal, timeoutMs: 300_000 });
    } catch (error: any) {
      if (signal.aborted || !(TRANSIENT.has(error?.code) || MODEL_FAULT.has(error?.code))) throw error;
      const message = String(error.message ?? error);
      const ref: string | undefined = error.modelRef;
      // A model not yet known to be failing: pass it over and try another candidate now.
      if (ref && !avoid.includes(ref) && switches < 8) {
        cooling.set(ref, Date.now() + cooldownMs);
        switches++;
        onRetry?.(attempt, `${message} (${ref} 잠시 쉬게 하고 다른 후보로)`, 0);
        continue;
      }
      if (ref) cooling.set(ref, Date.now() + cooldownMs);
      // Waiting does not fix a model that is missing or unsupported.
      if (!TRANSIENT.has(error.code)) throw error;
      if (error.code === 'rate_limit') {
        if (rateWaited >= rateLimitWaits.length) throw error;
        const wait = rateLimitWaits[rateWaited++]!;
        onRetry?.(attempt, message, wait);
        await pause(wait, signal);
      } else {
        if (waited >= waits.length) throw error;
        const wait = waits[waited++]!;
        onRetry?.(attempt, message, wait);
        await pause(wait, signal);
      }
      if (signal.aborted) throw error;
    }
  }
}

/** Test seam: forget which models are cooling down. */
export function resetCooling(): void { cooling.clear(); }

export class WorkerRun {
  readonly messages: Message[] = [];
  private modelCalls = 0;
  private toolCalls = 0;
  /** Every instruction given, oldest first: a summary must not lose them. */
  private readonly given: string[] = [];
  /** After a failed summary, calls to wait before trying again. */
  private summaryBackoff = 0;
  /** Conversation length right after the last summary: the next waits for new turns. */
  private summarizedAt = 0;

  constructor(
    private readonly gateway: WorkerGateway,
    private readonly tools: WorkerToolSet,
    private readonly options: { task: string; difficulty: Difficulty; system?: string; compact?: Partial<CompactLimits> | false; limits?: Partial<WorkerLimits>; onEvent?: (event: WorkerEvent) => void; now?: () => number; retryWaits?: number[] },
  ) {}

  private emit(event: WorkerEvent): void { this.options.onEvent?.(event); }

  private call(signal: AbortSignal): Promise<GatewayResult> {
    return sendWithRetry(this.gateway,
      { role: 'worker', difficulty: this.options.difficulty, taskId: this.options.task },
      { system: this.options.system ?? workerSystem('vm', this.options.task), messages: this.messages, tools: this.tools.specs },
      signal, this.options.retryWaits ? { waits: this.options.retryWaits, rateLimitWaits: this.options.retryWaits } : {},
      (attempt, error, waitMs) => this.emit({ type: 'retry', attempt, error, waitMs }));
  }

  /** Keeps the conversation small before a model call (see compact.ts). Never fails the run. */
  private async compact(signal: AbortSignal): Promise<void> {
    if (this.options.compact === false) return;
    const limits = { ...DEFAULT_COMPACT, ...this.options.compact };
    const before = conversationChars(this.messages);
    if (clearOldResults(this.messages, limits)) {
      this.emit({ type: 'compacted', how: 'cleared', beforeChars: before, afterChars: conversationChars(this.messages) });
    }
    const size = conversationChars(this.messages);
    if (size <= limits.summarizeAboveChars) return;
    if (this.summaryBackoff > 0) { this.summaryBackoff--; return; }
    if (this.summarizedAt && this.messages.length < this.summarizedAt + 4) return;
    const cut = summaryCut(this.messages, limits.keepMessages);
    if (cut === null) return;
    try {
      const result = await sendWithRetry(this.gateway,
        { role: 'worker', difficulty: this.options.difficulty, taskId: this.options.task },
        { system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: `The Worker's conversation so far:\n\n${transcript(this.messages.slice(0, cut))}\n\nWrite the summary now.` }] }], maxOutputTokens: 4000 },
        signal, this.options.retryWaits ? { waits: this.options.retryWaits, rateLimitWaits: this.options.retryWaits } : {});
      const summary = result.response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!summary) throw new Error('empty summary');
      // Instructions still in the kept turns stay there; the earlier ones go into the header.
      const kept = new Set(this.messages.slice(cut).flatMap(m => m.role === 'user' ? m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text) : []));
      applySummary(this.messages, cut, summary.slice(0, 10_000), this.given.filter(text => !kept.has(text)));
      this.summarizedAt = this.messages.length;
      this.emit({ type: 'compacted', how: 'summarized', beforeChars: size, afterChars: conversationChars(this.messages), model: result.response.model });
    } catch {
      // Not worth stopping the work for: go on with the larger conversation, try again later.
      this.summaryBackoff = 5;
    }
  }

  /** Gives an instruction (the first, or a follow-up in the same conversation) and works until done. */
  async run(instruction: string, signal: AbortSignal): Promise<WorkerOutcome> {
    const limits = { ...DEFAULT_LIMITS, ...this.options.limits };
    const now = this.options.now ?? Date.now;
    const started = now();
    // Counts are per instruction: a follow-up gets a full budget again.
    this.modelCalls = 0; this.toolCalls = 0;
    this.messages.push({ role: 'user', content: [{ type: 'text', text: instruction }] });
    this.given.push(instruction);
    this.emit({ type: 'instruction', text: instruction });
    const stop = (reason: 'user' | 'limit', detail: string): WorkerOutcome => { this.emit({ type: 'stopped', reason, detail }); return { status: 'stopped', reason, detail }; };
    try {
      for (;;) {
        if (signal.aborted) return stop('user', '사용자가 중지했습니다');
        if (this.modelCalls >= limits.modelCalls) return stop('limit', `모델 호출 ${limits.modelCalls}회 한도`);
        if (limits.ms > 0 && now() - started > limits.ms) return stop('limit', `실행 시간 ${Math.round(limits.ms / 60000)}분 한도`);
        this.modelCalls++;
        await this.compact(signal);
        if (signal.aborted) return stop('user', '사용자가 중지했습니다');
        const result = await this.call(signal);
        const { response } = result;
        const text = response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n').trim();
        this.emit({ type: 'model', text, provider: response.provider, model: response.model, costUSD: result.costUSD, inputTokens: response.usage.inputTokens ?? 0, outputTokens: response.usage.outputTokens ?? 0, warnings: result.warnings.map(w => w.message) });
        this.messages.push({ role: 'assistant', content: response.content });
        const calls = response.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
        if (!calls.length) {
          if (response.stopReason === 'max_tokens') {
            this.messages.push({ role: 'user', content: [{ type: 'text', text: 'Your output was cut off. Continue, using tools; call finish when done.' }] });
            continue;
          }
          // Answered in words without finish: that is the end of this instruction.
          const summary = text || '(모델이 요약 없이 끝냈습니다)';
          this.emit({ type: 'finished', summary });
          return { status: 'finished', summary };
        }
        const results: ContentBlock[] = [];
        let finished: string | undefined;
        for (const call of calls) {
          if (signal.aborted) { results.push({ type: 'tool_result', callId: call.id, content: 'Stopped by the user.', isError: true }); continue; }
          if (this.toolCalls >= limits.toolCalls) { results.push({ type: 'tool_result', callId: call.id, content: 'Tool call limit reached.', isError: true }); continue; }
          this.toolCalls++;
          this.emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
          const t = now();
          const outcome = await this.tools.run(call, signal);
          this.emit({ type: 'tool_result', id: call.id, name: call.name, content: outcome.content, isError: outcome.isError, ms: now() - t });
          results.push({ type: 'tool_result', callId: call.id, content: outcome.content, isError: outcome.isError });
          if (outcome.finish !== undefined) finished = outcome.finish;
        }
        this.messages.push({ role: 'user', content: results });
        if (finished !== undefined) { this.emit({ type: 'finished', summary: finished }); return { status: 'finished', summary: finished }; }
        if (signal.aborted) return stop('user', '사용자가 중지했습니다');
        if (this.toolCalls >= limits.toolCalls) return stop('limit', `도구 호출 ${limits.toolCalls}회 한도`);
      }
    } catch (error: any) {
      if (signal.aborted) return stop('user', '사용자가 중지했습니다');
      const message = String(error?.message ?? error);
      this.emit({ type: 'failed', error: message });
      return { status: 'failed', error: message };
    }
  }
}
