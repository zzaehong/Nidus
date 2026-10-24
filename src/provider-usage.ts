import type { ProviderId, RequestOptions } from './types.js';
import { bounded, HttpClient, array, object, keyValue } from './http.js';
import { NidusError } from './errors.js';
export const usageCapabilities = {
  openai: { requestTokens: true, accountUsage: 'optional-session-admin-api', actualCosts: 'organization-costs-admin-api', credits: 'not-connected', source: 'https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs', credential: 'Separate organization Admin API key required; inference credentials are never reused.' },
  anthropic: { requestTokens: true, accountUsage: 'optional-session-admin-api', actualCosts: 'organization-cost-report-admin-api', credits: 'not-connected', source: 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api', credential: 'Separate Admin API key required; inference credentials are never reused.' },
  gemini: { requestTokens: true, accountUsage: 'cloud-billing-not-connected', actualCosts: 'cloud-billing-export-not-connected', credits: 'not-connected', source: 'https://ai.google.dev/gemini-api/docs/billing', credential: 'Cloud Billing IAM is separate from the inference API key.' },
  deepseek: { requestTokens: true, accountUsage: 'local-only', actualCosts: 'no-documented-request-cost-api', credits: 'user-balance-api', source: 'https://api-docs.deepseek.com/api/get-user-balance/', credential: 'User balance API accepts the inference bearer credential.' }
} satisfies Record<ProviderId, object>;
export async function deepseekBalance(key: string, http = new HttpClient(), options: RequestOptions = {}) {
  const raw = await bounded(options, signal => http.json('https://api.deepseek.com/user/balance', { authorization: `Bearer ${keyValue(key)}` }, signal));
  const usd = array(raw.balance_infos).map(object).find(r => r.currency === 'USD');
  if (usd && (typeof usd.total_balance !== 'string' || !/^\d+(\.\d+)?$/.test(usd.total_balance))) throw new NidusError('invalid_response', 'Invalid provider USD balance.');
  return { usd: usd ? usd.total_balance as string : null, source: usageCapabilities.deepseek.source };
}

import { dollars, reportedMoney } from './money.js';
import { count } from './http.js';
export type BillingProvider = 'openai' | 'anthropic';
export interface AccountReport {
  provider: BillingProvider; month: string; start: string; end: string; syncedAt: string;
  reportedUSD: string | null; inputTokens: string | null; outputTokens: string | null;
  source: string; scope: 'organization'; note: string;
}
// Session-only, separate privileged credential namespace. No fallback to inference
// keys or Keychain and no persistence. Shells launched with these variables should
// be restricted to trusted processes. A future Keychain service must be distinct.
export function adminCredential(provider: BillingProvider, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[`NIDUS_${provider.toUpperCase()}_ADMIN_API_KEY`];
  if (!key) throw new NidusError('missing_key', 'A separate session-only NIDUS_<PROVIDER>_ADMIN_API_KEY is required for organization reports.');
  if (key === env[`NIDUS_${provider.toUpperCase()}_API_KEY`]) throw new NidusError('permission', 'Use a separately provisioned admin credential, not the inference credential.');
  return keyValue(key);
}
export async function accountReport(provider: BillingProvider, adminKey: string, http = new HttpClient(), now = new Date()): Promise<AccountReport> {
  const month = now.toISOString().slice(0, 7), start = `${month}-01T00:00:00.000Z`, end = now.toISOString();
  const anthropic = provider === 'anthropic';
  const base = anthropic ? 'https://api.anthropic.com/v1/organizations/' : 'https://api.openai.com/v1/organization/';
  const headers: Record<string, string> = { authorization: `Bearer ${keyValue(adminKey)}`, ...(anthropic ? { 'anthropic-version': '2026-10-21' } : {}) };
  const retrieve = async (kind: 'cost' | 'usage') => bounded({ timeoutMs: 60_000 }, async signal => {
    const path = anthropic ? (kind === 'cost' ? 'cost_report' : 'usage_report/messages') : (kind === 'cost' ? 'costs' : 'usage/completions');
    const url = new URL(base + path);
    url.searchParams.set(anthropic ? 'starting_at' : 'start_time', anthropic ? start : String(Date.parse(start) / 1000));
    url.searchParams.set(anthropic ? 'ending_at' : 'end_time', anthropic ? end : String(Math.floor(now.getTime() / 1000)));
    url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31');
    const results: Record<string, unknown>[] = [], seen = new Set<string>();
    for (;;) {
      const page = await http.json(url, headers, signal, undefined, undefined, kind === 'cost');
      for (const bucket of array(page.data).map(object)) results.push(...array(bucket.results).map(object));
      if (results.length > 100_000) throw new NidusError('invalid_response', 'Organization report exceeds local limit.');
      if (page.has_more === false) return results;
      if (page.has_more !== true || typeof page.next_page !== 'string' || !page.next_page || seen.has(page.next_page) || seen.size >= 100) throw new NidusError('invalid_response', 'Invalid organization report pagination.');
      seen.add(page.next_page); url.searchParams.set('page', page.next_page);
    }
  });
  const costs = await retrieve('cost'), usage = await retrieve('usage');
  let total = 0n;
  for (const row of costs) {
    const amount = anthropic ? row : object(row.amount);
    if (String(amount.currency).toUpperCase() !== 'USD') throw new NidusError('invalid_response', 'Organization report did not provide USD.');
    total += reportedMoney(anthropic ? amount.amount : amount.value, anthropic ? -2 : 0);
  }
  const sum = (output: boolean): string | null => {
    if (!usage.length) return null;
    let result = 0n;
    for (const row of usage) {
      const values = !anthropic || output ? [row[output ? 'output_tokens' : 'input_tokens']] :
        [row.uncached_input_tokens, row.cache_read_input_tokens, ...Object.values(object(row.cache_creation ?? {}))];
      if (!values.every(v => count(v) !== null)) return null;
      result += values.reduce<bigint>((n, v) => n + BigInt(v as number), 0n);
    }
    return result.toString();
  };
  return { provider, month, start, end, syncedAt: now.toISOString(), reportedUSD: costs.length ? dollars(total) : null,
    inputTokens: sum(false), outputTokens: sum(true), source: usageCapabilities[provider].source, scope: 'organization',
    note: 'Delayed organization aggregates, potentially including external usage; never reconciled to individual Nidus requests or added to local budget exposure. Empty reports remain unknown. Anthropic excludes Priority Tier costs.' };
}
