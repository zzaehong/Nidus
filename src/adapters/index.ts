import { CompatibleAdapter } from './compatible.js';
import { CloudflareAdapter } from './cloudflare.js';
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { NidusError } from "../errors.js";
import { providerIds, type ProviderAdapter, type ProviderId } from "../types.js";
export { OpenAIAdapter, AnthropicAdapter, GeminiAdapter, DeepSeekAdapter, CompatibleAdapter, CloudflareAdapter };
export function providerId(value: string): ProviderId {
  if (!providerIds.includes(value as ProviderId)) throw new NidusError("invalid_request", `Provider must be one of: ${providerIds.join(", ")}.`);
  return value as ProviderId;
}
export function adapters(): Record<ProviderId, ProviderAdapter> { return { openai: new OpenAIAdapter(), anthropic: new AnthropicAdapter(), gemini: new GeminiAdapter(), deepseek: new DeepSeekAdapter(), nvidia: new CompatibleAdapter("nvidia"), groq: new CompatibleAdapter("groq"), mistral: new CompatibleAdapter("mistral"), cloudflare: new CloudflareAdapter() }; }
