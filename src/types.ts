export const providerIds = ["openai", "anthropic", "gemini", "deepseek", "nvidia", "groq", "mistral", "cloudflare"] as const;
export type ProviderId = typeof providerIds[number];
export type Support = "supported" | "unsupported" | "unknown";
export interface Model {
  provider: ProviderId;
  id: string;
  name: string;
  capabilities: { chat: Support; streaming: Support; tools: Support; vision: Support };
  capabilitySource: string;
  limits: { inputTokens: number | null; outputTokens: number | null; contextTokens: number | null };
  details: Record<string, unknown>;
}
export interface ChatRequest {
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  maxOutputTokens?: number;
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  providerUsage: Record<string, unknown>;
}
export interface ChatResponse {
  provider: ProviderId;
  model: string;
  text: string;
  finishReason: string | null;
  usage: Usage;
}
export interface RequestOptions { budgetException?: boolean; onHeaders?: (headers: Record<string, string>) => void; signal?: AbortSignal; timeoutMs?: number }
export interface ProviderAdapter {
  readonly id: ProviderId;
  listModels(key: string, options?: RequestOptions): Promise<Model[]>;
  getModel(key: string, model: string, options?: RequestOptions): Promise<Model>;
  chat(key: string, request: ChatRequest, options?: RequestOptions): Promise<ChatResponse>;
}
