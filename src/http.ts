import { NidusError, type QuotaDetail, type ErrorInfo } from "./errors.js";
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
  async json(url: string | URL, headers: Record<string, string>, signal: AbortSignal, body?: unknown, onHeaders?: (headers: Record<string, string>) => void, exactCostValues = false): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error"
      });
      onHeaders?.(rateLimitHeaders(response.headers));
      if (!response.ok) {
        // Never expose raw provider errors: they can echo keys, headers or prompts.
        const status = response.status;
        let quota = status === 402, invalidKey = status === 401, detail: QuotaDetail | null = null, info: ErrorInfo | null = null;
        try {
          const raw = object(JSON.parse(await readBody(response, 1024 * 1024)));
          const e = optionalObject(raw.error);
          quota ||= e.code === "insufficient_quota" || e.type === "insufficient_quota";
          detail = quotaDetail(e.details);
          if (status === 403) info = errorInfo(e.details, e.message);
          invalidKey ||= Array.isArray(e.details) && e.details.some(detail => detail && typeof detail === "object" && (detail as Record<string, unknown>).reason === "API_KEY_INVALID");
        } catch { /* HTTP status remains sufficient when error JSON is absent or invalid. */ }
        signal.throwIfAborted();
        const code = invalidKey ? "authentication" : status === 403 ? "permission" : quota ? "quota" : status === 429 ? "rate_limit" : status === 404 ? "not_found" : status === 400 || status === 422 ? "invalid_request" : "provider_error";
        const retry = response.headers.get("retry-after");
        const after = retry && /^\d{1,9}$/.test(retry) ? retry : detail?.retryDelaySec != null ? String(Math.ceil(detail.retryDelaySec)) : null;
        const failure = new NidusError(code, `Provider request failed (HTTP ${status}, ${code}).`, status, after);
        if (detail && (status === 429 || quota)) failure.quota = detail;
        if (info) failure.info = info;
        throw failure;
      }
      // Bound response memory, including chunked bodies. Timeout covers body reads too.
      const text = await readBody(response, 16 * 1024 * 1024);
      try {
        return object(JSON.parse(text, (key, value, context?: { source: string }) => {
          // Preserve the exact JSON decimal spelling before conversion to integer USD.
          if (exactCostValues && key === 'value' && typeof value === 'number') {
            if (!context?.source) throw new NidusError('invalid_response', 'Runtime cannot preserve billing decimal precision.');
            return context.source;
          }
          return value;
        }));
      }
      catch { throw new NidusError("invalid_response", "Provider returned invalid JSON."); }
    } catch (error) {
      if (error instanceof NidusError) throw error;
      if (signal.aborted) throw error;
      throw new NidusError("network", "Provider network request failed.");
    }
  }
}

const SAFE_NAME = /^[A-Za-z][\w.-]{0,127}$/;
/**
 * The structured part of a Google 403 (google.rpc.ErrorInfo), kept to names of the expected shape and a
 * Console link. Of the free text only two facts are kept, as booleans.
 */
export function errorInfo(details: unknown, message: unknown): ErrorInfo | null {
  const text = typeof message === "string" ? message : "";
  const out: ErrorInfo = { reason: null, service: null, serviceTitle: null, activationUrl: null, billingRequired: /requires billing to be enabled/i.test(text), quotaProjectRequired: /requires a quota project/i.test(text) };
  if (Array.isArray(details)) {
    for (const item of details.slice(0, 20)) {
      if (!item || typeof item !== "object") continue;
      const d = item as Record<string, unknown>;
      if (typeof d["@type"] !== "string" || !d["@type"].endsWith("google.rpc.ErrorInfo")) continue;
      if (typeof d.reason === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(d.reason)) out.reason = d.reason;
      const meta = optionalObject(d.metadata);
      if (typeof meta.service === "string" && SAFE_NAME.test(meta.service)) out.service = meta.service;
      if (typeof meta.serviceTitle === "string" && /^[\w .()-]{1,80}$/.test(meta.serviceTitle)) out.serviceTitle = meta.serviceTitle;
      if (typeof meta.activationUrl === "string" && /^https:\/\/console\.(developers|cloud)\.google\.com\/[\w\/.?=&%-]{1,300}$/.test(meta.activationUrl)) out.activationUrl = meta.activationUrl;
      break;
    }
  }
  return out.reason || out.billingRequired || out.quotaProjectRequired ? out : null;
}

/**
 * The structured quota details of a Google-style error (google.rpc.QuotaFailure and RetryInfo).
 * Only fields of a fixed, harmless shape are kept: metric and quota names, a model id, numbers.
 */
export function quotaDetail(details: unknown): QuotaDetail | null {
  if (!Array.isArray(details)) return null;
  const out: QuotaDetail = { violations: [], retryDelaySec: null };
  const name = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : null;
  for (const item of details.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const type = String(entry['@type'] ?? '');
    if (type.endsWith('google.rpc.RetryInfo')) {
      const delay = typeof entry.retryDelay === 'string' ? entry.retryDelay.match(/^(\d{1,7}(?:\.\d{1,9})?)s$/) : null;
      if (delay) out.retryDelaySec = Number(delay[1]);
    } else if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(entry.violations)) {
      for (const v of entry.violations.slice(0, 20)) {
        if (!v || typeof v !== 'object') continue;
        const violation = v as Record<string, unknown>;
        const metric = name(violation.quotaMetric, /^[\w.\/-]{1,200}$/), id = name(violation.quotaId, /^[\w.-]{1,200}$/);
        if (!metric && !id) continue;
        const dimensions = violation.quotaDimensions && typeof violation.quotaDimensions === 'object' ? violation.quotaDimensions as Record<string, unknown> : {};
        const value = typeof violation.quotaValue === 'string' && /^\d{1,15}$/.test(violation.quotaValue) ? Number(violation.quotaValue) : typeof violation.quotaValue === 'number' && Number.isSafeInteger(violation.quotaValue) && violation.quotaValue >= 0 ? violation.quotaValue : null;
        out.violations.push({ metric: metric ?? '', id: id ?? '', model: name(dimensions.model, /^[\w.\/:-]{1,200}$/), value });
      }
    }
  }
  return out.violations.length || out.retryDelaySec !== null ? out : null;
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

// Only numeric limits / documented reset formats; never persist arbitrary response headers.
export function rateLimitHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const names = ['retry-after', ...['x-ratelimit', 'anthropic-ratelimit'].flatMap(prefix =>
    ['requests', 'tokens', 'input-tokens', 'output-tokens'].flatMap(kind => prefix === 'x-ratelimit'
      ? ['limit', 'remaining', 'reset'].map(field => `${prefix}-${field}-${kind}`)
      : ['limit', 'remaining', 'reset'].map(field => `${prefix}-${kind}-${field}`)))];
  for (const name of names) {
    const value = headers.get(name);
    if (value && value.length <= 64 && /^(?:[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h|d)?)+$|^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) result[name] = value;
  }
  return result;
}
