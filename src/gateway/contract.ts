// Provider-neutral request and response contract for the Model Gateway.
// See docs/architecture/STAGE1_MODEL_GATEWAY.md.
import { NidusError } from '../errors.js';
import type { ProviderId, Usage } from '../types.js';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
  /** Set when the call names an unknown tool or its input fails the tool's schema. Answer it with an error tool_result. */
  inputError?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  callId: string;
  content: string;
  isError: boolean;
}

/**
 * Opaque data a provider must receive back unchanged on the next request
 * (reasoning items, signatures). Sent only to the provider that produced it.
 */
export interface ProviderStateBlock {
  type: 'provider_state';
  provider: ProviderId;
  data: unknown;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ProviderStateBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type ToolChoice = 'auto' | 'required' | 'none';

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  maxOutputTokens?: number;
}

export type StopReason = 'end' | 'tool_call' | 'max_tokens' | 'refusal' | 'other';

export interface ModelResponse {
  provider: ProviderId;
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'done'; response: ModelResponse };

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_TOOLS = 64;
const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;
const callIdPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;

function invalid(message: string): never {
  throw new NidusError('invalid_request', message);
}

/** Convenience constructors for the common single-text cases. */
export const userText = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

export function textOf(content: ContentBlock[]): string {
  return content.filter((block): block is TextBlock => block.type === 'text').map(block => block.text).join('');
}

export function toolCallsOf(content: ContentBlock[]): ToolCallBlock[] {
  return content.filter((block): block is ToolCallBlock => block.type === 'tool_call');
}

function validateBlock(block: ContentBlock, role: Message['role']): void {
  if (!block || typeof block !== 'object') invalid('Message content must be an array of blocks.');
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') invalid('Text block requires a string.');
      return;
    case 'tool_call':
      if (role !== 'assistant') invalid('tool_call blocks belong to assistant messages.');
      if (typeof block.id !== 'string' || !callIdPattern.test(block.id)) invalid('Invalid tool call id.');
      if (typeof block.name !== 'string' || !block.name) invalid('Invalid tool call name.');
      return;
    case 'tool_result':
      if (role !== 'user') invalid('tool_result blocks belong to user messages.');
      if (typeof block.callId !== 'string' || !callIdPattern.test(block.callId)) invalid('Invalid tool result call id.');
      if (typeof block.content !== 'string' || typeof block.isError !== 'boolean') invalid('Invalid tool result.');
      return;
    case 'provider_state':
      if (role !== 'assistant') invalid('provider_state blocks belong to assistant messages.');
      if (typeof block.provider !== 'string') invalid('Invalid provider state.');
      return;
    default:
      invalid('Unknown content block type.');
  }
}

/** Structural validation shared by every wire format. Throws invalid_request. */
export function validateRequest(request: ModelRequest): void {
  if (!request || typeof request.model !== 'string' || !request.model.trim() || request.model.length > 512 || /[\r\n\0]/.test(request.model)) {
    invalid('A valid model ID is required.');
  }
  if (request.system !== undefined && typeof request.system !== 'string') invalid('System prompt must be a string.');
  if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) {
    invalid('maxOutputTokens must be a positive integer.');
  }
  if (request.toolChoice !== undefined && !['auto', 'required', 'none'].includes(request.toolChoice)) invalid('Invalid toolChoice.');
  if (!Array.isArray(request.messages) || request.messages.length === 0) invalid('At least one message is required.');
  if (request.messages[0]!.role !== 'user') invalid('The first message must be a user message.');

  const tools = request.tools ?? [];
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) invalid(`At most ${MAX_TOOLS} tools are allowed.`);
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !toolNamePattern.test(tool.name) || names.has(tool.name)) invalid('Tool names must be unique and match [a-zA-Z0-9_-]{1,64}.');
    if (typeof tool.description !== 'string') invalid('Tool description must be a string.');
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || tool.inputSchema.type !== 'object') invalid('Tool inputSchema must be an object schema.');
    names.add(tool.name);
  }
  if (request.toolChoice === 'required' && tools.length === 0) invalid('toolChoice "required" needs at least one tool.');

  // Every tool_result must answer a tool_call from the preceding assistant message.
  const called = new Set<string>();
  let pending = new Set<string>();
  for (const message of request.messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.content) || message.content.length === 0) {
      invalid('Each message needs a role and a nonempty content array.');
    }
    for (const block of message.content) validateBlock(block, message.role);
    if (message.role === 'assistant') {
      if (pending.size) invalid('Tool calls must be answered before the next assistant message.');
      for (const call of toolCallsOf(message.content)) {
        if (called.has(call.id)) invalid('Duplicate tool call id.');
        called.add(call.id);
        pending.add(call.id);
      }
    } else {
      const answered = new Set<string>();
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue;
        if (!pending.has(block.callId) || answered.has(block.callId)) invalid('tool_result does not match a pending tool call.');
        answered.add(block.callId);
      }
      if (answered.size !== pending.size) invalid('Every tool call needs a tool_result in the next user message.');
      pending = new Set();
    }
  }
  if (pending.size) invalid('The conversation ends with unanswered tool calls.');
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) invalid('Request exceeds the size limit.');
}
