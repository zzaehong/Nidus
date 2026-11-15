// Against a real Google Cloud project. Explicit opt-in only; nothing here calls a model.
//   NIDUS_LIVE=1 NIDUS_LIVE_GCP_PROJECT=<project id> [NIDUS_LIVE_GEMINI_TIER=free|paid] npm run test:live
// Sign-in: GOOGLE_APPLICATION_CREDENTIALS, or "gcloud auth application-default login", or gcloud itself.
// Without a project and a sign-in these tests are reported as NOT RUN, never as passed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleAuth } from '../../dist/gateway/quota/google-auth.js';
import { GoogleCloud, mapQuotaInfos, mapTimeSeries, METRICS, SERVICE } from '../../dist/gateway/quota/google.js';
import { pacificDay } from '../../dist/gateway/quota/quota.js';

const project = process.env.NIDUS_LIVE_GCP_PROJECT;
const tier = process.env.NIDUS_LIVE_GEMINI_TIER === 'paid' ? 'paid' : 'free';
const auth = new GoogleAuth();
const signedIn = process.env.NIDUS_LIVE === '1' && project ? await auth.available().catch(() => null) : null;
const skip = process.env.NIDUS_LIVE !== '1' ? 'NOT RUN: NIDUS_LIVE=1 not set' : !project ? 'NOT RUN: NIDUS_LIVE_GCP_PROJECT not set' : !signedIn ? 'NOT RUN: no Google Cloud sign-in on this machine' : false;
const cloud = new GoogleCloud();

test(`LIVE Cloud Quotas: quotaInfos of ${SERVICE} map to per-model limits`, { skip }, async () => {
  const infos = await cloud.quotaInfos(project, await auth.token());
  assert.ok(infos.length > 0, 'the project returned no quotaInfos for the Gemini API');
  const mapped = mapQuotaInfos(infos, tier);
  // Shown so the mapping can be checked against AI Studio by eye; metric and model names only.
  console.log(`quotaInfos: ${infos.length}; models with a ${tier} limit: ${Object.keys(mapped.limits).length}; not understood: ${mapped.unmapped.join(', ') || 'none'}`);
  for (const [model, limits] of Object.entries(mapped.limits).slice(0, 8)) console.log(`  ${model}: rpm ${limits.rpm?.value ?? '-'} tpm ${limits.tpm?.value ?? '-'} rpd ${limits.rpd?.value ?? '-'}`);
  assert.ok(Object.keys(mapped.limits).length > 0, `no ${tier}-tier limit was recognised: the metric names may have changed`);
});

test('LIVE Cloud Monitoring: quota usage and limit series are readable and carry model and limit_name', { skip }, async () => {
  const now = new Date(), token = await auth.token();
  for (const [metric, what] of Object.entries(METRICS[tier])) {
    const [usage, limit] = await Promise.all(['usage', 'limit'].map(suffix => cloud.timeSeries(project, token, `${SERVICE}/quota/${metric}/${suffix}`, pacificDay.dayStart(now), now)));
    console.log(`${metric}: ${usage.length} usage series, ${limit.length} limit series; limit names: ${[...new Set([...usage, ...limit].map(s => s.metric?.labels?.limit_name))].join(', ') || 'none'}`);
    const mapped = mapTimeSeries(usage, limit, what, now, pacificDay);
    if (usage.length + limit.length) assert.ok(Object.keys(mapped).length > 0, 'series arrived but none was understood: the labels may have changed');
  }
});

test('LIVE Cloud Billing: whether a billing account is linked', { skip }, async () => {
  const enabled = await cloud.billingEnabled(project, await auth.token());
  console.log(`billingEnabled: ${enabled}`);
  assert.equal(typeof enabled, 'boolean');
  if (tier === 'free') assert.equal(enabled, false, 'this project has billing: it is not a free-tier project');
});
