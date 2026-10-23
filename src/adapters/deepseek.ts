import { BaseAdapter, baseModel, array, object, count, string, response, usage } from "./base.js";
import { optionalObject, HttpClient } from "../http.js";
import { NidusError } from "../errors.js";
import type { ChatRequest, RequestOptions } from "../types.js";

export class DeepSeekAdapter extends BaseAdapter {
  readonly id = "deepseek" as const;
  constructor(endpoint = "https://api.deepseek.com", http?: HttpClient) { super(endpoint, http); }
  protected headers(key: string) { return { authorization: `Bearer ${key}` }; }
  protected normalizeModel(raw: Record<string, unknown>) {
    const model = baseModel(this.id, string(raw.id), typeof raw.name === "string" ? raw.name : string(raw.id));
    if (Array.isArray(raw.input_modalities) && Array.isArray(raw.output_modalities)) {
      model.capabilities.chat = raw.input_modalities.includes("text") && raw.output_modalities.includes("text") ? "supported" : "unsupported";
      model.capabilities.vision = raw.input_modalities.includes("image") ? "supported" : "unsupported";
    }
    model.limits.contextTokens = count(raw.context_window);
    model.limits.outputTokens = count(raw.max_output_tokens);
    model.details = { inputModalities: raw.input_modalities ?? null, outputModalities: raw.output_modalities ?? null, apiCapabilities: raw.api_capabilities ?? null, effort: raw.effort ?? null };
    return model;
  }
  async getModel(key: string, model: string, options: RequestOptions = {}) {
    this.validateModelID(model);
    // DeepSeek documents no separate model-detail endpoint.
    const match = (await this.listModels(key, options)).find(m => m.id === model);
    if (!match) throw new NidusError("not_found", "Model was not returned by the provider.");
    return match;
  }
  protected chatBody(r: ChatRequest) {
    return { path: "/chat/completions", body: { model: r.model, messages: [...(r.system ? [{ role: "system", content: r.system }] : []), ...r.messages], max_tokens: r.maxOutputTokens ?? 1024, stream: false } };
  }
  protected normalizeChat(raw: Record<string, unknown>, model: string) {
    const choice = object(array(raw.choices)[0]); const message = object(choice.message);
    const u = optionalObject(raw.usage);
    return response(this.id, typeof raw.model === "string" ? raw.model : model, typeof message.content === "string" ? message.content : "", choice.finish_reason, usage(u, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.prompt_cache_hit_tokens ?? optionalObject(u.prompt_tokens_details).cached_tokens, undefined, optionalObject(u.completion_tokens_details).reasoning_tokens));
  }
}
