// How each model has been doing lately, read from the usage log, so the Gateway stops sending
// work to a model that keeps failing or is much slower than its neighbours, across restarts.
// A model rests after a run of failures (longer the more it fails in a row); one that does not
// exist at its provider rests for a day. A success ends the run.

export interface CallRow { provider: string; model: string; at: string; status: string; error: string | null; durationMs: number }

export interface ModelHealth {
  /** Failures in a row, most recent first; 0 after a success. */
  streak: number;
  lastError: string | null;
  /** Until when the model is passed over, if it is resting. */
  restUntil: Date | null;
  /** Median duration of its recent successful calls. */
  medianMs: number | null;
}

/** Errors that say something about the model (not about the request or the user stopping). */
const FAILING = new Set(['timeout', 'provider_error', 'rate_limit', 'network', 'slow', 'not_found', 'unsupported', 'quota', 'invalid_response']);
/** Errors that will not pass by themselves soon. */
const LONG_REST: Record<string, number> = { not_found: 24 * 3600_000, unsupported: 24 * 3600_000, quota: 3600_000 };
const FIRST_REST_MS = 60_000;
const MAX_REST_MS = 2 * 3600_000;

/** How long a model rests after `streak` failures in a row: 1, 3, 9, 27, 81 minutes, then 2 hours. */
export function restMs(streak: number, error: string | null): number {
  if (streak <= 0) return 0;
  const long = error ? LONG_REST[error] : undefined;
  if (long) return long;
  return Math.min(MAX_REST_MS, FIRST_REST_MS * 3 ** (streak - 1));
}

/** rows: recent calls, newest first. */
export function modelHealth(rows: CallRow[]): Map<string, ModelHealth> {
  const byModel = new Map<string, CallRow[]>();
  for (const row of rows) {
    const ref = `${row.provider}:${row.model}`;
    if (!byModel.has(ref)) byModel.set(ref, []);
    byModel.get(ref)!.push(row);
  }
  const out = new Map<string, ModelHealth>();
  for (const [ref, calls] of byModel) {
    let streak = 0, lastError: string | null = null, lastAt: string | null = null;
    for (const call of calls) {
      if (call.status === 'succeeded') break;
      if (!call.error || !FAILING.has(call.error)) continue; // stopped by the user, or the request's own fault
      if (streak === 0) { lastError = call.error; lastAt = call.at; }
      streak++;
    }
    const rest = restMs(streak, lastError);
    const durations = calls.filter(c => c.status === 'succeeded').slice(0, 10).map(c => c.durationMs).sort((a, b) => a - b);
    out.set(ref, {
      streak, lastError,
      restUntil: rest && lastAt ? new Date(Date.parse(lastAt) + rest) : null,
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
    });
  }
  return out;
}

/** Models resting at `now`. */
export function resting(health: Map<string, ModelHealth>, now: Date): string[] {
  return [...health].filter(([, h]) => h.restUntil && h.restUntil > now).map(([ref]) => ref);
}

/**
 * When to also ask the next candidate, if the first has not answered: two and a half times its
 * usual time, between 20 seconds and a minute; 45 seconds while its usual time is unknown.
 */
export function hedgeDelayMs(medianMs: number | null | undefined): number {
  if (!medianMs) return 45_000;
  return Math.min(60_000, Math.max(20_000, Math.round(medianMs * 2.5)));
}
