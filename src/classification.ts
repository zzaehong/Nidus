import type { Model } from "./types.js";

export type ModelKind = "text" | "image" | "video" | "live" | "audio" | "embedding" | "moderation" | "unknown";
export interface Classification {
  kind: ModelKind;
  confidence: "metadata" | "inferred" | "unknown";
  reason: string;
  textProbe: "supported" | "opt_in" | "unsupported";
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];

// Conservative routing hints, NOT an available-model catalog or proof of API access.
// Never classify image *input* / vision support as image generation.
export function classifyModel(model: Model): Classification {
  const result = (kind: ModelKind, confidence: Classification["confidence"], reason: string): Classification => ({
    kind, confidence, reason,
    textProbe: kind !== "text" || model.capabilities.chat === "unsupported" ? "unsupported" : confidence === "metadata" ? "supported" : "opt_in"
  });
  const methods = strings(model.details.supportedGenerationMethods).map(s => s.toLowerCase());
  const output = strings(model.details.outputModalities).map(s => s.toLowerCase());
  if (methods.includes("bidigeneratecontent")) return result("live", "metadata", "Models API: bidiGenerateContent; live session required.");
  if (methods.some(s => /^(batch)?embed(contents?)?$/.test(s))) return result("embedding", "metadata", "Models API: embedding method.");
  for (const kind of ["video", "image", "audio"] as const) {
    if (output.includes(kind)) return result(kind, "metadata", `Models API output modality: ${kind}.`);
  }
  // Recognizable specialized names are exclusion hints even when generateContent exists.
  const id = model.id.toLowerCase();
  const hints: [ModelKind, RegExp][] = [
    ["live", /(^|[-_/])(realtime|live|native-audio)([-_/]|$)/],
    ["video", /(^|[-_/])(veo|sora|video)([-_/\d]|$)/],
    ["image", /(^|[-_/])(imagen|image|dall-e)([-_/\d]|$)/],
    ["audio", /(^|[-_/])(audio|tts|whisper|transcribe|lyria|music)([-_/\d]|$)/],
    ["embedding", /(^|[-_/])(embedding|embed)([-_/\d]|$)/],
    ["moderation", /(^|[-_/])moderation([-_/]|$)/]
  ];
  for (const [kind, pattern] of hints) if (pattern.test(id)) return result(kind, "inferred", "Model ID naming hint only; modality/endpoint not verified.");
  if (methods.includes("predict") || methods.includes("predictlongrunning")) return result("unknown", "unknown", "Generic prediction method does not identify output modality; dedicated probe required.");
  if (model.capabilities.chat === "supported") return result("text", "metadata", "Adapter reports text chat from provider API metadata/contract.");
  if (model.capabilities.chat !== "unsupported" && (
    (model.provider === "openai" && /^(gpt-|chatgpt-|o\d)/.test(id)) ||
    (model.provider === "gemini" && /^(gemini-|gemma-)/.test(id) && methods.includes("generatecontent")) ||
    (model.provider === "deepseek" && id.startsWith("deepseek-"))
  )) return result("text", "inferred", "Text-family naming hint; text output and adapter endpoint compatibility require an opt-in probe.");
  return result("unknown", "unknown", "Insufficient metadata. Not automatically sent to a text endpoint.");
}
