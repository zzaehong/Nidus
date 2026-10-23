import { BaseAdapter, baseModel, object, array, string, response, textBlocks, usage } from "./base.js";
import { optionalObject, HttpClient } from "../http.js";
import type { ChatRequest } from "../types.js";

export class OpenAIAdapter extends BaseAdapter {
  readonly id = "openai" as const;
  constructor(endpoint = "https://api.openai.com/v1", http?: HttpClient) { super(endpoint, http); }
  protected headers(key: string) { return { authorization: `Bearer ${key}` }; }
  protected normalizeModel(raw: Record<string, unknown>) {
    const model = baseModel(this.id, string(raw.id));
    model.details = { owner: typeof raw.owned_by === "string" ? raw.owned_by : null, created: raw.created ?? null };
    // OpenAI Models API does not declare endpoint or capability compatibility.
    return model;
  }
  protected chatBody(r: ChatRequest) {
    return { path: "/responses", body: { model: r.model, input: r.messages, instructions: r.system, max_output_tokens: r.maxOutputTokens ?? 1024, store: false } };
  }
  protected normalizeChat(raw: Record<string, unknown>, model: string) {
    const text = array(raw.output).map(object).filter(item => item.type === "message").map(item => textBlocks(item.content, "output_text")).join("");
    const u = optionalObject(raw.usage);
    return response(this.id, typeof raw.model === "string" ? raw.model : model, text, raw.status, usage(u, u.input_tokens, u.output_tokens, u.total_tokens, optionalObject(u.input_tokens_details).cached_tokens, undefined, optionalObject(u.output_tokens_details).reasoning_tokens));
  }
}
