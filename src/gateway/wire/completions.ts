// OpenAI-compatible Chat Completions, used by DeepSeek, Groq, Mistral, NVIDIA and Cloudflare.
import { createHash } from 'node:crypto';
import { array, object, optionalObject } from '../../http.js';
import { usage as normalizeUsage } from '../../adapters/base.js';
import type { ProviderId } from '../../types.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ContentBlock, type ModelRequest, type StopReason } from '../contract.js';
import { finish, newCallId, parseArguments, toolCall, type Wire } from './shared.js';

const stopReasons: Record<string, StopReason> = {
  stop: 'end',
  tool_calls: 'tool_call',
  function_call: 'tool_call',
  length: 'max_tokens',
  model_length: 'max_tokens',
  content_filter: 'refusal',
};

/** Mistral only accepts tool call ids of exactly nine alphanumeric characters. */
function callId(id: string, provider: ProviderId): string {
  if (provider !== 'mistral' || /^[a-zA-Z0-9]{9}$/.test(id)) return id;
  return createHash('sha256').update(id).digest('hex').slice(0, 9);
}

function messages(request: ModelRequest, provider: ProviderId): unknown[] {
  const result: unknown[] = [];
  if (request.system) result.push({ role: 'system', content: request.system });

  for (const message of request.messages) {
    if (message.role === 'user') {
      // Tool results are separate "tool" messages and must directly follow the assistant turn.
      let text = '';
      for (const block of message.content) {
        if (block.type === 'tool_result') result.push({ role: 'tool', tool_call_id: callId(block.callId, provider), content: block.content });
        else if (block.type === 'text') text += block.text;
      }
      if (text) result.push({ role: 'user', content: text });
      continue;
    }

    let text = '';
    const calls: unknown[] = [];
    let state: Record<string, unknown> = {};
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_call') {
        calls.push({ id: callId(block.id, provider), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      } else if (block.type === 'provider_state' && block.provider === provider) {
        state = { ...state, ...optionalObject(block.data) };
      }
    }
    if (!text && !calls.length) continue;
    result.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...state });
  }
  return result;
}

export const completionsWire: Wire = {
  build(request, provider) {
    const limit = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: messages(request, provider),
      stream: false,
      ...(provider === 'groq' ? { max_completion_tokens: limit } : { max_tokens: limit }),
    };
    if (request.tools?.length) {
      body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
      const choice = request.toolChoice ?? 'auto';
      body.tool_choice = provider === 'mistral' && choice === 'required' ? 'any' : choice;
    }
    return { path: '/chat/completions', body };
  },

  parse(raw, request, provider) {
    const u = optionalObject(raw.usage);
    const cached = u.prompt_cache_hit_tokens ?? optionalObject(u.prompt_tokens_details).cached_tokens;
    const usage = normalizeUsage(u, u.prompt_tokens, u.completion_tokens, u.total_tokens, cached, undefined, optionalObject(u.completion_tokens_details).reasoning_tokens);

    const choice = optionalObject(array(raw.choices ?? [])[0]);
    const message = optionalObject(choice.message);
    const content: ContentBlock[] = [];

    // Reasoning models expect their reasoning back while a tool exchange is in progress.
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      content.push({ type: 'provider_state', provider, data: { reasoning_content: message.reasoning_content } });
    }
    if (typeof message.content === 'string') {
      if (message.content) content.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content.map(object)) {
        if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
      }
    }
    for (const call of array(message.tool_calls ?? []).map(object)) {
      const fn = optionalObject(call.function);
      const { input, error } = parseArguments(fn.arguments);
      const id = typeof call.id === 'string' && call.id ? call.id : newCallId();
      content.push(toolCall(request, id, typeof fn.name === 'string' ? fn.name : '', input, error));
    }

    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
    const model = typeof raw.model === 'string' ? raw.model : request.model;
    return finish(provider, model, content, stopReasons[finishReason] ?? 'other', usage);
  },
};
