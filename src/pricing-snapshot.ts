import type { ProviderId } from "./types.js";

export interface Rate {
  tier: string;
  input: number;
  output: number;
  cachedInput: number | null;
  conditions: string;
}
export interface Price {
  provider: ProviderId;
  model: string;
  status: "verified_snapshot" | "unknown";
  currency: "USD";
  unit: "per_million_tokens";
  freeTier: "available" | "unavailable" | "unknown";
  sourceUrl: string;
  checkedAt: string | null;
  rates: Rate[];
  notes: string;
}
export const pricingSources: Record<ProviderId, string> = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing/"
};
// Manually reviewed official documents. Update exact IDs, conditions and this date together.
const checkedAt = "2026-10-24T04:36:27Z";
function entry(provider: ProviderId, model: string, rates: Rate[], freeTier: Price["freeTier"] = "unknown", sourceUrl = pricingSources[provider], notes = "Standard text requests only; excludes tools, cache storage/write, batch and negotiated discounts."): Price {
  return { provider, model, status: "verified_snapshot", currency: "USD", unit: "per_million_tokens", freeTier, sourceUrl, checkedAt, rates, notes };
}
const standard = (input: number, output: number, cachedInput: number): Rate[] => [{ tier: "standard", input, output, cachedInput, conditions: "Direct API, text tokens, standard service." }];
// Explicit price records are not a model catalog and never create available models.
// Exact IDs only: no fuzzy aliases, prefix matches, or guessed snapshot prices.
export const registry: Price[] = [
  entry("openai", "gpt-4.1", standard(2, 8, 0.5), "unavailable", "https://developers.openai.com/api/docs/models/gpt-4.1"),
  entry("openai", "gpt-4.1-nano", standard(0.1, 0.4, 0.025), "unavailable", "https://developers.openai.com/api/docs/models/gpt-4.1-nano", "Historical price; model page marks this model shut down. A price record never establishes availability."),
  entry("openai", "gpt-4.1-mini", standard(0.4, 1.6, 0.1), "unavailable", "https://developers.openai.com/api/docs/models/gpt-4.1-mini"),
  entry("openai", "gpt-4.1-mini-2025-04-14", standard(0.4, 1.6, 0.1), "unavailable", "https://developers.openai.com/api/docs/models/gpt-4.1-mini"),
  entry("anthropic", "claude-sonnet-4-6", standard(3, 15, 0.3)),
  entry("anthropic", "claude-opus-4-6", standard(5, 25, 0.5)),
  entry("anthropic", "claude-sonnet-5-5", standard(2, 10, 0.1), "unavailable", pricingSources.anthropic, "Standard direct API. Cache writes: 5-minute 1.25x input, 1-hour 2x input; excluded from base rates. Full 1M context at standard rates."),
  entry("anthropic", "claude-opus-5-5", standard(4, 20, 0.2), "unavailable", pricingSources.anthropic, "Standard direct API. Cache writes: 5-minute 1.25x input, 1-hour 2x input; excluded from base rates. Full 1M context at standard rates."),
  entry("anthropic", "claude-haiku-5-5", [
    { tier: "up_to_100k", input: 0.1, output: 0.5, cachedInput: 0.01, conditions: "Input <=100K tokens." },
    { tier: "over_100k", input: 0.5, output: 2.5, cachedInput: 0.05, conditions: "Input >100K tokens; elevated rates apply to the request." }
  ], "unavailable", pricingSources.anthropic, "Cache write and other service fees excluded; estimation conservatively uses the higher tier."),
  entry("gemini", "gemini-3.5-flash-lite", standard(0.3, 2.5, 0.03), "available"),
  entry("gemini", "gemini-2.5-flash", standard(0.3, 2.5, 0.03), "available", pricingSources.gemini, "Text standard tier; output includes thinking. Free tier has account/region/usage limits; cache storage billed separately. Availability still comes from Models API."),
  entry("gemini", "gemini-2.5-flash-lite", standard(0.1, 0.4, 0.01), "available", pricingSources.gemini, "Standard text; output includes thinking. Cache storage $1 per million tokens/hour is separate. Free tier is account-dependent."),
  entry("deepseek", "deepseek-flash", [
    { tier: "peak", input: 0.3, output: 1.2, cachedInput: 0.006, conditions: "01:00–04:00 and 06:00–10:00 UTC Mon–Fri, excluding Chinese public holidays." },
    { tier: "off_peak", input: 0.15, output: 0.6, cachedInput: 0.003, conditions: "All other hours; no automatic holiday/time-based rate selection." }
  ]),
  entry("deepseek", "deepseek-v4-pro", [
    { tier: "peak", input: 1.32, output: 3.96, cachedInput: 0.044, conditions: "01:00–04:00 and 06:00–10:00 UTC Mon–Fri, excluding Chinese public holidays." },
    { tier: "off_peak", input: 0.66, output: 1.98, cachedInput: 0.022, conditions: "All other hours; no automatic holiday/time-based rate selection." }
  ])
];
// Only aliases explicitly documented as identically billed. Never infer aliases from prefixes.
for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
  const flash = registry.find(p => p.provider === "deepseek" && p.model === "deepseek-flash")!;
  registry.push({ ...structuredClone(flash), model: id, notes: "Official legacy alias served by current Flash and billed at Flash rates. Availability must still come from Models API." });
}
export function priceFor(provider: ProviderId, model: string): Price {
  return structuredClone(registry.find(p => p.provider === provider && p.model === model) ?? {
    provider, model, status: "unknown", currency: "USD", unit: "per_million_tokens", freeTier: "unknown", sourceUrl: pricingSources[provider], checkedAt: null, rates: [], notes: "No reviewed price record for this exact model ID. Unknown is not zero or free."
  });
}
export function pricesFor(provider: ProviderId): Price[] { return structuredClone(registry.filter(p => p.provider === provider)); }
