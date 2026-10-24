import { classifyModel } from "./classification.js";
import { publicError } from "./errors.js";
import { PROBE_OUTPUT_LIMIT } from "./pricing.js";
import type { Model, ChatResponse, ChatRequest, RequestOptions, Usage } from "./types.js";

export interface ProbeResult {
  model: string;
  status: "passed" | "failed" | "skipped";
  checkedAt: string;
  durationMs: number;
  reason: string;
  error: ReturnType<ReturnType<typeof publicError>["toJSON"]> | null;
  usage: Usage | null;
  stopProvider: boolean;
}
export async function probeModel(model: Model, allowInferred: boolean,
  chat: (request: ChatRequest, options: RequestOptions) => Promise<ChatResponse>): Promise<ProbeResult> {
  const started = Date.now();
  const base = { model: model.id, checkedAt: new Date().toISOString(), durationMs: 0, error: null, usage: null, stopProvider: false };
  const classification = classifyModel(model);
  if (classification.textProbe === "unsupported" || (classification.textProbe === "opt_in" && !allowInferred)) {
    return { ...base, status: "skipped", reason: classification.textProbe === "opt_in" ? "Inferred text model requires explicit opt-in." : "No probe implemented for this model type; not a model failure." };
  }
  try {
    const response = await chat({ model: model.id, messages: [{ role: "user", content: "Reply with OK." }], maxOutputTokens: PROBE_OUTPUT_LIMIT }, { timeoutMs: 30_000 });
    const passed = response.text.trim().length > 0;
    return { ...base, status: passed ? "passed" : "failed", reason: passed ? "Non-empty text response received; text endpoint only." : "No visible text within the probe budget; model health is inconclusive.", usage: response.usage, durationMs: Date.now() - started };
  } catch (error) {
    const safe = publicError(error);
    return { ...base, status: "failed", reason: "Probe request failed; this does not establish that the model is broken.", error: safe.toJSON(),
      // A failed probe applies only to this model. Keep the field for bridge compatibility.
      stopProvider: false, durationMs: Date.now() - started };
  }
}
