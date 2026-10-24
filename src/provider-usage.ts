import type { ProviderId, RequestOptions } from './types.js';
import { bounded, HttpClient, array, object, keyValue } from './http.js';
import { NidusError } from './errors.js';
export const usageCapabilities = {
  openai: { requestTokens: true, accountUsage: 'admin-api-not-connected', actualCosts: 'organization-costs-admin-api', credits: 'not-connected', source: 'https://platform.openai.com/docs/api-reference/usage', credential: 'Separate organization Admin API key required; inference credentials are never reused.' },
  anthropic: { requestTokens: true, accountUsage: 'admin-api-not-connected', actualCosts: 'organization-cost-report-admin-api', credits: 'not-connected', source: 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api', credential: 'Separate Admin API key required; inference credentials are never reused.' },
  gemini: { requestTokens: true, accountUsage: 'cloud-billing-not-connected', actualCosts: 'cloud-billing-export-not-connected', credits: 'not-connected', source: 'https://ai.google.dev/gemini-api/docs/billing', credential: 'Cloud Billing IAM is separate from the inference API key.' },
  deepseek: { requestTokens: true, accountUsage: 'local-only', actualCosts: 'no-documented-request-cost-api', credits: 'user-balance-api', source: 'https://api-docs.deepseek.com/api/get-user-balance/', credential: 'User balance API accepts the inference bearer credential.' }
} satisfies Record<ProviderId, object>;
export async function deepseekBalance(key: string, http = new HttpClient(), options: RequestOptions = {}) {
  const raw = await bounded(options, signal => http.json('https://api.deepseek.com/user/balance', { authorization: `Bearer ${keyValue(key)}` }, signal));
  const usd = array(raw.balance_infos).map(object).find(r => r.currency === 'USD');
  if (usd && (typeof usd.total_balance !== 'string' || !/^\d+(\.\d+)?$/.test(usd.total_balance))) throw new NidusError('invalid_response', 'Invalid provider USD balance.');
  return { usd: usd ? usd.total_balance as string : null, source: usageCapabilities.deepseek.source };
}
