import { NidusError } from "../errors.js";
import { array, bounded, count, HttpClient, keyValue, object, string } from "../http.js";
import type { ChatRequest, ChatResponse, Model, ProviderAdapter, ProviderId, RequestOptions, Support, Usage } from "../types.js";

export function support(value: unknown): Support { return value === true ? "supported" : value === false ? "unsupported" : "unknown"; }
export function baseModel(provider: ProviderId, id: string, name = id): Model {
  return { provider, id, name, capabilities: { chat: "unknown", streaming: "unknown", tools: "unknown", vision: "unknown" }, capabilitySource: "models-api", limits: { inputTokens: null, outputTokens: null, contextTokens: null }, details: {} };
}
export function numericUsage(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => {
    if (count(v) !== null) return [[k, v]];
    if (v && typeof v === "object" && !Array.isArray(v)) return [[k, numericUsage(object(v))]];
    return [];
  }));
}
export function usage(raw: Record<string, unknown>, input: unknown, output: unknown, total: unknown, cached?: unknown, writes?: unknown, reasoning?: unknown): Usage {
  const i = count(input), o = count(output);
  return { inputTokens: i, outputTokens: o, totalTokens: count(total) ?? (i !== null && o !== null ? i + o : null), cachedInputTokens: count(cached), cacheWriteTokens: count(writes), reasoningTokens: count(reasoning), providerUsage: numericUsage(raw) };
}

export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  constructor(protected readonly endpoint: string, protected readonly http = new HttpClient()) {}
  protected abstract headers(key: string): Record<string, string>;
  protected abstract normalizeModel(raw: Record<string, unknown>): Model;
  protected abstract chatBody(request: ChatRequest): { path: string; body: unknown };
  protected abstract normalizeChat(raw: Record<string, unknown>, requestedModel: string): ChatResponse;
  protected page(raw: Record<string, unknown>): { items: unknown[]; next: string | null; parameter: string } {
    return { items: array(raw.data), next: null, parameter: "after_id" };
  }
  async listModels(key: string, options: RequestOptions = {}): Promise<Model[]> {
    const headers = this.headers(keyValue(key));
    return bounded(options, async signal => {
      const models = new Map<string, Model>(); const seen = new Set<string>();
      let cursor: string | null = null; let parameter = "";
      do {
        const url = new URL(`${this.endpoint}/models`);
        if (cursor) url.searchParams.set(parameter, cursor);
        const page = this.page(await this.http.json(url, headers, signal));
        for (const item of page.items) { const model = this.normalizeModel(object(item)); models.set(model.id, model); }
        cursor = page.next; parameter = page.parameter;
        if (cursor !== null) {
          if (!cursor || seen.has(cursor) || seen.size >= 1000) throw new NidusError("invalid_response", "Invalid or excessive model pagination; refresh was not saved.");
          seen.add(cursor);
        }
      } while (cursor !== null);
      return [...models.values()];
    });
  }
  async getModel(key: string, model: string, options: RequestOptions = {}): Promise<Model> {
    this.validateModelID(model);
    return bounded(options, async signal => this.normalizeModel(await this.http.json(`${this.endpoint}/models/${encodeURIComponent(model)}`, this.headers(keyValue(key)), signal)));
  }
  protected validateModelID(model: string): void {
    if (typeof model !== "string" || !model.trim() || model.length > 512 || /[\r\n\0]/.test(model)) throw new NidusError("invalid_request", "A valid model ID is required.");
  }
  async chat(key: string, request: ChatRequest, options: RequestOptions = {}): Promise<ChatResponse> {
    const headers = this.headers(keyValue(key));
    this.validateModelID(request.model);
    if (!Array.isArray(request.messages) || !request.messages.length || request.messages.some(m => !m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim())) throw new NidusError("invalid_request", "Nonempty user/assistant messages are required.");
    if (request.system !== undefined && typeof request.system !== "string") throw new NidusError("invalid_request", "System prompt must be a string.");
    if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) throw new NidusError("invalid_request", "maxOutputTokens must be a positive integer.");
    const { path, body } = this.chatBody(request);
    return bounded(options, async signal => this.normalizeChat(await this.http.json(`${this.endpoint}${path}`, headers, signal, body), request.model));
  }
}
export function textBlocks(value: unknown, type: string): string {
  return array(value).map(object).filter(p => p.type === type).map(p => typeof p.text === "string" ? p.text : "").join("");
}
export function response(provider: ProviderId, model: string, text: string, finish: unknown, tokens: Usage): ChatResponse {
  if (!text) throw new NidusError("provider_error", "Provider returned no text (blocked, refused, incomplete, or unsupported output).");
  return { provider, model, text, finishReason: typeof finish === "string" ? finish : null, usage: tokens };
}
export { array, count, object, string };
