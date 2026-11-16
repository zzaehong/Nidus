import { randomUUID } from 'node:crypto';
import { NidusError } from '../../errors.js';
import type { ProviderId, Usage } from '../../types.js';
import { schemaError } from '../schema.js';
import type { ContentBlock, ModelRequest, ModelResponse, StopReason, ToolCallBlock } from '../contract.js';

/** Converts between the gateway contract and one provider API format. */
export interface Wire {
  build(request: ModelRequest, provider: ProviderId): { path: string; body: Record<string, unknown> };
  parse(raw: Record<string, unknown>, request: ModelRequest, provider: ProviderId): ModelResponse;
}

export function invalidResponse(message: string, usage?: Usage): never {
  const error = new NidusError('invalid_response', message);
  if (usage) error.usage = usage;
  throw error;
}

/** Tool arguments arrive as a JSON string from most providers. */
export function parseArguments(value: unknown): { input: unknown; error?: string } {
  if (typeof value !== 'string') return { input: value ?? {} };
  if (!value.trim()) return { input: {} };
  try {
    return { input: JSON.parse(value) };
  } catch {
    return { input: {}, error: 'input: arguments are not valid JSON' };
  }
}

/** Providers that omit call ids still need one the next request can refer to. */
export const newCallId = (): string => `call_${randomUUID().replaceAll('-', '')}`;

export function toolCall(request: ModelRequest, id: string, name: string, input: unknown, parseError?: string): ToolCallBlock {
  const tool = request.tools?.find(candidate => candidate.name === name);
  const inputError = parseError ?? (tool ? schemaError(input, tool.inputSchema) : `unknown tool "${name}"`);
  return { type: 'tool_call', id, name, input, ...(inputError ? { inputError } : {}) };
}

export function finish(provider: ProviderId, model: string, content: ContentBlock[], stopReason: StopReason, usage: Usage): ModelResponse {
  const hasCalls = content.some(block => block.type === 'tool_call');
  // A response that carries tool calls always needs tool results next,
  // whatever stop label the provider attached.
  const reason: StopReason = hasCalls && (stopReason === 'end' || stopReason === 'other') ? 'tool_call' : stopReason;
  return { provider, model, content, stopReason: reason, usage };
}
