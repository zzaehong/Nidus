// OpenAI Responses API. https://platform.openai.com/docs/api-reference/responses
import { array, object, optionalObject, string } from '../../http.js';
import { usage as normalizeUsage } from '../../adapters/base.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ContentBlock, type ModelRequest, type StopReason } from '../contract.js';
import { finish, parseArguments, toolCall, type Wire } from './shared.js';

function inputItems(request: ModelRequest): unknown[] {
  const items: unknown[] = [];
  for (const message of request.messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) items.push({ role: message.role, content: block.text });
          break;
        case 'tool_call':
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
          break;
        case 'tool_result':
          items.push({ type: 'function_call_output', call_id: block.callId, output: block.content });
          break;
        case 'provider_state':
          // Reasoning items (with encrypted content) are replayed in place.
          if (block.provider === 'openai') items.push(block.data);
          break;
      }
    }
  }
  return items;
}

export const responsesWire: Wire = {
  build(request) {
    const body: Record<string, unknown> = {
      model: request.model,
      input: inputItems(request),
      max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Stateless: nothing is stored server-side, so reasoning comes back encrypted for replay.
      store: false,
      include: ['reasoning.encrypted_content'],
    };
    if (request.system) body.instructions = request.system;
    if (request.tools?.length) {
      body.tools = request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    return { path: '/responses', body };
  },

  parse(raw, request, provider) {
    const u = optionalObject(raw.usage);
    const usage = normalizeUsage(u, u.input_tokens, u.output_tokens, u.total_tokens,
      optionalObject(u.input_tokens_details).cached_tokens, undefined, optionalObject(u.output_tokens_details).reasoning_tokens);

    const content: ContentBlock[] = [];
    let refused = false;
    for (const item of array(raw.output ?? []).map(object)) {
      if (item.type === 'message') {
        for (const part of array(item.content ?? []).map(object)) {
          if (part.type === 'output_text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
          else if (part.type === 'refusal') {
            refused = true;
            if (typeof part.refusal === 'string') content.push({ type: 'text', text: part.refusal });
          }
        }
      } else if (item.type === 'function_call') {
        const { input, error } = parseArguments(item.arguments);
        content.push(toolCall(request, string(item.call_id), string(item.name), input, error));
      } else if (item.type === 'reasoning') {
        content.push({ type: 'provider_state', provider, data: item });
      }
    }

    let reason: StopReason = 'other';
    if (refused) reason = 'refusal';
    else if (raw.status === 'completed') reason = 'end';
    else if (raw.status === 'incomplete') {
      const why = optionalObject(raw.incomplete_details).reason;
      reason = why === 'max_output_tokens' ? 'max_tokens' : why === 'content_filter' ? 'refusal' : 'other';
    }
    const model = typeof raw.model === 'string' ? raw.model : request.model;
    return finish(provider, model, content, reason, usage);
  },
};
