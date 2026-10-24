import { NidusError } from "./errors.js";
import type { RequestOptions } from "./types.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NidusError("invalid_response", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function optionalObject(value: unknown): Record<string, unknown> { return value == null ? {} : object(value); }
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new NidusError("invalid_response", "Expected a JSON array.");
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new NidusError("invalid_response", "Missing string field in provider response.");
  return value;
}
export function count(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function keyValue(key: string): string {
  if (typeof key !== "string" || !key.trim()) throw new NidusError("missing_key", "Register an API key with nidus connect.");
  if (/[\r\n\0]/.test(key.trim())) throw new NidusError("invalid_request", "Invalid API key format.");
  return key.trim();
}
export async function bounded<T>(options: RequestOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000) throw new NidusError("invalid_request", "Timeout must be between 1 and 600000 ms.");
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(), timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, timerController.signal]) : timerController.signal;
  try { signal.throwIfAborted(); return await action(signal); }
  catch (error) {
    if (options.signal?.aborted) throw new NidusError("cancelled", "Request cancelled.");
    if (timerController.signal.aborted) throw new NidusError("timeout", "Provider request timed out.");
    throw error;
  } finally { clearTimeout(timer); }
}

export class HttpClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async json(url: string | URL, headers: Record<string, string>, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error"
      });
      if (!response.ok) {
        // Never expose raw provider errors: they can echo keys, headers or prompts.
        const status = response.status;
        let quota = status === 402, invalidKey = status === 401, versionError = false;
        try {
          const raw = object(JSON.parse(await readBody(response, 1024 * 1024)));
          const e = optionalObject(raw.error);
          versionError = status === 400 && !!headers["anthropic-version"] && e.type === "invalid_request_error" &&
            typeof e.message === "string" && /anthropic[-_ ]version/i.test(e.message);
          quota ||= e.code === "insufficient_quota" || e.type === "insufficient_quota";
          invalidKey ||= Array.isArray(e.details) && e.details.some(detail => detail && typeof detail === "object" && (detail as Record<string, unknown>).reason === "API_KEY_INVALID");
        } catch { /* HTTP status remains sufficient when error JSON is absent or invalid. */ }
        signal.throwIfAborted();
        const code = invalidKey ? "authentication" : status === 403 ? "permission" : versionError ? "api_version" : quota ? "quota" : status === 429 ? "rate_limit" : status === 404 ? "not_found" : status === 400 || status === 422 ? "invalid_request" : "provider_error";
        const retry = response.headers.get("retry-after");
        throw new NidusError(code, `Provider request failed (HTTP ${status}, ${code}).`, status, retry && /^\d{1,9}$/.test(retry) ? retry : null);
      }
      // Bound response memory, including chunked bodies. Timeout covers body reads too.
      const text = await readBody(response, 16 * 1024 * 1024);
      try { return object(JSON.parse(text)); }
      catch { throw new NidusError("invalid_response", "Provider returned invalid JSON."); }
    } catch (error) {
      if (error instanceof NidusError) throw error;
      if (signal.aborted) throw error;
      throw new NidusError("network", "Provider network request failed.");
    }
  }
}

async function readBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new NidusError("invalid_response", "Empty provider response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > limit) { await reader.cancel(); throw new NidusError("invalid_response", "Provider response exceeds size limit."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
