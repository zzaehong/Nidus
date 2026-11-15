// What Google's management APIs say about a Gemini API project:
//   Cloud Quotas      the limits that apply (per model: requests per minute and day, input tokens per minute)
//   Cloud Monitoring  the usage Google itself counted against those limits (delayed by minutes)
//   Cloud Billing     whether a billing account is linked: a project with billing is not on the free tier
// These are read-only GET requests with a Cloud access token; they are not model calls and cost nothing.
// Each source can fail on its own (API not enabled, no permission): its error is kept and the
// others still count. Nothing is estimated in place of a value that did not arrive.
import { NidusError } from '../../errors.js';
import { bounded, HttpClient } from '../../http.js';
import type { AccessToken } from './google-auth.js';
import { type Limits, type Observed, type ProviderQuota, type QuotaKind, type QuotaPolicy } from './quota.js';

export const SERVICE = 'generativelanguage.googleapis.com';
export type GeminiTier = 'free' | 'paid';

/** The quota metrics of each tier and what they limit. The suffix after "<service>/" in QuotaInfo.metric. */
export const METRICS: Record<GeminiTier, Record<string, 'requests' | 'tokens'>> = {
  free: { generate_content_free_tier_requests: 'requests', generate_content_free_tier_input_token_count: 'tokens' },
  paid: { generate_requests_per_model: 'requests', generate_content_paid_tier_input_token_count: 'tokens' },
};

function kindOf(what: 'requests' | 'tokens', interval: string): QuotaKind | null {
  const minute = /^(1\s*)?min(ute)?$/i.test(interval.trim()) || /PerMinute/.test(interval), day = /^(1\s*)?day$/i.test(interval.trim()) || /PerDay/.test(interval);
  if (what === 'requests') return minute ? 'rpm' : day ? 'rpd' : null;
  return minute ? 'tpm' : null;
}

export interface QuotaInfo {
  quotaId?: string; metric?: string; refreshInterval?: string; dimensions?: string[];
  dimensionsInfos?: { dimensions?: Record<string, string>; details?: { value?: string | number } }[];
}

/** Limits by model from Cloud Quotas' quotaInfos; also the metrics that were there but are not understood. */
export function mapQuotaInfos(infos: QuotaInfo[], tier: GeminiTier): { limits: Record<string, Limits>; unmapped: string[] } {
  const limits: Record<string, Limits> = {};
  const unmapped = new Set<string>();
  for (const info of infos) {
    const metric = String(info.metric ?? '').replace(`${SERVICE}/`, '');
    const what = METRICS[tier][metric];
    const kind = what ? kindOf(what, String(info.refreshInterval ?? '')) : null;
    if (!kind) { if (metric && /generate/.test(metric)) unmapped.add(`${metric}${info.refreshInterval ? ` (${info.refreshInterval})` : ''}`); continue; }
    for (const entry of info.dimensionsInfos ?? []) {
      const value = Number(entry.details?.value);
      // A missing value is unknown, a negative one means "no limit": neither is a number to show.
      if (entry.details?.value === undefined || entry.details.value === '' || !Number.isSafeInteger(value) || value < 0) continue;
      const model = entry.dimensions?.model ?? '*';
      (limits[model] ??= {})[kind] = { value, source: 'cloud' };
    }
  }
  return { limits, unmapped: [...unmapped].sort() };
}

export interface TimeSeries {
  metric?: { type?: string; labels?: Record<string, string> };
  points?: { interval?: { startTime?: string; endTime?: string }; value?: { int64Value?: string; doubleValue?: number } }[];
}

const pointValue = (point: NonNullable<TimeSeries['points']>[number]) => Number(point.value?.int64Value ?? point.value?.doubleValue ?? NaN);

/**
 * Usage and limits as Monitoring reports them, by model. A daily limit's usage is the sum since
 * the day began; a per-minute limit's is the highest minute of the last hour (what is left of
 * the current minute cannot be known from data that arrives minutes late).
 */
export function mapTimeSeries(usage: TimeSeries[], limit: TimeSeries[], what: 'requests' | 'tokens', now: Date, policy: QuotaPolicy): Record<string, Partial<Record<QuotaKind, Observed>>> {
  const out: Record<string, Partial<Record<QuotaKind, Observed>>> = {};
  const cell = (series: TimeSeries): { model: string; kind: QuotaKind; observed: Observed } | null => {
    const model = series.metric?.labels?.model, kind = kindOf(what, series.metric?.labels?.limit_name ?? '');
    if (!model || !kind) return null;
    return { model, kind, observed: ((out[model] ??= {})[kind] ??= { usage: null, limit: null, at: null }) };
  };
  const day = policy.dayStart(now).getTime(), hour = now.getTime() - 3600_000;
  // Several series can feed one limit (one per method): their points add up minute by minute.
  const minutes = new Map<Observed, Map<string, number>>();
  for (const series of usage) {
    const found = cell(series);
    if (!found) continue;
    for (const point of series.points ?? []) {
      const end = Date.parse(point.interval?.endTime ?? ''), value = pointValue(point);
      if (!Number.isFinite(end) || !Number.isFinite(value)) continue;
      const o = found.observed;
      if (!o.at || end > Date.parse(o.at)) o.at = new Date(end).toISOString();
      if (found.kind === 'rpd') { if (end > day) o.usage = (o.usage ?? 0) + value; }
      else if (end > hour) {
        const perMinute = minutes.get(o) ?? new Map<string, number>();
        perMinute.set(point.interval!.endTime!, (perMinute.get(point.interval!.endTime!) ?? 0) + value);
        minutes.set(o, perMinute);
      }
    }
  }
  for (const [observed, perMinute] of minutes) observed.usage = Math.max(...perMinute.values());
  for (const series of limit) {
    const found = cell(series);
    const newest = [...(series.points ?? [])].sort((a, b) => Date.parse(b.interval?.endTime ?? '') - Date.parse(a.interval?.endTime ?? ''))[0];
    if (found && newest && Number.isFinite(pointValue(newest))) found.observed.limit = pointValue(newest);
  }
  return out;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$|^\d{4,20}$/;
/** A project id or number, as the APIs take it. */
export function projectName(value: unknown): string {
  const project = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT.test(project)) throw new NidusError('invalid_request', 'A Google Cloud project ID looks like "my-project-123" (or is the project number).');
  return project;
}

/** Why a source gave nothing, in words the user can act on. */
export function cloudProblem(error: unknown, api: string, permission: string): string {
  const code = error instanceof NidusError ? error.code : 'provider_error';
  switch (code) {
    case 'authentication': return (error as NidusError).reason === 'cloud_auth_missing' ? 'Google Cloud 로그인이 설정되지 않았습니다.' : 'Google Cloud 로그인이 만료됐거나 거부됐습니다. 다시 로그인하세요.';
    case 'permission': return `권한이 없거나 이 프로젝트에서 ${api}가 켜져 있지 않습니다 (필요한 권한: ${permission}).`;
    case 'not_found': return '프로젝트를 찾을 수 없습니다. 프로젝트 ID를 확인하세요.';
    case 'rate_limit': return `${api} 조회 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.`;
    case 'network': case 'timeout': return 'Google에 연결하지 못했습니다.';
    case 'invalid_request': return `${api}가 요청을 받아들이지 않았습니다.`;
    default: return `${api}에서 값을 받지 못했습니다.`;
  }
}

export interface CloudReader {
  quotaInfos(project: string, token: AccessToken): Promise<QuotaInfo[]>;
  timeSeries(project: string, token: AccessToken, metricType: string, start: Date, end: Date): Promise<TimeSeries[]>;
  billingEnabled(project: string, token: AccessToken): Promise<boolean>;
}

export class GoogleCloud implements CloudReader {
  constructor(private readonly http: HttpClient = new HttpClient()) {}

  private headers(project: string, token: AccessToken): Record<string, string> {
    // With a person's credentials Google needs the project the request counts against.
    return { authorization: `Bearer ${token.token}`, ...(token.user ? { 'x-goog-user-project': project } : {}) };
  }

  private async pages<T>(url: URL, headers: Record<string, string>, field: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < 50; page++) {
      const raw = await bounded({ timeoutMs: 30_000 }, signal => this.http.json(url, headers, signal));
      if (Array.isArray(raw[field])) out.push(...raw[field] as T[]);
      if (typeof raw.nextPageToken !== 'string' || !raw.nextPageToken) break;
      url.searchParams.set('pageToken', raw.nextPageToken);
    }
    return out;
  }

  quotaInfos(project: string, token: AccessToken): Promise<QuotaInfo[]> {
    const url = new URL(`https://cloudquotas.googleapis.com/v1/projects/${projectName(project)}/locations/global/services/${SERVICE}/quotaInfos`);
    url.searchParams.set('pageSize', '500');
    return this.pages<QuotaInfo>(url, this.headers(project, token), 'quotaInfos');
  }

  timeSeries(project: string, token: AccessToken, metricType: string, start: Date, end: Date): Promise<TimeSeries[]> {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectName(project)}/timeSeries`);
    url.searchParams.set('filter', `metric.type="${metricType}"`);
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', end.toISOString());
    url.searchParams.set('view', 'FULL');
    url.searchParams.set('pageSize', '1000');
    return this.pages<TimeSeries>(url, this.headers(project, token), 'timeSeries');
  }

  async billingEnabled(project: string, token: AccessToken): Promise<boolean> {
    const raw = await bounded({ timeoutMs: 30_000 }, signal => this.http.json(`https://cloudbilling.googleapis.com/v1/projects/${projectName(project)}/billingInfo`, this.headers(project, token), signal));
    return raw.billingEnabled === true;
  }
}

/**
 * Reads all three sources for a project and puts what arrived into the quota record. A source
 * that fails leaves its earlier values out (not stale ones presented as current) and its reason in.
 */
export async function readCloud(quota: ProviderQuota, project: string, tier: GeminiTier, token: AccessToken, cloud: CloudReader, now: Date, policy: QuotaPolicy): Promise<{ unmapped: string[] }> {
  quota.project = project;
  quota.fetchedAt = now.toISOString();
  quota.errors = {};
  let unmapped: string[] = [];
  try {
    const mapped = mapQuotaInfos(await cloud.quotaInfos(project, token), tier);
    // Limits a 429 revealed stay where Cloud Quotas has none for that model.
    const server = Object.fromEntries(Object.entries(quota.limits).map(([model, limits]) => [model, Object.fromEntries(Object.entries(limits).filter(([, l]) => l.source === 'server'))]));
    quota.limits = {};
    for (const model of new Set([...Object.keys(server), ...Object.keys(mapped.limits)])) {
      const merged = { ...server[model], ...mapped.limits[model] } as Limits;
      if (Object.keys(merged).length) quota.limits[model] = merged;
    }
    unmapped = mapped.unmapped;
    if (!Object.keys(mapped.limits).length) quota.errors.quotas = 'Cloud Quotas가 이 프로젝트의 Gemini 모델별 제한을 돌려주지 않았습니다.';
  } catch (error) {
    quota.limits = Object.fromEntries(Object.entries(quota.limits).map(([model, limits]) => [model, Object.fromEntries(Object.entries(limits).filter(([, l]) => l.source === 'server')) as Limits]).filter(([, l]) => Object.keys(l as Limits).length));
    quota.errors.quotas = cloudProblem(error, 'Cloud Quotas API', 'cloudquotas.quotas.get');
  }
  try {
    const start = new Date(Math.min(policy.dayStart(now).getTime(), now.getTime() - 3600_000));
    quota.observed = {};
    for (const [metric, what] of Object.entries(METRICS[tier])) {
      const [usage, limit] = await Promise.all(['usage', 'limit'].map(suffix => cloud.timeSeries(project, token, `${SERVICE}/quota/${metric}/${suffix}`, start, now)));
      for (const [model, kinds] of Object.entries(mapTimeSeries(usage!, limit!, what, now, policy))) quota.observed[model] = { ...quota.observed[model], ...kinds };
    }
  } catch (error) {
    quota.observed = {};
    quota.errors.monitoring = cloudProblem(error, 'Cloud Monitoring API', 'monitoring.timeSeries.list');
  }
  try {
    quota.billing = { enabled: await cloud.billingEnabled(project, token), checkedAt: now.toISOString() };
  } catch (error) {
    quota.billing = null;
    quota.errors.billing = cloudProblem(error, 'Cloud Billing API', 'resourcemanager.projects.get');
  }
  return { unmapped };
}
