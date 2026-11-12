// Gemini generateContent. https://ai.google.dev/api/generate-content
import { array, object, optionalObject, count } from '../../http.js';
import { usage as normalizeUsage } from '../../adapters/base.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ContentBlock, type ModelRequest, type StopReason } from '../contract.js';
import { finish, newCallId, toolCall, type Wire } from './shared.js';

const stopReasons: Record<string, StopReason> = {
  STOP: 'end',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
};
/** Gemini's documented thought signature for function calls it did not generate. */
export const FOREIGN_CALL_SIGNATURE = 'skip_thought_signature_validator';
const toolModes = { auto: 'AUTO', required: 'ANY', none: 'NONE' } as const;

function contents(request: ModelRequest): unknown[] {
  // functionResponse is matched by tool name, which the result block does not carry.
  const toolNames = new Map<string, string>();
  const result: unknown[] = [];
  for (const message of request.messages) {
    const parts: Record<string, unknown>[] = [];
    // A thought signature belongs to the part that follows it.
    let signature: unknown;
    // Gemini 3 refuses function calls without a signature. Calls another provider's model made
    // (the Gateway switched models mid-conversation) have none: the first call of such a turn
    // carries the value Gemini documents for calls it did not produce.
    let foreign = message.role === 'assistant' && !message.content.some(b => b.type === 'provider_state' && b.provider === 'gemini');
    const push = (part: Record<string, unknown>) => {
      parts.push(signature === undefined ? part : { ...part, thoughtSignature: signature });
      signature = undefined;
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) push({ text: block.text });
          break;
        case 'tool_call':
          toolNames.set(block.id, block.name);
          if (foreign && signature === undefined) { signature = FOREIGN_CALL_SIGNATURE; foreign = false; }
          push({ functionCall: { name: block.name, args: block.input ?? {} } });
          break;
        case 'tool_result':
          push({ functionResponse: { name: toolNames.get(block.callId) ?? 'unknown', response: block.isError ? { error: block.content } : { result: block.content } } });
          break;
        case 'provider_state':
          if (block.provider === 'gemini') signature = optionalObject(block.data).thoughtSignature;
          break;
      }
    }
    if (parts.length) result.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return result;
}

export const geminiWire: Wire = {
  build(request) {
    const body: Record<string, unknown> = {
      contents: contents(request),
      generationConfig: { maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    if (request.tools?.length) {
      body.tools = [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }];
      body.toolConfig = { functionCallingConfig: { mode: toolModes[request.toolChoice ?? 'auto'] } };
    }
    return { path: `/models/${encodeURIComponent(request.model)}:generateContent`, body };
  },

  parse(raw, request, provider) {
    const u = optionalObject(raw.usageMetadata);
    const visible = count(u.candidatesTokenCount);
    // Thinking tokens are billed as output but reported separately.
    const output = visible === null ? null : visible + (count(u.thoughtsTokenCount) ?? 0);
    const usage = normalizeUsage(u, u.promptTokenCount, output, u.totalTokenCount, u.cachedContentTokenCount, undefined, u.thoughtsTokenCount);

    const candidate = optionalObject(array(raw.candidates ?? [])[0]);
    const content: ContentBlock[] = [];
    for (const part of array(optionalObject(candidate.content).parts ?? []).map(object)) {
      if (part.thought === true) continue;
      const isCall = part.functionCall !== undefined;
      const isText = typeof part.text === 'string';
      if (!isCall && !isText) continue;
      if (typeof part.thoughtSignature === 'string') {
        content.push({ type: 'provider_state', provider, data: { thoughtSignature: part.thoughtSignature } });
      }
      if (isCall) {
        const call = object(part.functionCall);
        content.push(toolCall(request, newCallId(), typeof call.name === 'string' ? call.name : '', call.args ?? {}));
      } else {
        content.push({ type: 'text', text: part.text as string });
      }
    }

    const blocked = optionalObject(raw.promptFeedback).blockReason !== undefined;
    const finishReason = typeof candidate.finishReason === 'string' ? candidate.finishReason : '';
    const reason: StopReason = blocked ? 'refusal' : stopReasons[finishReason] ?? 'other';
    const model = typeof raw.modelVersion === 'string' ? raw.modelVersion : request.model;
    return finish(provider, model, content, reason, usage);
  },
};
