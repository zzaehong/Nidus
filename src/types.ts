import type { ToolModelRequest, ModelTurn } from './agent/model.js';
const everyProvider = ["openai", "anthropic", "gemini", "gemini-free", "gemini-paid", "deepseek", "nvidia", "groq", "mistral", "cloudflare"] as const;
export type ProviderId = typeof everyProvider[number];
/** The earlier provider dashboard: Gemini as one connection. */
export const providerIds: readonly ProviderId[] = ["openai", "anthropic", "gemini", "deepseek", "nvidia", "groq", "mistral", "cloudflare"];
/**
 * The Vault gateway: Gemini as two providers, Free and Paid. The single "gemini" connection from
 * before the split is moved to "gemini-free" (see gateway/gemini.ts) and is not offered here.
 */
export const gatewayProviderIds: readonly ProviderId[] = everyProvider.filter(id => id !== "gemini");
/** The Gemini API under any of its connections: same endpoint and wire format, different key and project. */
export type GeminiProvider = 'gemini' | 'gemini-free' | 'gemini-paid';
export const isGemini = (provider: string): provider is GeminiProvider => provider === 'gemini' || provider === 'gemini-free' || provider === 'gemini-paid';
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
export interface RequestOptions { consentToken?: string; onHeaders?: (headers: Record<string, string>) => void; signal?: AbortSignal; timeoutMs?: number }
export interface ProviderAdapter {
  readonly id: ProviderId;
  toolChat?(key: string, request: ToolModelRequest, options?: RequestOptions): Promise<ModelTurn>;
  listModels(key: string, options?: RequestOptions): Promise<Model[]>;
  getModel(key: string, model: string, options?: RequestOptions): Promise<Model>;
  chat(key: string, request: ChatRequest, options?: RequestOptions): Promise<ChatResponse>;
}
