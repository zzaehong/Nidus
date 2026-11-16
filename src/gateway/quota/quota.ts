// Quota bookkeeping for a provider with per-model rate limits. Nothing here is specific to one
// provider: a provider supplies where its limits come from and when its day starts.
//
// Three kinds of numbers are kept apart and never added together:
//   limit     what the provider allows (from its management API, from the user, or from a 429)
//   local     what this Vault's usage log counted: calls made through Nidus only
//   observed  what the provider's own monitoring reported: delayed, and all callers of the project
// The server's answer is final: a call within the known limits can still be refused, and a 429
// blocks the model until the time the server gave (or the window ends).
//
//   .nidus/local/quota.json   limits fetched, observed usage, blocks, what a 429 revealed
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { QuotaDetail } from '../../errors.js';

export const quotaKinds = ['rpm', 'tpm', 'rpd'] as const;
/** Requests per minute, input tokens per minute, requests per day. */
export type QuotaKind = typeof quotaKinds[number];

export interface Limit { value: number; source: 'cloud' | 'manual' | 'server' }
export type Limits = Partial<Record<QuotaKind, Limit>>;

/** What the provider's monitoring reported for one limit. Delayed; counts every caller of the project. */
export interface Observed {
  /** rpd: the sum since the day began. rpm, tpm: the highest one-minute value of the last hour. */
  usage: number | null;
  limit: number | null;
  /** End of the newest data point. */
  at: string | null;
}

export interface Block { kind: QuotaKind | 'unknown'; until: string; at: string; quotaId: string | null }

export interface ProviderQuota {
  /** The project the fetched numbers belong to. */
  project: string | null;
  fetchedAt: string | null;
  /** Limits by model id; "*" holds a limit that applies to every model without its own. */
  limits: Record<string, Limits>;
  observed: Record<string, Partial<Record<QuotaKind, Observed>>>;
  billing: { enabled: boolean; checkedAt: string } | null;
  /** Why a source gave nothing (shown to the user; never a guess in its place). */
  errors: { auth?: string; quotas?: string; monitoring?: string; billing?: string };
  blocks: Record<string, Block>;
  /** What a refused call revealed about the tier the project is really on. */
  tier: { evidence: 'free' | 'paid'; quotaId: string; at: string } | null;
}

export const emptyQuota = (): ProviderQuota => ({ project: null, fetchedAt: null, limits: {}, observed: {}, billing: null, errors: {}, blocks: {}, tier: null });

export class QuotaStore {
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, ProviderQuota>> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const providers = raw?.version === 1 && raw.providers && typeof raw.providers === 'object' ? raw.providers as Record<string, ProviderQuota> : {};
      for (const id of Object.keys(providers)) providers[id] = { ...emptyQuota(), ...providers[id] };
      return providers;
    } catch { return {}; }
  }

  async get(provider: string): Promise<ProviderQuota> {
    return (await this.load())[provider] ?? emptyQuota();
  }

  /** Changes one provider's record; changes are applied one after another. */
  update(provider: string, change: (quota: ProviderQuota) => void | Promise<void>): Promise<ProviderQuota> {
    const next = this.turn.then(async () => {
      const all = await this.load();
      const quota = all[provider] ?? emptyQuota();
      await change(quota);
      all[provider] = quota;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const pending = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(pending, `${JSON.stringify({ version: 1, providers: all }, null, 2)}\n`, { mode: 0o600 });
      await rename(pending, this.file);
      return quota;
    });
    this.turn = next.catch(() => {});
    return next;
  }
}

/** When a provider's daily quota starts over. */
export interface QuotaPolicy {
  dayStart(now: Date): Date;
}

/** Midnight in a time zone, as a point in time: the latest one not after now. */
export function zoneMidnight(now: Date, timeZone: string): Date {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const clock = (at: Date) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(p => [p.type, Number(p.value)]));
    return (parts.hour! * 3600 + parts.minute! * 60 + parts.second!) * 1000 + at.getMilliseconds();
  };
  let midnight = new Date(now.getTime() - clock(now));
  // On the day the clocks change, the wall clock does not say how long ago midnight was: correct by what is left.
  const off = clock(midnight);
  if (off) midnight = new Date(midnight.getTime() + (off >= 12 * 3600_000 ? 24 * 3600_000 - off : -off));
  return midnight;
}

/** Gemini API: "Requests per day (RPD) quotas reset at midnight Pacific time." */
export const pacificDay: QuotaPolicy = { dayStart: now => zoneMidnight(now, 'America/Los_Angeles') };

export function nextDayStart(policy: QuotaPolicy, now: Date): Date {
  // 26 hours later is always inside the next day, also across a daylight-saving change.
  return policy.dayStart(new Date(policy.dayStart(now).getTime() + 26 * 3600_000));
}

export interface UsageRow { model: string; at: string; input: number | null; status: string; error: string | null }
export type LocalUsage = Record<QuotaKind, number>;

/** Errors of calls that never reached the provider: they used no quota. */
const NOT_SENT = new Set(['missing_key', 'billing_risk', 'unsupported']);

/**
 * What this Vault's own calls used of each window, by model. Calls from anywhere else (another
 * app, another Vault, another key of the same project) are not in it, so the real use can be higher.
 */
export function localUsage(rows: UsageRow[], now: Date, policy: QuotaPolicy): Map<string, LocalUsage> {
  const minute = now.getTime() - 60_000, day = policy.dayStart(now).getTime();
  const out = new Map<string, LocalUsage>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!(at >= day) || at > now.getTime() || (row.error && NOT_SENT.has(row.error))) continue;
    const use = out.get(row.model) ?? { rpm: 0, tpm: 0, rpd: 0 };
    use.rpd++;
    if (at > minute) { use.rpm++; use.tpm += row.input ?? 0; }
    out.set(row.model, use);
  }
  return out;
}

/** The limits that apply to a model: the user's own first, then the provider's, then what a 429 showed. */
export function limitsFor(model: string, fetched: Record<string, Limits>, manual: Record<string, Partial<Record<QuotaKind, number>>> = {}): Limits {
  const out: Limits = {};
  for (const kind of quotaKinds) {
    const own = manual[model]?.[kind] ?? manual['*']?.[kind];
    const limit = typeof own === 'number' ? { value: own, source: 'manual' as const } : fetched[model]?.[kind] ?? fetched['*']?.[kind];
    if (limit) out[kind] = limit;
  }
  return out;
}

export interface QuotaCell {
  /** Counted from this Vault's calls. */
  local: number;
  limit: number | null;
  source: Limit['source'] | null;
  /** From the provider's monitoring, if it was fetched. */
  observed: Observed | null;
}

export interface QuotaRow {
  model: string;
  rpm: QuotaCell; tpm: QuotaCell; rpd: QuotaCell;
  /** limited: a 429 blocks it, or the local count reached a known limit. unknown: no limit is known. */
  status: 'available' | 'limited' | 'unknown';
  /** Why it is limited, for the user. */
  detail: string | null;
  blockedUntil: string | null;
}

export function quotaRow(model: string, quota: ProviderQuota, local: LocalUsage | undefined, manual: Record<string, Partial<Record<QuotaKind, number>>>, now: Date): QuotaRow {
  const limits = limitsFor(model, quota.limits, manual);
  const cell = (kind: QuotaKind): QuotaCell => ({ local: local?.[kind] ?? 0, limit: limits[kind]?.value ?? null, source: limits[kind]?.source ?? null, observed: quota.observed[model]?.[kind] ?? null });
  const row: QuotaRow = { model, rpm: cell('rpm'), tpm: cell('tpm'), rpd: cell('rpd'), status: 'available', detail: null, blockedUntil: null };
  const block = quota.blocks[model];
  const names: Record<string, string> = { rpm: '분당 요청', tpm: '분당 입력 토큰', rpd: '하루 요청', unknown: '할당량' };
  if (block && Date.parse(block.until) > now.getTime()) {
    row.status = 'limited';
    row.blockedUntil = block.until;
    row.detail = `서버가 ${names[block.kind]} 초과를 알렸습니다`;
  } else {
    const reached = quotaKinds.find(kind => row[kind].limit !== null && row[kind].local >= row[kind].limit!);
    if (reached) { row.status = 'limited'; row.detail = `이 Vault의 호출만으로 ${names[reached]} 제한에 닿았습니다`; }
    else if (quotaKinds.every(kind => row[kind].limit === null)) row.status = 'unknown';
  }
  return row;
}

/** A 429 as the provider described it: which window is exhausted, and until when to leave the model alone. */
export function blockFrom(detail: QuotaDetail | undefined, retryAfter: string | null, now: Date, policy: QuotaPolicy): Block {
  const text = (detail?.violations ?? []).map(v => `${v.id} ${v.metric}`).join(' ');
  const daily = /PerDay|per_day/i.test(text), tokens = /token/i.test(text), minute = /PerMinute|per_minute/i.test(text);
  const kind: Block['kind'] = daily ? 'rpd' : tokens ? 'tpm' : minute ? 'rpm' : 'unknown';
  const seconds = detail?.retryDelaySec ?? (retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null);
  // A daily quota does not come back in the seconds the server suggests for the minute window.
  const until = daily ? nextDayStart(policy, now) : new Date(now.getTime() + Math.min(3600, Math.max(1, seconds ?? 60)) * 1000);
  return { kind, until: until.toISOString(), at: now.toISOString(), quotaId: detail?.violations[0]?.id || null };
}

/** Whether a refused call shows the project on the free tier or on a paid one, when the quota's name says so. */
export function tierEvidence(detail: QuotaDetail | undefined): { evidence: 'free' | 'paid'; quotaId: string } | null {
  for (const v of detail?.violations ?? []) {
    const text = `${v.id} ${v.metric}`;
    if (/free[_-]?tier/i.test(text)) return { evidence: 'free', quotaId: v.id || v.metric };
    if (/paid[_-]?tier/i.test(text)) return { evidence: 'paid', quotaId: v.id || v.metric };
  }
  return null;
}
