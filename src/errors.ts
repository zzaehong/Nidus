import type { Usage } from "./types.js";
export type ErrorCode = "execution_permission" | "budget" | "authentication" | "permission" | "quota" | "rate_limit" | "network" | "timeout" | "cancelled" | "not_found" | "invalid_request" | "invalid_response" | "provider_error" | "storage" | "missing_key" | "unsupported" | "billing_risk";
/** Which quota a provider said was exhausted (from the structured part of its error, never free text). */
export interface QuotaViolation { metric: string; id: string; model: string | null; value: number | null }
export interface QuotaDetail { violations: QuotaViolation[]; retryDelaySec: number | null }
/** What a Google-style error says in its structured part (google.rpc.ErrorInfo): names and links only, never the free text. */
export interface ErrorInfo {
  reason: string | null;
  service: string | null;
  serviceTitle: string | null;
  /** The Console page that enables the API, when the error names one. */
  activationUrl: string | null;
  /** The server said the quota project needs billing / a quota project must be named. */
  billingRequired: boolean;
  quotaProjectRequired: boolean;
}
export class NidusError extends Error {
  usage?: Usage;
  quota?: QuotaDetail;
  reason?: string;
  info?: ErrorInfo;
  constructor(public readonly code: ErrorCode, message: string, public readonly status: number | null = null, public readonly retryAfter: string | null = null) { super(message); }
  toJSON() { return { ...(this.reason ? { reason: this.reason } : {}), code: this.code, message: this.message, status: this.status, retryAfter: this.retryAfter }; }
}
export function publicError(error: unknown): NidusError {
  return error instanceof NidusError ? error : new NidusError("provider_error", "Operation failed; no credentials or provider response were logged.");
}
