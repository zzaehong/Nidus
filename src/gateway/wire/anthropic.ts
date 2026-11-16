// Anthropic Messages API. https://platform.claude.com/docs/en/api/messages
import { array, object, optionalObject, count, string } from '../../http.js';
import { usage as normalizeUsage } from '../../adapters/base.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ContentBlock, type StopReason } from '../contract.js';
import { finish, toolCall, type Wire } from './shared.js';

const stopReasons: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_call',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

/** Anthropic only accepts [a-zA-Z0-9_-] in tool ids; ids minted by other providers may not comply. */
const toolId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function wireBlock(block: ContentBlock): unknown[] {
  switch (block.type) {
    case 'text':
      // The API rejects empty text blocks.
      return block.text ? [{ type: 'text', text: block.text }] : [];
    case 'tool_call':
      return [{ type: 'tool_use', id: toolId(block.id), name: block.name, input: block.input ?? {} }];
    case 'tool_result':
      return [{ type: 'tool_result', tool_use_id: toolId(block.callId), content: block.content, is_error: block.isError }];
    case 'provider_state':
      // Thinking blocks go back unchanged and in place; other providers' state is dropped.
      return block.provider === 'anthropic' ? [block.data] : [];
  }
}

export const anthropicWire: Wire = {
  build(request) {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: request.messages.map(message => ({ role: message.role, content: message.content.flatMap(wireBlock) })),
    };
    if (request.system) body.system = request.system;
    if (request.tools?.length) {
      body.tools = request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
      // Current models reject forced tool use (tool_choice "any"), so "required"
      // is sent as "auto"; callers that must have a call say so in the prompt.
      body.tool_choice = { type: request.toolChoice === 'none' ? 'none' : 'auto' };
    }
    return { path: '/messages', body };
  },

  parse(raw, request, provider) {
    const u = optionalObject(raw.usage);
    // Anthropic reports uncached input separately from cache reads and writes.
    const uncached = count(u.input_tokens);
    const input = uncached === null ? null : uncached + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0);
    const usage = normalizeUsage(u, input, u.output_tokens, undefined, u.cache_read_input_tokens, u.cache_creation_input_tokens);

    const content: ContentBlock[] = [];
    for (const block of array(raw.content ?? []).map(object)) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' });
      } else if (block.type === 'tool_use') {
        content.push(toolCall(request, string(block.id), string(block.name), block.input ?? {}));
      } else {
        content.push({ type: 'provider_state', provider, data: block });
      }
    }
    const model = typeof raw.model === 'string' ? raw.model : request.model;
    const reason = typeof raw.stop_reason === 'string' ? stopReasons[raw.stop_reason] ?? 'other' : 'other';
    return finish(provider, model, content, reason, usage);
  },
};
