import { NidusError } from "./errors.js";
import type { ChatRequest, Model, ProviderId } from "./types.js";

// Exact, officially documented IDs only. Discovered metadata takes precedence.
export function effectiveLimits(provider: ProviderId, id: string, model?: Model): Model["limits"] {
  const fallback = provider === "openai" && ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", "gpt-4.1-nano"].includes(id)
    ? { inputTokens: null, contextTokens: 1_047_576, outputTokens: 32_768 }
    : provider === "deepseek" && ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(id)
      ? { inputTokens: null, contextTokens: 1_000_000, outputTokens: 384_000 }
      : { inputTokens: null, contextTokens: null, outputTokens: null };
  const positive = (n: number | null | undefined) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
  return { inputTokens: positive(model?.limits.inputTokens) ?? fallback.inputTokens,
    contextTokens: positive(model?.limits.contextTokens) ?? fallback.contextTokens,
    outputTokens: positive(model?.limits.outputTokens) ?? fallback.outputTokens };
}
export function assessContext(provider: ProviderId, request: ChatRequest, model?: Model) {
  if (!request || typeof request.model !== "string" || !Array.isArray(request.messages) || !request.messages.length ||
      request.messages.some(m => !m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim()) ||
      (request.system !== undefined && typeof request.system !== "string") ||
      (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)))
    throw new NidusError("invalid_request", "Invalid text conversation or output budget.");
  // Conservative UTF-8 byte estimate, NOT exact tokenization or a guaranteed upper bound.
  const inputTokens = 64 + Buffer.byteLength(request.system ?? "", "utf8") +
    request.messages.reduce((sum, m) => sum + 16 + Buffer.byteLength(m.content, "utf8"), 0);
  const outputTokens = request.maxOutputTokens ?? 1024;
  const limits = effectiveLimits(provider, request.model, model);
  const ratios = [limits.inputTokens ? inputTokens / limits.inputTokens : 0,
    limits.contextTokens ? (inputTokens + outputTokens) / limits.contextTokens : 0,
    limits.outputTokens ? outputTokens / limits.outputTokens : 0];
  const status = ratios.some(n => n > 1) ? "exceeded" : ratios.some(n => n >= 0.8) ? "near_limit" :
    !limits.inputTokens && !limits.contextTokens ? "unknown_limit" : "within_estimate";
  return { status, inputTokens, outputTokens, limits, estimated: true,
    message: "UTF-8 bytes plus protocol overhead estimate, not exact tokens. No history is truncated. Unknown limits and provider overhead can still cause rejection." };
}
