// Policy is separate from the manually reviewed snapshot. Never fuzzy-match model IDs.
export { priceFor, pricesFor, pricingSources } from "./pricing-snapshot.js";
export type { Price, Rate } from "./pricing-snapshot.js";
import { priceFor } from "./pricing-snapshot.js";
import type { ProviderId, Usage } from "./types.js";

export const PROBE_INPUT_ESTIMATE = 128; // Fixed short prompt + conservative protocol overhead, not tokenizer output.
export const PROBE_OUTPUT_LIMIT = 256;
export function estimateCost(provider: ProviderId, model: string, input: number | null, output: number | null): number | null {
  const price = priceFor(provider, model);
  if (price.status !== "verified_snapshot" || !price.rates.length || input === null || output === null ||
      !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  // Highest documented tier, no free-tier or cache-read discount. Not a billing guarantee.
  return (input * Math.max(...price.rates.map(r => r.input)) + output * Math.max(...price.rates.map(r => r.output))) / 1_000_000;
}
export function probeEstimate(provider: ProviderId, model: string) {
  return { usd: estimateCost(provider, model, PROBE_INPUT_ESTIMATE, PROBE_OUTPUT_LIMIT), inputTokens: PROBE_INPUT_ESTIMATE,
    outputTokens: PROBE_OUTPUT_LIMIT, guaranteed: false };
}
export function usageCost(provider: ProviderId, model: string, usage: Usage | null): number | null {
  // Cache writes can carry additional fees not represented by the base input rate.
  if (!usage || (usage.cacheWriteTokens ?? 0) > 0) return null;
  return estimateCost(provider, model, usage.inputTokens, usage.outputTokens);
}
