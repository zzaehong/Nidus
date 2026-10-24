import type { Usage } from "./types.js";
export type ErrorCode = "budget" | "authentication" | "permission" | "quota" | "rate_limit" | "network" | "timeout" | "cancelled" | "not_found" | "invalid_request" | "invalid_response" | "provider_error" | "storage" | "missing_key" | "unsupported";
export class NidusError extends Error {
  usage?: Usage;
  reason?: string;
  constructor(public readonly code: ErrorCode, message: string, public readonly status: number | null = null, public readonly retryAfter: string | null = null) { super(message); }
  toJSON() { return { ...(this.reason ? { reason: this.reason } : {}), code: this.code, message: this.message, status: this.status, retryAfter: this.retryAfter }; }
}
export function publicError(error: unknown): NidusError {
  return error instanceof NidusError ? error : new NidusError("provider_error", "Operation failed; no credentials or provider response were logged.");
}
