// Gemini Free / Gemini Paid and quota tracking, with Google mocked. Nothing here reaches the
// network; tests against a real Google Cloud project are in tests/live/gemini-quota.live.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient, quotaDetail } from '../dist/http.js';
import { NidusError } from '../dist/errors.js';
import { ProviderClient } from '../dist/gateway/providers.js';
import { ModelGateway } from '../dist/gateway/gateway.js';
import { initVault } from '../dist/gateway/vault.js';
import { dispatch } from '../dist/gateway/bridge.js';
import { UsageLog } from '../dist/gateway/usage.js';
import { GoogleAuth, TOKEN_URL, CLOUD_SCOPE } from '../dist/gateway/quota/google-auth.js';
import { GoogleCloud, mapQuotaInfos, mapTimeSeries, readCloud, projectName } from '../dist/gateway/quota/google.js';
import { blockFrom, emptyQuota, limitsFor, localUsage, nextDayStart, pacificDay, quotaRow, tierEvidence, zoneMidnight } from '../dist/gateway/quota/quota.js';

const S = 'generativelanguage.googleapis.com';
// Noon in California (PST): the quota day began at 08:00 UTC and ends at 08:00 UTC tomorrow.
const NOON = '2026-11-15T20:00:00.000Z';

class MemoryCredentials {
  constructor(keys = {}) {
    this.keys = new Map(Object.entries(keys));
    let cloud = null;
    this.cloudKey = { get: async () => cloud, set: async v => { cloud = v; }, delete: async () => { cloud = null; } };
  }
  async get(provider) { return this.keys.get(provider) ?? null; }
  async set(provider, key) { this.keys.set(provider, key); }
  async delete(provider) { this.keys.delete(provider); }
}

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const answer = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 } };
const exhausted = (quotaId, metric, model, value, delay = '31s') => ({ status: 429, headers: {}, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'secret prompt echo sk-should-never-be-kept', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: `${S}/${metric}`, quotaId, quotaDimensions: { location: 'global', model }, quotaValue: String(value) }] },
  { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } } });

/** A Gemini API that answers per key and model: `reply(key, model)` gives a body, or { status, body }. */
function gemini(reply = () => answer) {
  const calls = [];
  const http = new HttpClient(async (url, init) => {
    const target = new URL(String(url)), key = init.headers['x-goog-api-key'];
    if (init.method === 'GET') return new Response(JSON.stringify({ models: MODELS.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 })) }));
    const model = decodeURIComponent(target.pathname.split('/models/')[1].split(':')[0]);
    calls.push({ key, model });
    const out = await reply(key, model);
    return out.status ? new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers }) : new Response(JSON.stringify(out));
  });
  return { providers: new ProviderClient({ http }), calls };
}

const cloudAuth = (result = { token: 'ya29.test', source: 'service-account', user: false, account: 'reader@p.iam.gserviceaccount.com' }) => ({
  reset() {}, async available() { return result instanceof Error ? null : { source: result.source, account: result.account }; },
  async token() { if (result instanceof Error) throw result; return result; },
});

const quotaInfo = (metric, refreshInterval, values) => ({ quotaId: `${metric}-${refreshInterval}`, metric: `${S}/${metric}`, refreshInterval, dimensions: ['model'], dimensionsInfos: Object.entries(values).map(([model, value]) => ({ dimensions: model === '*' ? {} : { model }, details: { value: String(value) } })) });
const FREE_INFOS = [
  quotaInfo('generate_content_free_tier_requests', 'minute', { 'gemini-2.5-flash': 10, 'gemini-2.5-flash-lite': 15 }),
  quotaInfo('generate_content_free_tier_requests', 'day', { 'gemini-2.5-flash': 250, 'gemini-2.5-flash-lite': 1000 }),
  quotaInfo('generate_content_free_tier_input_token_count', 'minute', { 'gemini-2.5-flash': 250000 }),
  quotaInfo('generate_requests_per_model', 'minute', { 'gemini-2.5-flash': 1000 }),
  quotaInfo('generate_content_paid_tier_2_requests', 'minute', { 'gemini-2.5-flash': 2000 }),
];
const series = (limitName, model, points, method) => ({ metric: { type: 'x', labels: { limit_name: limitName, model, ...(method ? { method } : {}) } }, points: points.map(([endTime, value]) => ({ interval: { startTime: endTime, endTime }, value: { int64Value: String(value) } })) });
function fakeCloud({ infos = FREE_INFOS, series: byMetric = {}, billing = false, fail = {} } = {}) {
  const asked = [];
  const guard = name => { asked.push(name); if (fail[name]) throw fail[name]; };
  return { asked,
    async quotaInfos() { guard('quotas'); return infos; },
    async timeSeries(project, token, metricType) { guard('monitoring'); return byMetric[metricType.replace(`${S}/quota/`, '')] ?? []; },
    async billingEnabled() { guard('billing'); return billing; },
  };
}

async function vault(t, table) {
  const root = await mkdtemp(join(tmpdir(), 'nidus-gemini-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { paths } = await initVault(root);
  if (table) await writeFile(paths.modelsFile, JSON.stringify(table));
  return paths;
}
const table = (main, simple = []) => ({ version: 1, roles: { main, 'lead-manager': [], manager: [] }, worker: { simple, normal: [], complex: [] } });
const hello = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

async function gateway(t, { main = ['gemini-free:gemini-2.5-flash'], keys = { 'gemini-free': 'FREE-KEY', 'gemini-paid': 'PAID-KEY' }, reply, cloud = fakeCloud(), auth = cloudAuth(), now = NOON, paths } = {}) {
  paths ??= await vault(t, table(main));
  const api = gemini(reply);
  const credentials = new MemoryCredentials(keys);
  const clock = { at: new Date(now) };
  const make = () => { const g = new ModelGateway(paths, { credentials, providers: api.providers, cloudAuth: auth, cloud, now: () => new Date(clock.at), hedgeDelayMs: null }); t.after(() => { try { g.close(); } catch {} }); return g; };
  const g = make();
  for (const provider of Object.keys(keys)) if (provider !== 'gemini') await g.refreshModels(provider);
  return { g, make, api, credentials, paths, clock, cloud };
}

// 1, 2 ------------------------------------------------------------------------------------------

test('Gemini Free and Gemini Paid are separate providers: own key, own cost, own count', async t => {
  const { g, api } = await gateway(t, { main: ['gemini-free:gemini-2.5-flash'] });
  const free = await g.send({ role: 'main' }, hello);
  assert.deepEqual(api.calls, [{ key: 'FREE-KEY', model: 'gemini-2.5-flash' }]);
  assert.equal(free.response.provider, 'gemini-free');
  assert.equal(Number(free.costUSD), 0, 'a free call costs nothing, and is not "unknown"');
  assert.notEqual(free.costUSD, null);
  assert.deepEqual(free.warnings, []);

  await g.setCandidates('roles.main', ['gemini-paid:gemini-2.5-flash']);
  const paid = await g.send({ role: 'main' }, hello);
  assert.deepEqual(api.calls[1], { key: 'PAID-KEY', model: 'gemini-2.5-flash' });
  assert.equal(paid.response.provider, 'gemini-paid');
  assert.ok(Number(paid.costUSD) > 0, 'a paid call is priced with the Gemini price list');

  const overview = await g.overview();
  assert.deepEqual(overview.providers.filter(p => p.id.startsWith('gemini')).map(p => [p.id, p.name, p.tier, p.connected]), [['gemini-free', 'Gemini Free', 'free', true], ['gemini-paid', 'Gemini Paid', 'paid', true]]);
  const [freeView, paidView] = [await g.quotaView('gemini-free'), await g.quotaView('gemini-paid')];
  assert.deepEqual([freeView.rows[0].rpm.local, freeView.rows[0].tpm.local, freeView.rows[0].rpd.local], [1, 100, 1], 'from usageMetadata of the one free call');
  assert.equal(paidView.rows[0].rpd.local, 1, 'the paid call is counted under the paid provider only');
  await assert.rejects(g.connect('gemini', 'x'), /Gemini Free or Gemini Paid/);
});

// 3 ---------------------------------------------------------------------------------------------

test('the Gemini connection from before the split becomes Gemini Free: key, candidates, model list, checks, history', async t => {
  const paths = await vault(t, table(['gemini:gemini-2.5-flash', 'nvidia:x'], ['gemini:gemini-2.5-flash-lite']));
  await mkdir(paths.modelCache, { recursive: true });
  const model = id => ({ provider: 'gemini', id, name: id, capabilities: { chat: 'unknown', streaming: 'unknown', tools: 'unknown', vision: 'unknown' }, capabilitySource: 's', limits: { inputTokens: 1, outputTokens: 2, contextTokens: null }, details: { supportedGenerationMethods: ['generateContent'] } });
  await writeFile(join(paths.modelCache, 'gemini.json'), JSON.stringify({ version: 1, provider: 'gemini', fetchedAt: '2026-11-01T00:00:00Z', models: MODELS.map(model) }));
  await writeFile(paths.checksFile, JSON.stringify({ 'gemini:gemini-2.5-flash': { text: 'passed', tools: 'passed', detail: 'ok', checkedAt: '2026-11-01T00:00:00Z' } }));
  const log = new UsageLog(paths.usageDb, () => new Date('2026-11-15T19:59:30Z'));
  log.record({ role: 'main', difficulty: null, provider: 'gemini', model: 'gemini-2.5-flash', reason: 'r', candidateIndex: 0, status: 'succeeded', usage: { inputTokens: 40, outputTokens: 1 }, costNano: null, durationMs: 5 });
  log.close();

  const { g, api, credentials, make } = await gateway(t, { paths, keys: { gemini: 'OLD-KEY' } });
  const overview = await g.overview();
  assert.ok(!overview.providers.some(p => p.id === 'gemini'), 'the single Gemini provider is no longer offered');
  const free = overview.providers.find(p => p.id === 'gemini-free');
  assert.deepEqual([free.connected, free.models, free.notice], [true, 2, '이전 Gemini 연결을 옮김']);
  assert.deepEqual(overview.slots.find(s => s.id === 'roles.main').candidates, ['gemini-free:gemini-2.5-flash', 'nvidia:x']);
  assert.equal(overview.slots.find(s => s.id === 'roles.main').resolved, 'gemini-free:gemini-2.5-flash');
  assert.match(await readFile(paths.modelsFile, 'utf8'), /"gemini-free:gemini-2\.5-flash-lite"/);
  assert.equal((await g.modelChoices('gemini-free')).find(m => m.id === 'gemini-2.5-flash').tools, 'passed', 'check results came along');
  assert.equal(credentials.keys.get('gemini'), 'OLD-KEY', 'the old key is not deleted');
  assert.equal(credentials.keys.get('gemini-free'), 'OLD-KEY');

  await g.send({ role: 'main' }, hello);
  assert.deepEqual(api.calls, [{ key: 'OLD-KEY', model: 'gemini-2.5-flash' }], 'calls go on as before');
  const view = await g.quotaView('gemini-free');
  assert.equal(view.migrated, true);
  assert.equal(view.rows.find(r => r.model === 'gemini-2.5-flash').rpd.local, 2, 'today\'s earlier call still counts against the same project');

  // The key belongs to a billed project after all: one step moves everything to Gemini Paid.
  await g.moveGemini('gemini-free', 'gemini-paid');
  const moved = await make().overview();
  assert.deepEqual(moved.providers.filter(p => p.id.startsWith('gemini')).map(p => [p.id, p.connected, p.models, p.notice]), [['gemini-free', false, 0, null], ['gemini-paid', true, 2, null]]);
  assert.deepEqual(moved.slots.find(s => s.id === 'roles.main').candidates, ['gemini-paid:gemini-2.5-flash', 'nvidia:x']);
  assert.equal(credentials.keys.has('gemini-free'), false);
  // Disconnected on purpose: the old key is not taken over a second time.
  assert.equal(await make().hasKey('gemini-free'), false);
  await assert.rejects(g.moveGemini('gemini-paid', 'gemini-paid'), /other Gemini provider/);
});

// 4, 5, 6 ---------------------------------------------------------------------------------------

test('Cloud Quotas: quotaInfos become per-model RPM, TPM and RPD of the provider\'s own tier', () => {
  const free = mapQuotaInfos(FREE_INFOS, 'free');
  assert.deepEqual(free.limits['gemini-2.5-flash'], { rpm: { value: 10, source: 'cloud' }, rpd: { value: 250, source: 'cloud' }, tpm: { value: 250000, source: 'cloud' } });
  assert.deepEqual(free.limits['gemini-2.5-flash-lite'], { rpm: { value: 15, source: 'cloud' }, rpd: { value: 1000, source: 'cloud' } }, 'a limit Google did not give stays absent');
  assert.deepEqual(free.unmapped, ['generate_content_paid_tier_2_requests (minute)', 'generate_requests_per_model (minute)'], 'other tiers\' metrics are not mistaken for this one\'s');
  const paid = mapQuotaInfos(FREE_INFOS, 'paid');
  assert.deepEqual(paid.limits, { 'gemini-2.5-flash': { rpm: { value: 1000, source: 'cloud' } } });
  // Unlimited (-1), missing and malformed values are not numbers to show; a limit without a model applies to all.
  const odd = mapQuotaInfos([quotaInfo('generate_content_free_tier_requests', 'minute', { a: -1, b: 'x', '*': 5 }), { metric: `${S}/generate_content_free_tier_requests`, refreshInterval: 'day', dimensionsInfos: [{ dimensions: { model: 'a' }, details: {} }] }, quotaInfo('generate_content_free_tier_requests', '10 seconds', { a: 1 })], 'free');
  assert.deepEqual(odd.limits, { '*': { rpm: { value: 5, source: 'cloud' } } });
  assert.deepEqual(limitsFor('a', odd.limits), { rpm: { value: 5, source: 'cloud' } });
  assert.deepEqual(limitsFor('a', odd.limits, { a: { rpm: 2, rpd: 20 } }), { rpm: { value: 2, source: 'manual' }, rpd: { value: 20, source: 'manual' } }, 'the user\'s own limit comes first');
});

test('Cloud Monitoring: usage is today\'s sum for a daily limit and the peak minute for a per-minute one', () => {
  const now = new Date(NOON);
  const usage = [
    series('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T07:59:00Z', 99], ['2026-11-15T10:00:00Z', 3], ['2026-11-15T19:50:00Z', 4]], 'GenerateContent'),
    series('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T19:50:00Z', 2]], 'StreamGenerateContent'),
    series('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T18:00:00Z', 50], ['2026-11-15T19:40:00Z', 3], ['2026-11-15T19:50:00Z', 4]], 'GenerateContent'),
    series('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T19:50:00Z', 2]], 'StreamGenerateContent'),
    series('SomethingElse', 'gemini-2.5-flash', [['2026-11-15T19:50:00Z', 7]]),
  ];
  const limit = [series('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T19:00:00Z', 250], ['2026-11-15T19:55:00Z', 200]])];
  const mapped = mapTimeSeries(usage, limit, 'requests', now, pacificDay);
  assert.deepEqual(mapped, { 'gemini-2.5-flash': {
    rpd: { usage: 9, limit: 200, at: '2026-11-15T19:50:00.000Z' },
    rpm: { usage: 6, limit: null, at: '2026-11-15T19:50:00.000Z' },
  } }, 'yesterday\'s points and minutes older than an hour are left out; methods add up; the newest limit wins');
  assert.deepEqual(mapTimeSeries([series('GenerateContentInputTokensPerModelPerMinute-FreeTier', 'm', [['2026-11-15T19:58:00Z', 1200]])], [], 'tokens', now, pacificDay), { m: { tpm: { usage: 1200, limit: null, at: '2026-11-15T19:58:00.000Z' } } });
});

test('refreshing reads limits, Google\'s own count and billing; the screen keeps limit, local count and observed count apart', async t => {
  const cloud = fakeCloud({ series: {
    'generate_content_free_tier_requests/usage': [series('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T19:50:00Z', 41]])],
    'generate_content_free_tier_requests/limit': [series('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'gemini-2.5-flash', [['2026-11-15T19:55:00Z', 250]])],
  } });
  const { g } = await gateway(t, { cloud });
  await assert.rejects(g.refreshQuota('gemini-free'), /프로젝트 ID/);
  await assert.rejects(g.setProviderSettings('gemini-free', { project: 'Not A Project!' }), { code: 'invalid_request' });
  await g.setProviderSettings('gemini-free', { project: 'my-free-project' });
  await g.send({ role: 'main' }, hello);
  const view = await g.refreshQuota('gemini-free');
  assert.deepEqual(cloud.asked.sort(), ['billing', 'monitoring', 'monitoring', 'monitoring', 'monitoring', 'quotas']);
  assert.deepEqual([view.project, view.fetchedAt, view.errors, view.billing], ['my-free-project', NOON, {}, { enabled: false, checkedAt: NOON }]);
  assert.deepEqual(view.auth, { source: 'service-account', account: 'reader@p.iam.gserviceaccount.com' });
  const row = view.rows.find(r => r.model === 'gemini-2.5-flash');
  assert.deepEqual(row.rpd, { local: 1, limit: 250, source: 'cloud', observed: { usage: 41, limit: 250, at: '2026-11-15T19:50:00.000Z' } }, '1 call from here, 41 seen by Google across all callers: shown side by side, never added');
  assert.deepEqual(row.rpm, { local: 1, limit: 10, source: 'cloud', observed: null });
  assert.deepEqual([row.tpm.local, row.tpm.limit, row.status], [100, 250000, 'available']);
  assert.equal(view.resetAt, '2026-11-16T08:00:00.000Z', 'midnight Pacific time');
  assert.equal(view.otherModels, 1, 'a model nothing here uses is counted, not listed');
  assert.deepEqual((await g.quotaView('gemini-free', true)).rows.map(r => r.model), MODELS);
});

// 7, 8 ------------------------------------------------------------------------------------------

test('when Google gives no limits nothing is guessed: Unknown, manual limits, and calls go on', async t => {
  const { g, api } = await gateway(t, { cloud: fakeCloud({ infos: [] }) });
  await g.setProviderSettings('gemini-free', { project: 'my-free-project' });
  const view = await g.refreshQuota('gemini-free');
  assert.match(view.errors.quotas, /모델별 제한을 돌려주지 않았습니다/);
  assert.deepEqual([view.rows[0].status, view.rows[0].rpm.limit, view.rows[0].rpd.limit], ['unknown', null, null]);
  await g.send({ role: 'main' }, hello);
  assert.equal(api.calls.length, 1, 'no limits known is not a reason to stop calling');

  const manual = await g.setProviderSettings('gemini-free', { limits: { 'gemini-2.5-flash': { rpm: 2, rpd: 100 } } });
  assert.deepEqual(manual.rows[0].rpm, { local: 1, limit: 2, source: 'manual', observed: null });
  assert.equal(manual.rows[0].status, 'available');
  await g.send({ role: 'main' }, hello);
  assert.deepEqual([(await g.quotaView('gemini-free')).rows[0].status, (await g.quotaView('gemini-free')).rows[0].detail], ['limited', '이 Vault의 호출만으로 분당 요청 제한에 닿았습니다']);
  await assert.rejects(g.setProviderSettings('gemini-free', { limits: { m: { rpm: -1 } } }), { code: 'invalid_request' });
  assert.deepEqual((await g.setProviderSettings('gemini-free', { limits: {} })).manual, {});
});

test('no permission, an expired sign-in or no sign-in: each source says why, and model calls are untouched', async t => {
  const denied = new NidusError('permission', 'x', 403), gone = Object.assign(new NidusError('authentication', 'x'), { reason: 'cloud_auth_expired' });
  const partial = await gateway(t, { cloud: fakeCloud({ fail: { quotas: denied, billing: new NidusError('not_found', 'x', 404) } }) });
  await partial.g.setProviderSettings('gemini-free', { project: 'my-free-project' });
  const view = await partial.g.refreshQuota('gemini-free');
  assert.match(view.errors.quotas, /권한이 없거나.*Cloud Quotas API.*cloudquotas\.quotas\.get/);
  assert.match(view.errors.billing, /프로젝트를 찾을 수 없습니다/);
  assert.equal(view.errors.monitoring, undefined, 'the source that worked still counts');
  assert.equal(view.billing, null);

  for (const [error, text] of [[gone, /만료됐거나 거부/], [Object.assign(new NidusError('authentication', 'x'), { reason: 'cloud_auth_missing' }), /로그인이 설정되지 않았습니다/]]) {
    const { g, api, cloud } = await gateway(t, { auth: cloudAuth(error) });
    await g.setProviderSettings('gemini-free', { project: 'my-free-project' });
    const failed = await g.refreshQuota('gemini-free');
    assert.match(failed.errors.auth, text);
    assert.deepEqual([cloud.asked, failed.auth, failed.rows[0].status], [[], null, 'unknown']);
    await g.send({ role: 'main' }, hello);
    assert.deepEqual(api.calls, [{ key: 'FREE-KEY', model: 'gemini-2.5-flash' }], 'the call used the free key: a failed lookup never moves work to the paid provider');
  }
});

test('Google Cloud sign-in: a service account key is exchanged at Google only; refusals are told apart; secrets stay out of errors', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', client_email: 'reader@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: TOKEN_URL });
  const posts = [];
  const fetcher = reply => async (url, init) => { posts.push({ url: String(url), body: new URLSearchParams(init.body) }); return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 }); };
  const empty = await mkdtemp(join(tmpdir(), 'nidus-home-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const base = { env: {}, home: empty, gcloud: async () => { throw new Error('no gcloud'); }, now: () => Date.parse(NOON) };

  const auth = new GoogleAuth({ ...base, secret: async () => key, fetcher: fetcher({ body: { access_token: 'ya29.abc', expires_in: 3600 } }) });
  assert.deepEqual(await auth.available(), { source: 'service-account', account: 'reader@p.iam.gserviceaccount.com' });
  assert.deepEqual(await auth.token(), { token: 'ya29.abc', source: 'service-account', user: false, account: 'reader@p.iam.gserviceaccount.com' });
  await auth.token();
  assert.equal(posts.length, 1, 'the token is reused until it is about to expire');
  assert.equal(posts[0].url, TOKEN_URL);
  const [header, claims, signature] = posts[0].body.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: 'reader@p.iam.gserviceaccount.com', scope: CLOUD_SCOPE, aud: TOKEN_URL, iat: Date.parse(NOON) / 1000, exp: Date.parse(NOON) / 1000 + 3600 });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));

  // A key file that names another token endpoint is not followed.
  posts.length = 0;
  await assert.rejects(new GoogleAuth({ ...base, secret: async () => JSON.stringify({ ...JSON.parse(key), token_uri: 'https://evil.example/token' }), fetcher: fetcher({ body: {} }) }).token(), { reason: 'cloud_auth_invalid' });
  assert.equal(posts.length, 0);

  // gcloud's user credentials: a refresh that Google no longer accepts is "expired", not "missing".
  await mkdir(join(empty, '.config', 'gcloud'), { recursive: true });
  await writeFile(join(empty, '.config', 'gcloud', 'application_default_credentials.json'), JSON.stringify({ type: 'authorized_user', client_id: 'id', client_secret: 'CLIENT-SECRET', refresh_token: 'REFRESH-TOKEN' }));
  const user = new GoogleAuth({ ...base, fetcher: fetcher({ body: { access_token: 'ya29.user' } }) });
  assert.deepEqual(await user.token(), { token: 'ya29.user', source: 'adc-user', user: true, account: null });
  assert.equal(posts[0].body.get('grant_type'), 'refresh_token');
  const expired = await new GoogleAuth({ ...base, fetcher: fetcher({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked. REFRESH-TOKEN' } }) }).token().catch(e => e);
  assert.equal(expired.reason, 'cloud_auth_expired');
  assert.ok(!JSON.stringify(expired).includes('REFRESH-TOKEN') && !expired.message.includes('SECRET'));

  const nothing = await mkdtemp(join(tmpdir(), 'nidus-home-'));
  t.after(() => rm(nothing, { recursive: true, force: true }));
  assert.equal(await new GoogleAuth({ ...base, home: nothing }).available(), null);
  await assert.rejects(new GoogleAuth({ ...base, home: nothing }).token(), { code: 'authentication', reason: 'cloud_auth_missing' });
  assert.deepEqual(await new GoogleAuth({ ...base, home: nothing, gcloud: async () => 'ya29.from-gcloud-cli-token-value\n' }).token(), { token: 'ya29.from-gcloud-cli-token-value', source: 'gcloud', user: true, account: null });
});

test('the Cloud APIs are asked with a bearer token, the project named for a person\'s credentials, and every page read', async () => {
  const seen = [];
  const http = new HttpClient(async (url, init) => {
    seen.push({ url: new URL(String(url)), headers: init.headers, method: init.method });
    const page = new URL(String(url)).searchParams.get('pageToken');
    return new Response(JSON.stringify(String(url).includes('cloudquotas') ? { quotaInfos: [{ quotaId: page ?? 'first' }], ...(page ? {} : { nextPageToken: 'p2' }) } : String(url).includes('monitoring') ? { timeSeries: [{}] } : { billingEnabled: true }));
  });
  const cloud = new GoogleCloud(http);
  const sa = { token: 'T', source: 'service-account', user: false, account: 'a' }, person = { token: 'U', source: 'adc-user', user: true, account: null };
  assert.deepEqual(await cloud.quotaInfos('my-project', sa), [{ quotaId: 'first' }, { quotaId: 'p2' }]);
  assert.equal(seen[0].url.href, `https://cloudquotas.googleapis.com/v1/projects/my-project/locations/global/services/${S}/quotaInfos?pageSize=500`);
  assert.deepEqual([seen[0].method, seen[0].headers.authorization, seen[0].headers['x-goog-user-project']], ['GET', 'Bearer T', undefined]);
  await cloud.timeSeries('my-project', person, `${S}/quota/generate_content_free_tier_requests/usage`, new Date('2026-11-15T08:00:00Z'), new Date(NOON));
  const monitoring = seen.at(-1);
  assert.equal(monitoring.url.origin + monitoring.url.pathname, 'https://monitoring.googleapis.com/v3/projects/my-project/timeSeries');
  assert.deepEqual([monitoring.url.searchParams.get('filter'), monitoring.url.searchParams.get('interval.startTime'), monitoring.url.searchParams.get('interval.endTime'), monitoring.url.searchParams.get('view')],
    [`metric.type="${S}/quota/generate_content_free_tier_requests/usage"`, '2026-11-15T08:00:00.000Z', NOON, 'FULL']);
  assert.equal(monitoring.headers['x-goog-user-project'], 'my-project');
  assert.equal(await cloud.billingEnabled('123456789', sa), true);
  assert.equal(seen.at(-1).url.href, 'https://cloudbilling.googleapis.com/v1/projects/123456789/billingInfo');
  for (const bad of ['', 'a/b', '../x', 'UPPER', 'x']) assert.throws(() => projectName(bad), { code: 'invalid_request' });
});

// 9 ---------------------------------------------------------------------------------------------

test('a 429 is read from its structured details only; the model rests for the window the server named', async t => {
  const daily = exhausted('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'generate_content_free_tier_requests', 'gemini-2.5-flash', 250);
  const detail = quotaDetail(daily.body.error.details);
  assert.deepEqual(detail, { violations: [{ metric: `${S}/generate_content_free_tier_requests`, id: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', model: 'gemini-2.5-flash', value: 250 }], retryDelaySec: 31 });
  assert.equal(quotaDetail([{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'bad metric with spaces', quotaId: '<script>' }] }]), null, 'only names of the expected shape are kept');
  assert.equal(quotaDetail('nope'), null);
  const now = new Date(NOON);
  assert.deepEqual(blockFrom(detail, null, now, pacificDay), { kind: 'rpd', until: '2026-11-16T08:00:00.000Z', at: NOON, quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }, 'a daily quota comes back at midnight Pacific, not in the 31 seconds suggested');
  const minute = quotaDetail(exhausted('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'generate_content_free_tier_requests', 'm', 10, '12.5s').body.error.details);
  assert.deepEqual([blockFrom(minute, null, now, pacificDay).kind, blockFrom(minute, null, now, pacificDay).until], ['rpm', '2026-11-15T20:00:12.500Z']);
  const tokens = quotaDetail(exhausted('GenerateContentInputTokensPerModelPerMinute-FreeTier', 'generate_content_free_tier_input_token_count', 'm', 250000).body.error.details);
  assert.equal(blockFrom(tokens, null, now, pacificDay).kind, 'tpm');
  assert.deepEqual([blockFrom(undefined, '7', now, pacificDay).kind, blockFrom(undefined, '7', now, pacificDay).until], ['unknown', '2026-11-15T20:00:07.000Z'], 'Retry-After alone still gives a time');
  assert.equal(blockFrom(undefined, null, now, pacificDay).until, '2026-11-15T20:01:00.000Z');
  assert.deepEqual([tierEvidence(detail).evidence, tierEvidence(quotaDetail(exhausted('GenerateContentPaidTierInputTokensPerModelPerMinute', 'generate_content_paid_tier_input_token_count', 'm', 1).body.error.details)).evidence, tierEvidence(undefined)], ['free', 'paid', null]);
  // Daylight saving: the day in California is 23 or 25 hours long twice a year.
  assert.equal(zoneMidnight(new Date('2026-03-08T12:00:00Z'), 'America/Los_Angeles').toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(nextDayStart(pacificDay, new Date('2026-03-08T12:00:00Z')).toISOString(), '2026-03-09T07:00:00.000Z');

  const { g, api, clock, make } = await gateway(t, { main: ['gemini-free:gemini-2.5-flash', 'gemini-free:gemini-2.5-flash-lite'], reply: (key, model) => model === 'gemini-2.5-flash' ? daily : answer });
  const error = await g.send({ role: 'main' }, hello).catch(e => e);
  assert.deepEqual([error.code, error.status, error.retryAfter, error.modelRef], ['rate_limit', 429, '31', 'gemini-free:gemini-2.5-flash']);
  assert.ok(!JSON.stringify(error).includes('sk-should-never-be-kept') && !error.message.includes('secret'), 'the provider\'s free text is not kept');
  const row = (await g.quotaView('gemini-free')).rows.find(r => r.model === 'gemini-2.5-flash');
  assert.deepEqual([row.status, row.blockedUntil, row.detail, row.rpd.limit, row.rpd.source], ['limited', '2026-11-16T08:00:00.000Z', '서버가 하루 요청 초과를 알렸습니다', 250, 'server']);
  assert.deepEqual((await g.quotaView('gemini-free')).tierEvidence, { evidence: 'free', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', at: NOON });

  // The next call goes to the other free model at once, and the exhausted one is not asked again today.
  const next = await g.send({ role: 'main' }, hello);
  assert.equal(next.response.model, 'gemini-2.5-flash-lite');
  assert.match(next.assignment.reason, /fallback #1/);
  assert.deepEqual(api.calls.map(c => c.model), ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  // 10: a restart keeps both the count and the block.
  const again = make();
  assert.equal((await again.send({ role: 'main' }, hello)).response.model, 'gemini-2.5-flash-lite');
  const restored = await again.quotaView('gemini-free');
  assert.deepEqual(restored.rows.map(r => [r.model, r.rpd.local, r.status]), [['gemini-2.5-flash', 1, 'limited'], ['gemini-2.5-flash-lite', 2, 'unknown']], 'no limit is known for the second model: unknown, not available');
  // After midnight Pacific the model is tried again, and the count starts over.
  clock.at = new Date('2026-11-16T08:00:01Z');
  assert.deepEqual((await again.quotaView('gemini-free')).rows.map(r => [r.model, r.rpd.local, r.status]), [['gemini-2.5-flash', 0, 'available'], ['gemini-2.5-flash-lite', 0, 'unknown']]);
  await again.send({ role: 'main' }, hello).catch(() => {});
  assert.equal(api.calls.at(-1).model, 'gemini-2.5-flash', 'the server decides: it is asked again once the window has passed');
});

// 12 --------------------------------------------------------------------------------------------

test('a free model that is exhausted is never replaced by the paid provider unless the user allowed it', async t => {
  const limit = exhausted('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'generate_content_free_tier_requests', 'gemini-2.5-flash', 10);
  const { g, api } = await gateway(t, { main: ['gemini-free:gemini-2.5-flash', 'gemini-paid:gemini-2.5-flash'], reply: key => key === 'FREE-KEY' ? limit : answer });
  const slot = (await g.overview()).slots.find(s => s.id === 'roles.main');
  assert.equal(slot.resolved, 'gemini-free:gemini-2.5-flash');
  for (let i = 0; i < 3; i++) await assert.rejects(g.send({ role: 'main' }, hello), { code: 'rate_limit' });
  assert.ok(api.calls.every(c => c.key === 'FREE-KEY'), 'three refusals in a row: still no paid call');
  assert.equal((await g.quotaView('gemini-paid')).allowFallback, false);
  // Listed first, the paid provider is the user's explicit choice.
  await g.setCandidates('roles.manager', ['gemini-paid:gemini-2.5-flash']);
  assert.equal((await g.send({ role: 'manager' }, hello)).response.provider, 'gemini-paid');

  // Allowed as a fallback: only then does the paid model take over.
  assert.equal((await g.setProviderSettings('gemini-paid', { allowFallback: 'yes' })).allowFallback, false, 'only an explicit true turns it on');
  assert.equal((await g.setProviderSettings('gemini-free', { allowFallback: true })).allowFallback, false, 'the free provider has no such switch');
  assert.equal((await g.setProviderSettings('gemini-paid', { allowFallback: true })).allowFallback, true);
  const paid = await g.send({ role: 'main' }, hello);
  assert.deepEqual([paid.response.provider, api.calls.at(-1).key], ['gemini-paid', 'PAID-KEY']);
  assert.match(paid.assignment.reason, /fallback #1/);
});

test('Gemini Free stops calling as soon as its project looks billed', async t => {
  // Billing is linked to the project (Cloud Billing says so).
  const billed = await gateway(t, { cloud: fakeCloud({ billing: true }) });
  await billed.g.setProviderSettings('gemini-free', { project: 'my-free-project' });
  const view = await billed.g.refreshQuota('gemini-free');
  assert.match(view.risk, /결제 계정이 연결돼 있습니다/);
  await assert.rejects(billed.g.send({ role: 'main' }, hello), /No usable model.*looks billed/);
  await assert.rejects(billed.g.checkModel('gemini-free', 'gemini-2.5-flash').then(c => { if (c.text !== 'passed') throw new Error(c.detail); }), /billing_risk/);
  assert.deepEqual(billed.api.calls, [], 'not one request left this machine');
  assert.equal((await billed.g.overview()).providers.find(p => p.id === 'gemini-free').notice, '과금 위험: 호출 멈춤');

  // The server answers with a paid-tier quota: the key is of a billed project.
  const paidQuota = exhausted('GenerateContentPaidTierInputTokensPerModelPerMinute', 'generate_content_paid_tier_input_token_count', 'gemini-2.5-flash', 1000000);
  const leaked = await gateway(t, { reply: () => paidQuota });
  await assert.rejects(leaked.g.send({ role: 'main' }, hello), { code: 'rate_limit' });
  await assert.rejects(leaked.g.send({ role: 'main' }, hello), /looks billed/);
  assert.equal(leaked.api.calls.length, 1);
  assert.match((await leaked.g.quotaView('gemini-free')).risk, /유료 등급 할당량\(GenerateContentPaidTierInputTokensPerModelPerMinute\)/);

  // 11: both providers on one project. Quota is per project, and a billed project has no free quota.
  const same = await gateway(t);
  await same.g.setProviderSettings('gemini-free', { project: 'shared-project' });
  const paidView = await same.g.setProviderSettings('gemini-paid', { project: 'shared-project' });
  assert.match(paidView.warnings[0], /같은 프로젝트/);
  assert.match((await same.g.quotaView('gemini-free')).risk, /같은 프로젝트/);
  await assert.rejects(same.g.send({ role: 'main' }, hello), /looks billed/);
  assert.deepEqual(same.api.calls, []);
  // The paid provider itself is told when its project turns out to be on the free tier.
  const unbilled = await gateway(t, { main: ['gemini-paid:gemini-2.5-flash'], cloud: fakeCloud({ billing: false }) });
  await unbilled.g.setProviderSettings('gemini-paid', { project: 'my-paid-project' });
  assert.match((await unbilled.g.refreshQuota('gemini-paid')).warnings.join(' '), /결제 계정이 연결돼 있지 않습니다/);
});

test('local counting: only calls that reached Google, per window, and a second key of the same project is not seen', () => {
  const now = new Date(NOON);
  const row = (at, model = 'm', extra = {}) => ({ model, at, input: 100, status: 'succeeded', error: null, ...extra });
  const usage = localUsage([
    row('2026-11-15T07:59:59Z'),                                                    // yesterday in California
    row('2026-11-15T12:00:00Z'), row('2026-11-15T19:58:59Z'),                       // today, not this minute
    row('2026-11-15T19:59:30Z'), row('2026-11-15T19:59:50Z', 'm', { input: null }), // this minute
    row('2026-11-15T19:59:55Z', 'm', { status: 'failed', error: 'rate_limit', input: null }),   // refused, but it was a request
    row('2026-11-15T19:59:56Z', 'm', { status: 'failed', error: 'billing_risk' }), row('2026-11-15T19:59:57Z', 'm', { status: 'failed', error: 'missing_key' }), // never sent
    row('2026-11-15T19:59:40Z', 'other'),
  ], now, pacificDay);
  assert.deepEqual(Object.fromEntries(usage), { m: { rpm: 3, tpm: 100, rpd: 5 }, other: { rpm: 1, tpm: 100, rpd: 1 } });
  // What Nidus counted and what Google counted differ when something else uses the project: both are shown.
  const quota = { ...emptyQuota(), limits: { m: { rpd: { value: 250, source: 'cloud' } } }, observed: { m: { rpd: { usage: 180, limit: 250, at: '2026-11-15T19:50:00.000Z' } } } };
  const shown = quotaRow('m', quota, usage.get('m'), {}, now);
  assert.deepEqual([shown.rpd.local, shown.rpd.observed.usage, shown.rpd.limit, shown.status], [5, 180, 250, 'available']);
});

test('the app bridge: quota view, settings and the Cloud key never echo a secret', async t => {
  const paths = await vault(t, table(['gemini-free:gemini-2.5-flash']));
  const credentials = new MemoryCredentials({ 'gemini-free': 'FREE-KEY' });
  const api = gemini();
  const call = (method, extra = {}) => dispatch({ method, vault: paths.root, ...extra }, { credentials, providers: api.providers });
  await call('refresh', { provider: 'gemini-free' });
  const set = await call('provider-settings', { provider: 'gemini-free', project: 'my-free-project' });
  assert.deepEqual([set.provider, set.tier, set.project, set.connected], ['gemini-free', 'free', 'my-free-project', true]);
  const view = await call('quota', { provider: 'gemini-free' });
  assert.deepEqual(view.rows.map(r => [r.model, r.status]), [['gemini-2.5-flash', 'unknown']]);
  await assert.rejects(call('quota', { provider: 'openai' }), /Gemini Free and Gemini Paid/);
  await assert.rejects(call('connect', { provider: 'gemini', key: 'x' }), /Provider must be one of/);
  const bad = await call('cloud-key-set', { key: '{"type":"service_account","private_key":"SECRET-PEM"}' }).catch(e => e);
  assert.equal(bad.reason, 'cloud_auth_invalid');
  assert.ok(!JSON.stringify(bad).includes('SECRET-PEM'));
  assert.equal(await credentials.cloudKey.get(), null, 'a key that cannot be used is not stored');
  assert.deepEqual(await call('cloud-key-clear'), { cleared: true });
  // Signing in needs the OAuth client file the first time; a web client is refused before any browser opens.
  await assert.rejects(call('cloud-sign-in'), /Choose the OAuth client file first/);
  const web = await call('cloud-sign-in', { client: '{"web":{"client_id":"a.apps.googleusercontent.com","client_secret":"WEB-SECRET"}}' }).catch(e => e);
  assert.equal(web.reason, 'oauth_client_web');
  assert.ok(!JSON.stringify(web).includes('WEB-SECRET'));
});

test('signing in with a Google account: the browser comes back to 127.0.0.1 with a code, the code is exchanged at Google only, and the refresh token is what is stored', async t => {
  const { signIn, parseOAuthClient, AUTH_URL, SIGN_IN_SCOPES } = await import('../dist/gateway/quota/google-login.js');
  const { storedUser, GoogleAuth } = await import('../dist/gateway/quota/google-auth.js');
  const consoleFile = JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'CLIENT-SECRET', redirect_uris: ['http://localhost'] } });
  assert.deepEqual(parseOAuthClient(consoleFile), { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'CLIENT-SECRET' });
  assert.throws(() => parseOAuthClient(JSON.stringify({ web: { client_id: 'abc.apps.googleusercontent.com', client_secret: 's' } })), { reason: 'oauth_client_web' });
  assert.throws(() => parseOAuthClient('{"type":"service_account"}'), { reason: 'oauth_client_invalid' });

  const posts = [];
  const idToken = `h.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.s`;
  const fetcher = async (url, init) => { posts.push({ url: String(url), body: new URLSearchParams(init.body) }); return new Response(JSON.stringify({ access_token: 'ya29.x', refresh_token: 'REFRESH', id_token: idToken, expires_in: 3599 })); };
  // The test plays the browser: it follows the sign-in URL's redirect_uri back with a code.
  const browser = async url => {
    const open = new URL(url);
    assert.equal(open.origin + open.pathname, AUTH_URL);
    assert.equal(open.searchParams.get('scope'), SIGN_IN_SCOPES.join(' '));
    assert.equal(open.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(open.searchParams.get('prompt'), 'consent');
    const back = new URL(open.searchParams.get('redirect_uri'));
    assert.equal(back.hostname, '127.0.0.1');
    back.searchParams.set('code', 'CODE-1');
    back.searchParams.set('state', open.searchParams.get('state'));
    const page = await fetch(back);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /로그인됐습니다/);
  };
  const user = await signIn(parseOAuthClient(consoleFile), { open: browser, fetcher });
  assert.deepEqual(user, { type: 'authorized_user', client_id: 'abc.apps.googleusercontent.com', client_secret: 'CLIENT-SECRET', refresh_token: 'REFRESH', account: 'me@example.com' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, TOKEN_URL);
  assert.equal(posts[0].body.get('grant_type'), 'authorization_code');
  assert.equal(posts[0].body.get('code'), 'CODE-1');
  assert.ok(posts[0].body.get('code_verifier'));

  // GoogleAuth then uses what was stored, and names the account.
  const stored = JSON.stringify(user);
  assert.deepEqual(storedUser(stored), { client_id: 'abc.apps.googleusercontent.com', client_secret: 'CLIENT-SECRET', account: 'me@example.com' });
  const auth = new GoogleAuth({ env: {}, home: '/nonexistent', gcloud: async () => { throw new Error('no'); }, secret: async () => stored, fetcher: async () => new Response(JSON.stringify({ access_token: 'ya29.user' })) });
  assert.deepEqual(await auth.available(), { source: 'user', account: 'me@example.com' });
  assert.deepEqual(await auth.token(), { token: 'ya29.user', source: 'user', user: true, account: 'me@example.com' });

  // Declined in the browser, or a reply with the wrong state: no exchange happens.
  posts.length = 0;
  const declined = signIn(parseOAuthClient(consoleFile), { fetcher, open: async url => {
    const open = new URL(url);
    const wrong = new URL(open.searchParams.get('redirect_uri')); wrong.searchParams.set('code', 'X'); wrong.searchParams.set('state', 'forged');
    assert.equal((await fetch(wrong)).status, 400);
    const back = new URL(open.searchParams.get('redirect_uri')); back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', open.searchParams.get('state'));
    await fetch(back);
  } });
  await assert.rejects(declined, { reason: 'sign_in_declined' });
  assert.equal(posts.length, 0);
  await assert.rejects(signIn(parseOAuthClient(consoleFile), { fetcher, open: async () => {}, timeoutMs: 50 }), { reason: 'sign_in_timeout' });
  const refused = signIn(parseOAuthClient(consoleFile), { fetcher: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }), open: async url => {
    const open = new URL(url); const back = new URL(open.searchParams.get('redirect_uri')); back.searchParams.set('code', 'C'); back.searchParams.set('state', open.searchParams.get('state')); await fetch(back);
  } });
  const error = await refused.catch(e => e);
  assert.equal(error.reason, 'sign_in_failed');
  assert.ok(!JSON.stringify(error).includes('CLIENT-SECRET'));
});
