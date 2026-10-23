import { BaseAdapter, baseModel, array, count, string, response, support, textBlocks, usage } from "./base.js";
import { optionalObject, HttpClient } from "../http.js";
import type { ChatRequest } from "../types.js";

export class AnthropicAdapter extends BaseAdapter {
  readonly id = "anthropic" as const;
  constructor(endpoint = "https://api.anthropic.com/v1", http?: HttpClient) { super(endpoint, http); }
  protected headers(key: string) { return { authorization: `Bearer ${key}`, "anthropic-version": "2026-10-21" }; }
  protected page(raw: Record<string, unknown>) {
    return { items: array(raw.data), next: raw.has_more === true ? string(raw.last_id) : null, parameter: "after_id" };
  }
  protected normalizeModel(raw: Record<string, unknown>) {
    const model = baseModel(this.id, string(raw.id), typeof raw.display_name === "string" ? raw.display_name : string(raw.id));
    const c = optionalObject(raw.capabilities);
    model.capabilities.chat = raw.lifecycle === "retired" ? "unsupported" : "supported";
    model.capabilitySource = "anthropic-models-and-messages-api";
    model.capabilities.vision = support(optionalObject(c.image_input).supported);
    model.capabilities.tools = support(optionalObject(c.tool_use).supported);
    model.limits.inputTokens = count(raw.max_input_tokens);
    model.limits.outputTokens = count(raw.max_tokens);
    model.details = { lifecycle: raw.lifecycle ?? null, capabilities: c };
    return model;
  }
  protected chatBody(r: ChatRequest) {
    return { path: "/messages", body: { model: r.model, messages: r.messages, system: r.system, max_tokens: r.maxOutputTokens ?? 1024, stream: false } };
  }
  protected normalizeChat(raw: Record<string, unknown>, model: string) {
    const u = optionalObject(raw.usage);
    // Anthropic reports uncached input separately from cache read/write tokens.
    const i = count(u.input_tokens);
    const input = i === null ? null : i + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0);
    return response(this.id, typeof raw.model === "string" ? raw.model : model, textBlocks(raw.content, "text"), raw.stop_reason, usage(u, input, u.output_tokens, undefined, u.cache_read_input_tokens, u.cache_creation_input_tokens));
  }
}
