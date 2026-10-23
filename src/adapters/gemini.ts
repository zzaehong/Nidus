import { BaseAdapter, baseModel, array, object, count, string, response, usage } from "./base.js";
import { optionalObject, HttpClient } from "../http.js";
import type { ChatRequest } from "../types.js";

export class GeminiAdapter extends BaseAdapter {
  readonly id = "gemini" as const;
  constructor(endpoint = "https://generativelanguage.googleapis.com/v1beta", http?: HttpClient) { super(endpoint, http); }
  protected headers(key: string) { return { "x-goog-api-key": key }; }
  protected page(raw: Record<string, unknown>) {
    return { items: raw.models === undefined ? [] : array(raw.models), next: raw.nextPageToken == null ? null : string(raw.nextPageToken), parameter: "pageToken" };
  }
  protected normalizeModel(raw: Record<string, unknown>) {
    const name = string(raw.name);
    const model = baseModel(this.id, name.replace(/^models\//, ""), typeof raw.displayName === "string" ? raw.displayName : name);
    const methods = raw.supportedGenerationMethods === undefined ? null : array(raw.supportedGenerationMethods);
    // generateContent also covers image/audio-specialized models. It alone cannot
    // prove ordinary text chat compatibility, so keep these models unconfirmed.
    model.capabilities.chat = methods && !methods.includes("generateContent") ? "unsupported" : "unknown";
    model.capabilitySource = "generateContent-availability; text-output-modality-unconfirmed";
    model.capabilities.streaming = methods?.includes("streamGenerateContent") ? "supported" : "unknown";
    model.limits.inputTokens = count(raw.inputTokenLimit);
    model.limits.outputTokens = count(raw.outputTokenLimit);
    model.details = { description: raw.description ?? null, supportedGenerationMethods: methods, version: raw.version ?? null, thinking: raw.thinking ?? null };
    return model;
  }
  protected chatBody(r: ChatRequest) {
    return { path: `/models/${encodeURIComponent(r.model)}:generateContent`, body: {
      contents: r.messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      systemInstruction: r.system === undefined ? undefined : { parts: [{ text: r.system }] },
      generationConfig: { maxOutputTokens: r.maxOutputTokens ?? 1024 }
    } };
  }
  protected normalizeChat(raw: Record<string, unknown>, model: string) {
    const candidate = optionalObject(array(raw.candidates ?? [])[0]);
    const content = optionalObject(candidate.content);
    const text = array(content.parts ?? []).map(object).filter(p => p.thought !== true && typeof p.text === "string").map(p => p.text).join("");
    const u = optionalObject(raw.usageMetadata);
    const visible = count(u.candidatesTokenCount);
    const output = visible === null ? null : visible + (count(u.thoughtsTokenCount) ?? 0);
    return response(this.id, typeof raw.modelVersion === "string" ? raw.modelVersion : model, text, candidate.finishReason, usage(u, u.promptTokenCount, output, u.totalTokenCount, u.cachedContentTokenCount, undefined, u.thoughtsTokenCount));
  }
}
