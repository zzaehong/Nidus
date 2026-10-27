import { expandedProviders, providerMetadata, reviewedFreeModels } from './providers.js';
import { modelProfile, gradeTier, difficulty, type Difficulty, type Tier } from './router.js';
import type { AccountReport } from './provider-usage.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { rateLimitHeaders } from './http.js';
import { NidusError } from './errors.js';
import { dollars, money } from './money.js';
import { calculatedCost, priceFor, priceVersion, upperCost, type Price } from './pricing.js';
import { providerIds, type ChatRequest, type ProviderId, type Usage } from './types.js';

export type BudgetScope = 'total' | 'request' | ProviderId;
export type TaskKind = 'chat' | 'probe';
export interface TrackedRequest { id: string; price: Price; bound: bigint | null; billingMode: 'free' | 'paid' }
export function validateAccountPermission(state: unknown, paidAllowed: unknown, confirmed: unknown, riskAccepted: unknown, fingerprint: string, accountId: unknown = '') {
    if (!['free_only','hybrid','paid_only','unknown'].includes(String(state)) || typeof state !== 'string' || typeof paidAllowed !== 'boolean' || typeof accountId !== 'string' || !/^[a-zA-Z0-9:_-]{0,128}$/.test(accountId))
      throw new NidusError('invalid_request', 'Invalid account billing settings.');
    if (!fingerprint || (state !== 'unknown' && (confirmed !== true || riskAccepted !== true)) || (paidAllowed && !['hybrid','paid_only'].includes(state)))
      throw new NidusError('invalid_request', 'Confirm account billing type and charge risk; paid permission requires Hybrid or Paid Only.');
}
type Row = Record<string, string | bigint | null>;
export const ledgerPath = () => join(homedir(), '.local', 'share', 'nidus', 'usage.sqlite');
export class UsageLedger {
  private db: DatabaseSync;
  constructor(path = ledgerPath(), private readonly now: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schema.user_version > 8) { this.db.close(); throw new NidusError('storage', 'Usage ledger schema is newer than this app.'); }
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS budgets(scope TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount>=0));
      CREATE TABLE IF NOT EXISTS budget_changes(id INTEGER PRIMARY KEY, at TEXT NOT NULL, scope TEXT NOT NULL, amount INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(
        id TEXT PRIMARY KEY, at TEXT NOT NULL, month TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL,
        status TEXT NOT NULL, settlement TEXT NOT NULL, cost_status TEXT NOT NULL,
        reserved INTEGER NOT NULL, bound INTEGER, estimated INTEGER, confirmed INTEGER,
        input INTEGER, output INTEGER, cached INTEGER, writes INTEGER, reasoning INTEGER,
        price_version TEXT NOT NULL, price_json TEXT NOT NULL, exception INTEGER NOT NULL, block_reason TEXT,
        headers TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, evidence TEXT);
      CREATE INDEX IF NOT EXISTS requests_month ON requests(month,provider);
      CREATE TABLE IF NOT EXISTS balances(provider TEXT PRIMARY KEY, usd TEXT, at TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_reports(provider TEXT NOT NULL, month TEXT NOT NULL, report TEXT NOT NULL, PRIMARY KEY(provider,month));
      CREATE TABLE IF NOT EXISTS route_events(id INTEGER PRIMARY KEY, route_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_health(provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, until_at TEXT, PRIMARY KEY(provider,model));
      CREATE TABLE IF NOT EXISTS model_tiers(provider TEXT NOT NULL, model TEXT NOT NULL, tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND 3), source TEXT, checked_at TEXT, user_modified INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(provider,model));
      CREATE TABLE IF NOT EXISTS routing_settings(id INTEGER PRIMARY KEY CHECK(id=1), allow_paid INTEGER NOT NULL, policies TEXT NOT NULL, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO routing_settings VALUES(1,0,'{"simple":[1,2],"normal":[2,1],"complex":[3,2]}',0);
      CREATE TABLE IF NOT EXISTS model_free_use(provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('verified','unverified','unavailable','unsupported')), checked_at TEXT, source TEXT NOT NULL, conditions TEXT NOT NULL, approved INTEGER NOT NULL, credential_hash TEXT, PRIMARY KEY(provider,model));
      CREATE TABLE IF NOT EXISTS gemini_project(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL, project TEXT NOT NULL, checked_at TEXT NOT NULL, credential_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_billing(id TEXT PRIMARY KEY, mode TEXT NOT NULL, basis TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_plans(provider TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('free','paid','unknown')), checked_at TEXT NOT NULL, credential_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_permissions(provider TEXT PRIMARY KEY, state TEXT NOT NULL, fingerprint TEXT NOT NULL, account_id TEXT NOT NULL, checked_at TEXT NOT NULL, source TEXT NOT NULL, paid_allowed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_consents(token TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS permission_events(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS soft_budgets(provider TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount>=0), updated_at TEXT NOT NULL);
      PRAGMA user_version=8;`));
  }
  close() { this.db.close(); }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    const statement = this.db.prepare(sql); statement.setReadBigInts(true);
    return statement.all(...params) as Row[];
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Legacy persistence API: retained for historical data compatibility, never consulted for dispatch.
  setBudget(scope: unknown, usd: unknown) {
    if (typeof scope !== 'string' || !['total', 'request', ...providerIds].includes(scope)) throw new NidusError('invalid_request', 'Invalid budget scope.');
    const amount = money(usd);
    this.transaction(() => {
      this.db.prepare('INSERT INTO budgets VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET amount=excluded.amount').run(scope, amount);
      this.db.prepare('INSERT INTO budget_changes(at,scope,amount) VALUES(?,?,?)').run(this.now().toISOString(), scope, amount);
    });
    return this.snapshot();
  }
  setSoftBudget(provider: ProviderId, usd: unknown) {
    if (!providerIds.includes(provider)) throw new NidusError('invalid_request', 'Invalid Provider.');
    if (usd === null) this.db.prepare('DELETE FROM soft_budgets WHERE provider=?').run(provider);
    else this.db.prepare('INSERT INTO soft_budgets VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at')
      .run(provider, money(usd), this.now().toISOString());
  }
  // Read only, bounded query count; no credential observation, reservation or policy mutation.
  decisionData() {
    const at = this.now().toISOString(), month = at.slice(0, 7);
    const since = new Date(this.now().getTime() - 30 * 86400_000).toISOString();
    const aggregate = (group: string) => this.rows(`SELECT ${group}, COUNT(*) AS requests,
      SUM(input) AS input, SUM(output) AS output,
      SUM(CASE WHEN input IS NULL OR output IS NULL THEN 1 ELSE 0 END) AS unknown_tokens,
      SUM(estimated) AS estimated, SUM(confirmed) AS confirmed,
      COUNT(estimated) AS estimated_count, COUNT(confirmed) AS confirmed_count,
      SUM(CASE WHEN b.mode='free' THEN 1 ELSE 0 END) AS free_count,
      SUM(COALESCE(confirmed,estimated)) AS spend,
      SUM(CASE WHEN estimated IS NULL AND confirmed IS NULL THEN 1 ELSE 0 END) AS unknown,
      MAX(at) AS last_at, MAX(updated_at) AS updated_at,
      GROUP_CONCAT(DISTINCT price_version) AS versions
      FROM requests LEFT JOIN request_billing b ON b.id=requests.id WHERE month=? AND status!='blocked' GROUP BY ${group}`, month);
    this.db.exec('BEGIN');
    try {
      const result = { at, month, since, models: aggregate('provider,model'), providers: aggregate('provider'),
        recent: this.rows(`SELECT provider,model,COUNT(*) AS requests,
          SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS successes,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures,
          SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
          MAX(at) AS last_at FROM requests WHERE at>=? AND status IN ('succeeded','failed','cancelled') GROUP BY provider,model`, since),
        routeFailures: this.rows(`SELECT json_extract(event,'$.provider') AS provider, json_extract(event,'$.model') AS model,
          COUNT(*) AS failures, SUM(CASE WHEN json_extract(event,'$.reason')='rate_limit' THEN 1 ELSE 0 END) AS rate_limits,
          MAX(at) AS at FROM route_events WHERE at>=? AND json_extract(event,'$.status')='failed' GROUP BY provider,model`, since),
        lastCalls: this.rows("SELECT provider,model,MAX(at) AS at FROM requests WHERE status!='blocked' GROUP BY provider,model"),
        health: this.rows('SELECT provider,model,status,at,until_at FROM model_health'),
        tiers: this.rows('SELECT provider,model,tier,source,checked_at,user_modified,updated_at FROM model_tiers'),
        budgets: this.rows('SELECT provider,amount,updated_at FROM soft_budgets'),
        settings: this.routingSettings(),
        ledgerUpdatedAt: this.rows('SELECT MAX(updated_at) AS at FROM requests')[0]?.at ?? null };
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private budget(scope: string): bigint | null { return this.rows('SELECT amount FROM budgets WHERE scope=?', scope)[0]?.amount as bigint ?? null; }
  private exposure(month: string, provider?: ProviderId): bigint {
    // Pending liabilities from previous months carry forward until resolved; never expire to zero.
    return this.rows(`SELECT COALESCE(SUM(CASE WHEN month=? THEN COALESCE(confirmed,estimated,0) ELSE 0 END + reserved),0) AS n
      FROM requests WHERE (month=? OR reserved>0) ${provider ? 'AND provider=?' : ''}`, month, month, ...(provider ? [provider] : []))[0]!.n as bigint;
  }
  accountPermission(provider: ProviderId, fingerprint?: string) {
    const row = this.rows('SELECT * FROM account_permissions WHERE provider=?', provider)[0];
    const matches = !!row && (fingerprint === undefined || row.fingerprint === fingerprint);
    return { provider, state: matches ? String(row.state) : 'unknown', paidAllowed: matches && row.paid_allowed === 1n,
      accountId: matches ? String(row.account_id) : '', checkedAt: matches && row.state!=='unknown' ? String(row.checked_at) : null,
      verification: matches && row.state !== 'unknown' ? 'user-declared' : 'unverified', source: providerMetadata[provider].source,
      revision: Number(row?.revision ?? 0n), needsConfirmation: !matches || row.state === 'unknown',
      legacyHint: !matches || row.state==='unknown' ? (provider==='gemini' ? this.geminiBilling().state : this.providerPlan(provider).state) : null,
      officialVerification: 'not-connected', verificationNote: 'Current inference credentials do not provide a connected authoritative billing-type lookup. Catalog access, balances and rate limits do not verify billing type.',
      officialTerms: providerMetadata[provider].freeConditions };
  }
  setAccountPermission(provider: ProviderId, state: unknown, paidAllowed: unknown, confirmed: unknown, riskAccepted: unknown, fingerprint: string, accountId: unknown = '', expectedRevision?: unknown) {
    validateAccountPermission(state,paidAllowed,confirmed,riskAccepted,fingerprint,accountId);
    this.transaction(() => {
      const current=this.accountPermission(provider);
      if(expectedRevision!==undefined && expectedRevision!==current.revision)throw new NidusError('execution_permission','Account changed while settings were open. Reload and confirm the current account.');
      const revision = current.revision + 1;
      this.db.prepare(`INSERT INTO account_permissions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET state=excluded.state,fingerprint=excluded.fingerprint,account_id=excluded.account_id,checked_at=excluded.checked_at,source=excluded.source,paid_allowed=excluded.paid_allowed,revision=excluded.revision`)
        .run(provider,state as string,fingerprint,accountId as string,this.now().toISOString(),providerMetadata[provider].source,paidAllowed?1:0,revision);
      this.db.prepare('DELETE FROM execution_consents WHERE provider=?').run(provider);
      this.db.prepare('INSERT INTO permission_events(provider,at,event) VALUES(?,?,?)').run(provider,this.now().toISOString(),JSON.stringify({state,paidAllowed,revision,verification:'user-declared'}));
    });
  }
  observeCredential(provider: ProviderId, fingerprint: string) {
    this.transaction(() => {
      const row=this.rows('SELECT fingerprint,revision FROM account_permissions WHERE provider=?',provider)[0];
      if ((!row && !fingerprint) || row?.fingerprint===fingerprint) return;
      const revision=Number(row?.revision ?? 0n)+1;
      this.db.prepare(`INSERT INTO account_permissions VALUES(?,'unknown',?,'',?,?,0,?) ON CONFLICT(provider) DO UPDATE SET state='unknown',paid_allowed=0,fingerprint=excluded.fingerprint,revision=excluded.revision`)
        .run(provider,fingerprint,this.now().toISOString(),providerMetadata[provider].source,revision);
      this.db.prepare('DELETE FROM execution_consents WHERE provider=?').run(provider);
      this.db.prepare('INSERT INTO permission_events(provider,at,event) VALUES(?,?,?)').run(provider,this.now().toISOString(),JSON.stringify({state:'unknown',paidAllowed:false,revision,reason:'credential_changed'}));
    });
  }
  invalidateAccount(provider: ProviderId) {
    this.transaction(() => {
      this.db.prepare("UPDATE account_permissions SET state='unknown',paid_allowed=0,fingerprint='',revision=revision+1 WHERE provider=?").run(provider);
      this.db.prepare('DELETE FROM execution_consents WHERE provider=?').run(provider);
    });
  }
  issueConsent(provider: ProviderId, model: string, task: TaskKind, fingerprint: string, riskAccepted: unknown) {
    return this.transaction(() => {
      const account=this.accountPermission(provider,fingerprint);
      if (riskAccepted !== true || account.state !== 'unknown' || !model || !['chat','probe'].includes(task)) throw new NidusError('invalid_request','Request-specific consent is only for Unknown accounts and requires explicit charge-risk acceptance.');
      const token=randomUUID(), expiresAt=new Date(this.now().getTime()+300_000).toISOString();
      this.db.prepare('INSERT INTO execution_consents VALUES(?,?,?,?,?,?,?,0)').run(token,provider,model,task,fingerprint,account.revision,expiresAt);
      return {token,expiresAt,provider,model,task};
    });
  }
  executionPermission(provider: ProviderId, model: string, fingerprint?: string) {
    const account=this.accountPermission(provider,fingerprint), price=priceFor(provider,model);
    const free=account.state==='free_only';
    const freeRow=this.rows('SELECT status,credential_hash FROM model_free_use WHERE provider=? AND model=?',provider,model)[0];
    const currentHash=fingerprint ?? this.rows('SELECT fingerprint FROM account_permissions WHERE provider=?',provider)[0]?.fingerprint;
    const exhausted=freeRow?.status==='unavailable' && freeRow.credential_hash===currentHash;
    const reason=account.state==='unknown' ? 'account_unknown' : free
      ? price.freeTier!=='available' ? 'free_model_unverified' : exhausted ? 'free_unavailable' : null
      : !account.paidAllowed ? 'provider_paid_not_approved' : null;
    return {allowed:reason===null,reason,billingMode:free?'free' as const:'paid' as const,account};
  }
  // Cost is advisory: execution permissions never compare monetary limits.
  quote(provider: ProviderId, request: ChatRequest, fingerprint?: string) {
    const permission=this.executionPermission(provider,request.model,fingerprint);
    const bound=permission.billingMode==='free' && permission.allowed ? 0n : upperCost(provider,request);
    return {...permission,boundUSD:bound===null?null:dollars(bound)};
  }
  geminiBilling() {
    const row = this.rows('SELECT * FROM gemini_project WHERE id=1')[0];
    return { state: String(row?.state ?? 'unknown'), project: String(row?.project ?? ''), checkedAt: row?.checked_at ?? null,
      source: 'user-project-attestation', remainingFreeQuota: null,
      note: 'Not Google Billing verification. Incorrect settings can cause charges. No local spending limit is enforced. Reconfirm after billing changes; reconnecting clears this setting.' };
  }
  setGeminiBilling(state: unknown, project: unknown, confirmed: unknown, riskAccepted: unknown, credentialHash: string) {
    if (!['free','paid','unknown'].includes(String(state)) || typeof state !== 'string' || typeof project !== 'string' || !/^[a-zA-Z0-9:_-]{0,128}$/.test(project))
      throw new NidusError('invalid_request', 'Invalid Gemini project billing setting.');
    if (state === 'free' && (!project || confirmed !== true || riskAccepted !== true || !credentialHash))
      throw new NidusError('invalid_request', 'Confirm this key belongs to a Free Tier project and acknowledge that this is not Google Billing verification.');
    this.transaction(() => {
      this.db.prepare('INSERT INTO gemini_project VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,project=excluded.project,checked_at=excluded.checked_at,credential_hash=excluded.credential_hash')
        .run(state, project, this.now().toISOString(), credentialHash);
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  providerPlan(provider: ProviderId) {
    const row=this.rows('SELECT * FROM provider_plans WHERE provider=?',provider)[0];
    return { provider, state:String(row?.state ?? 'unknown'), checkedAt:row?.checked_at ?? null, source:providerMetadata[provider].source,
      conditions:providerMetadata[provider].freeConditions, verification:'user-account-attestation', remainingFreeQuota:null };
  }
  setProviderPlan(provider: ProviderId, state: unknown, confirmed: unknown, riskAccepted: unknown, credentialHash: string) {
    if (!(expandedProviders as readonly string[]).includes(provider) || typeof state!=='string' || !['free','paid','unknown'].includes(state)) throw new NidusError('invalid_request','Invalid provider plan.');
    if (state==='free' && (confirmed!==true || riskAccepted!==true || !credentialHash)) throw new NidusError('invalid_request','Confirm Free plan, no paid overage, and acknowledge billing risk.');
    this.transaction(()=>{
      this.db.prepare('INSERT INTO provider_plans VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at,credential_hash=excluded.credential_hash').run(provider,state,this.now().toISOString(),credentialHash);
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  approveNvidiaFreeModels(models: string[], confirmed: unknown, riskAccepted: unknown, credentialHash: string) {
    if (!models.length || new Set(models).size !== models.length || models.some(m=>!reviewedFreeModels.nvidia?.includes(m)) || confirmed!==true || riskAccepted!==true || !credentialHash)
      throw new NidusError('invalid_request','Select reviewed NVIDIA Free Endpoints and confirm this account’s free developer access and billing risk.');
    this.transaction(()=>{
      const at=this.now().toISOString();
      this.db.prepare("INSERT INTO provider_plans VALUES('nvidia','free',?,?) ON CONFLICT(provider) DO UPDATE SET state='free',checked_at=excluded.checked_at,credential_hash=excluded.credential_hash").run(at,credentialHash);
      for (const model of models) this.db.prepare(`INSERT INTO model_free_use VALUES('nvidia',?,'verified',?,?,?,1,?) ON CONFLICT(provider,model) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,source=excluded.source,conditions=excluded.conditions,approved=1,credential_hash=excluded.credential_hash`)
        .run(model,at,priceFor('nvidia',model).sourceUrl,'User confirmed this hosted Free Endpoint and current developer account eligibility. Remaining quota is unknown. Incorrect settings can cause charges.',credentialHash);
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  recordRoute(routeId: string, event: { provider: ProviderId; model: string; reason: string; status: string; budget: string; boundUSD: string | null; requestId?: string; tier?: Tier }) {
    this.db.prepare('INSERT INTO route_events(route_id,at,event) VALUES(?,?,?)').run(routeId, this.now().toISOString(), JSON.stringify(event));
  }
  routes() {
    return this.rows('SELECT route_id,at,event FROM route_events ORDER BY id DESC LIMIT 200').map(r => ({ routeId: r.route_id, at: r.at, ...JSON.parse(r.event as string) }));
  }
  recordHealth(provider: ProviderId, model: string, status: string, cooldownSeconds = 0) {
    const at = this.now();
    this.db.prepare('INSERT INTO model_health VALUES(?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET status=excluded.status,at=excluded.at,until_at=excluded.until_at')
      .run(provider, model, status, at.toISOString(), cooldownSeconds ? new Date(at.getTime() + cooldownSeconds * 1000).toISOString() : null);
  }
  health(provider: ProviderId, model: string) {
    const row = this.rows('SELECT * FROM model_health WHERE provider=? AND model=?', provider, model)[0];
    return { status: row?.status ?? 'unknown', checkedAt: row?.at ?? null, excludedUntil: row?.until_at ?? null,
      available: !row?.until_at || String(row.until_at) <= this.now().toISOString() };
  }
  routingSettings() {
    const row = this.rows('SELECT * FROM routing_settings WHERE id=1')[0]!;
    return { allowPaid: row.allow_paid === 1n, policies: JSON.parse(row.policies as string) as Record<Difficulty, Tier[]>, revision: Number(row.revision) };
  }
  setRoutingPolicy(task: unknown, tiers: unknown) {
    if (typeof task !== 'string') throw new NidusError('invalid_request', 'Select a task difficulty.');
    const level = difficulty(task);
    if (!Array.isArray(tiers) || tiers.length > 3 || tiers.some(t => ![1,2,3].includes(t)) || new Set(tiers).size !== tiers.length)
      throw new NidusError('invalid_request', 'Tier order must contain distinct tiers 1, 2 or 3; empty disables this difficulty.');
    this.transaction(() => {
      const settings = this.routingSettings(); settings.policies[level] = tiers as Tier[];
      this.db.prepare('UPDATE routing_settings SET policies=?, revision=revision+1 WHERE id=1').run(JSON.stringify(settings.policies));
    });
  }
  // Legacy preference only. It no longer grants or denies execution.
  setAutomaticPaid(value: unknown) {
    if (typeof value !== 'boolean') throw new NidusError('invalid_request', 'Automatic paid permission must be boolean.');
    this.db.prepare('UPDATE routing_settings SET allow_paid=?, revision=revision+1 WHERE id=1').run(value ? 1 : 0);
  }
  modelTier(provider: ProviderId, model: string) {
    const profile = modelProfile(provider, model);
    this.db.prepare('INSERT OR IGNORE INTO model_tiers VALUES(?,?,?,?,?,0,?)').run(provider, model, gradeTier(profile.grade), profile.source, profile.checkedAt, this.now().toISOString());
    const row = this.rows('SELECT * FROM model_tiers WHERE provider=? AND model=?', provider, model)[0]!;
    return { tier: Number(row.tier) as Tier, source: row.source as string | null, checkedAt: row.checked_at as string | null,
      userModified: row.user_modified === 1n, updatedAt: row.updated_at as string };
  }
  setModelTier(provider: ProviderId, model: string, tier: unknown) {
    if (tier !== null && ![0,1,2,3].includes(tier as number)) throw new NidusError('invalid_request', 'Tier must be 0, 1, 2, 3 or null to restore default.');
    this.transaction(() => {
      const profile = modelProfile(provider, model), custom = tier !== null;
      this.db.prepare(`INSERT INTO model_tiers VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET
        tier=excluded.tier,source=excluded.source,checked_at=excluded.checked_at,user_modified=excluded.user_modified,updated_at=excluded.updated_at`)
        .run(provider, model, custom ? tier as number : gradeTier(profile.grade), custom ? 'user' : profile.source, custom ? null : profile.checkedAt, custom ? 1 : 0, this.now().toISOString());
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  freeUse(provider: ProviderId, model: string) {
    const price = priceFor(provider, model);
    const row = this.rows('SELECT * FROM model_free_use WHERE provider=? AND model=?', provider, model)[0];
    const status = price.freeTier === 'unavailable' ? 'unsupported' : String(row?.status ?? 'unverified');
    return { status, approved: row?.approved === 1n && price.freeTier === 'available', checkedAt: row?.checked_at ?? null,
      source: String(row?.source ?? price.sourceUrl), conditions: String(row?.conditions ?? 'Account eligibility and remaining quota are not verified. Cost is estimated using paid rates unless free eligibility is recorded; no spending limit is enforced.'),
      verification: status === 'verified' && row?.checked_at ? 'user-account-attestation' : status === 'unavailable' ? 'user-reported-unavailable' : 'not-verified', freeTier: price.freeTier,
      approvedForAutomatic: row?.approved === 1n && price.freeTier === 'available' && ['verified', 'unverified'].includes(status) };
  }
  // This is scoped consent to possible charges, never a zero-price entitlement.
  setFreeUse(provider: ProviderId, model: string, status: unknown, approved: unknown, accountConfirmed: unknown, credentialHash: string) {
    if (priceFor(provider, model).freeTier !== 'available') throw new NidusError('invalid_request', 'Only reviewed free-tier models can receive scoped free-use approval.');
    if (!['verified','unverified','unavailable'].includes(String(status)) || typeof status !== 'string' || typeof approved !== 'boolean' || typeof accountConfirmed !== 'boolean')
      throw new NidusError('invalid_request', 'Invalid free-use status or approval.');
    if (status !== 'unverified' && accountConfirmed !== true) throw new NidusError('invalid_request', 'Confirm the current account conditions before recording availability.');
    if (status === 'unavailable' && approved) throw new NidusError('invalid_request', 'Unavailable free use cannot be approved.');
    const conditions = status === 'verified' ? 'User checked official free-tier terms and current account/project eligibility. Remaining quota is not synchronized; billing may still occur.'
      : status === 'unavailable' ? 'User confirmed free quota exhausted or account ineligible. Recheck account before approving again.'
      : 'Current account eligibility and remaining quota are unknown. Free-use metadata does not prevent paid charges. No spending limit is enforced.';
    this.transaction(() => {
      this.db.prepare(`INSERT INTO model_free_use VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,source=excluded.source,conditions=excluded.conditions,approved=excluded.approved,credential_hash=excluded.credential_hash`)
        .run(provider, model, status, this.now().toISOString(), priceFor(provider, model).sourceUrl, conditions, approved ? 1 : 0, credentialHash);
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  invalidateFreeUse(provider: ProviderId) {
    this.transaction(() => {
      this.db.prepare("UPDATE provider_plans SET state='unknown',credential_hash='' WHERE provider=?").run(provider);
      if (provider === 'gemini') this.db.prepare("UPDATE gemini_project SET state='unknown',credential_hash='' WHERE id=1").run();
      this.db.prepare("UPDATE model_free_use SET status='unverified',checked_at=NULL,approved=0,credential_hash=NULL WHERE provider=?").run(provider);
      this.db.prepare('UPDATE routing_settings SET revision=revision+1 WHERE id=1').run();
    });
  }
  recordRequest(provider: ProviderId, request: ChatRequest, task: TaskKind, automatic?: { revision: number; difficulty: Difficulty; tier: Tier; accountRevision?: number; billingMode?: string }, credentialHash?: string, consentToken?: string): TrackedRequest {
    const price = priceFor(provider, request.model), id = randomUUID(), at = this.now().toISOString();
    const recorded = this.transaction(() => {
      // Permission and Tier validation share the request-record transaction.
      if (automatic) {
        const settings = this.routingSettings();
        const assigned = this.rows('SELECT tier FROM model_tiers WHERE provider=? AND model=?', provider, request.model)[0];
        if (settings.revision !== automatic.revision || !settings.policies[automatic.difficulty].includes(automatic.tier) || !assigned || assigned.tier !== BigInt(automatic.tier) || automatic.tier === 0)
          throw new NidusError('invalid_request', 'Routing settings changed. Select the task again before sending.');
      }
      const permission=this.executionPermission(provider,request.model,credentialHash ?? '');
      let reason=automatic && (automatic.accountRevision!==permission.account.revision || automatic.billingMode!==permission.billingMode) ? 'account_changed' : permission.reason;
      let consentUsed=false;
      if (reason==='account_unknown' && !automatic && consentToken) {
        const used=this.db.prepare(`UPDATE execution_consents SET consumed=1 WHERE token=? AND provider=? AND model=? AND task=? AND fingerprint=? AND revision=? AND expires_at>? AND consumed=0`)
          .run(consentToken,provider,request.model,task,credentialHash ?? '',permission.account.revision,at);
        if(used.changes===1){reason=null;consentUsed=true;}
      }
      const billingMode=permission.billingMode;
      if(reason){
        this.db.prepare(`INSERT INTO requests(id,at,month,provider,model,task,status,settlement,cost_status,reserved,bound,price_version,price_json,exception,block_reason,updated_at) VALUES(?,?,?,?,?,?,'blocked','not_sent','unknown',0,NULL,?,?,0,?,?)`)
          .run(id,at,at.slice(0,7),provider,request.model,task,priceVersion(price),JSON.stringify(price),reason,at);
        this.db.prepare('INSERT INTO request_billing VALUES(?,?,?)').run(id,billingMode,JSON.stringify({account:permission.account,authorization:'blocked',reason}));
        return {reason};
      }
      this.db.prepare(`INSERT INTO requests(id,at,month,provider,model,task,status,settlement,cost_status,reserved,bound,price_version,price_json,exception,updated_at)
        VALUES(?,?,?,?,?,?,'pending','tracking','unknown',0,NULL,?,?,0,?)`).run(id, at, at.slice(0,7), provider, request.model, task, priceVersion(price), JSON.stringify(price), at);
      this.db.prepare('INSERT INTO request_billing VALUES(?,?,?)').run(id, billingMode, JSON.stringify({account:permission.account,authorization:consentUsed?'request-consent':billingMode==='free'?'free-only-account':'provider-paid-permission'}));
      return { id, price, bound: null, billingMode };
    });
    if('reason' in recorded){const error=new NidusError('execution_permission',`Execution permission denied (${recorded.reason}). No API request sent.`);error.reason=recorded.reason!;throw error;}
    return recorded;
  }
  settle(request: TrackedRequest, status: 'succeeded' | 'failed' | 'cancelled', usage?: Usage | null, headers: Record<string, string> = {}) {
    const token = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    this.transaction(() => {
      const saved = this.rows("SELECT price_json,bound FROM requests WHERE id=? AND status='pending'", request.id)[0];
      if (!saved) throw new NidusError('storage', 'Request settlement was already recorded or is missing.');
      const free = this.rows('SELECT mode FROM request_billing WHERE id=?', request.id)[0]?.mode === 'free';
      const cost = free && token(usage?.inputTokens) !== null && token(usage?.outputTokens) !== null ? 0n : free ? null : calculatedCost(JSON.parse(saved.price_json as string) as Price, usage);
      const result = this.db.prepare(`UPDATE requests SET status=?,settlement=?,cost_status=?,reserved=?,estimated=?,input=?,output=?,cached=?,writes=?,reasoning=?,headers=?,updated_at=?
        WHERE id=? AND status='pending'`).run(status, cost === null ? 'unresolved' : 'estimated', cost === null ? 'unknown' : 'estimated', cost === null ? (saved.bound as bigint | null) ?? 0n : 0n, cost,
        token(usage?.inputTokens), token(usage?.outputTokens), token(usage?.cachedInputTokens), token(usage?.cacheWriteTokens), token(usage?.reasoningTokens), JSON.stringify(rateLimitHeaders(new Headers(headers))), this.now().toISOString(), request.id);
      if (result.changes !== 1) throw new NidusError('storage', 'Request settlement was already recorded or is missing.');
    });
  }
  // Future billing connectors must match a request and supply immutable provider evidence.
  // Aggregate account costs must never be apportioned to requests or added to local totals.
  reconcile(id: string, usd: string, evidence: { provider: ProviderId; reference: string }) {
    const amount = money(usd);
    if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(evidence.reference)) throw new NidusError('invalid_request', 'Invalid billing evidence reference.');
    this.transaction(() => {
      const row = this.rows('SELECT * FROM requests WHERE id=? AND provider=?', id, evidence.provider)[0];
      if (!row || row.status === 'blocked' || row.status === 'pending') throw new NidusError('invalid_request', 'Only completed requests may be reconciled.');
      if (row.confirmed !== null) {
        if (row.confirmed === amount && row.evidence === evidence.reference) return;
        throw new NidusError('invalid_request', 'Conflicting billing evidence.');
      }
      this.db.prepare("UPDATE requests SET confirmed=?,reserved=0,cost_status='confirmed',settlement='reconciled',evidence=?,updated_at=? WHERE id=?").run(amount, evidence.reference, this.now().toISOString(), id);
    });
  }
  saveBalance(provider: ProviderId, usd: string | null, source: string) {
    const value = usd === null ? null : dollars(money(usd));
    this.db.prepare('INSERT INTO balances VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET usd=excluded.usd,at=excluded.at,source=excluded.source').run(provider, value, this.now().toISOString(), source);
    return this.snapshot();
  }
  saveAccountReport(report: AccountReport) {
    this.db.prepare('INSERT INTO account_reports VALUES(?,?,?) ON CONFLICT(provider,month) DO UPDATE SET report=excluded.report').run(report.provider, report.month, JSON.stringify(report));
  }
  snapshot() {
    // Consistent multi-query read even while other app/CLI processes settle requests.
    this.db.exec('BEGIN');
    try { const result = this.readSnapshot(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private readSnapshot() {
    const month = this.now().toISOString().slice(0, 7);
    const overview = (provider?: ProviderId) => {
      const rows = this.rows(`SELECT * FROM requests WHERE (month=? OR reserved>0) ${provider ? 'AND provider=?' : ''}`, month, ...(provider ? [provider] : []));
      const sum = (key: string, filter = (r: Row) => r.month === month) => rows.filter(filter).reduce((n, r) => n + (r[key] as bigint ?? 0n), 0n);
      const reserved = sum('reserved', () => true), estimated = sum('estimated', r => r.month === month && r.confirmed === null), confirmed = sum('confirmed');
      const limit = this.budget(provider ?? 'total'), used = this.exposure(month, provider);
      const level = limit === null ? (provider && this.budget('total') !== null ? 'inherited' : 'unconfigured') : used >= limit ? 'blocked' : used * 100n >= limit * 90n ? 'saving' : used * 100n >= limit * 80n ? 'warning' : 'normal';
      const totalLimit = this.budget('total');
      const localRemaining = limit === null ? null : (limit > used ? limit - used : 0n);
      const globalRemaining = totalLimit === null ? null : (totalLimit > this.exposure(month) ? totalLimit - this.exposure(month) : 0n);
      const remaining = !provider ? localRemaining : globalRemaining === null ? null : localRemaining === null || globalRemaining < localRemaining ? globalRemaining : localRemaining;
      return { scope: provider ?? 'total', budgetUSD: limit === null ? null : dollars(limit), estimatedUSD: dollars(estimated), confirmedUSD: rows.some(r => r.month === month && r.confirmed !== null) ? dollars(confirmed) : null,
        reservedUSD: dollars(reserved), exposureUSD: dollars(used), remainingUSD: remaining === null ? null : dollars(remaining), level,
        utilizationPercent: limit && limit > 0n ? Number(used * 10000n / limit) / 100 : null,
        unknownCount: rows.filter(r => r.settlement === 'unresolved' || r.status === 'pending').length,
        unknownPriceCount: rows.filter(r => r.block_reason === 'unknown_price_or_bound').length };
    };
    const requests = this.rows(`SELECT requests.*, COALESCE(request_billing.mode,'paid') AS billing_mode,request_billing.basis AS billing_basis FROM requests LEFT JOIN request_billing USING(id) ORDER BY at DESC, requests.rowid DESC LIMIT 200`).map(r => ({
      billingMode: r.billing_mode, billingBasis: r.billing_basis, id: r.id, at: r.at, provider: r.provider, model: r.model, task: r.task, status: r.status, settlement: r.settlement, costStatus: r.cost_status,
      reservedUSD: dollars(r.reserved as bigint), boundUSD: r.bound === null ? null : dollars(r.bound as bigint), estimatedUSD: r.estimated === null ? null : dollars(r.estimated as bigint), confirmedUSD: r.confirmed === null ? null : dollars(r.confirmed as bigint),
      inputTokens: r.input === null ? null : Number(r.input), outputTokens: r.output === null ? null : Number(r.output), cachedTokens: r.cached === null ? null : Number(r.cached), cacheWriteTokens: r.writes === null ? null : Number(r.writes), reasoningTokens: r.reasoning === null ? null : Number(r.reasoning),
      priceVersion: r.price_version, pricing: JSON.parse(r.price_json as string), exception: r.exception === 1n, blockReason: r.block_reason, headers: JSON.parse(r.headers as string), updatedAt: r.updated_at
    }));
    const models = this.rows(`SELECT provider,model,COUNT(*) AS count,SUM(input) AS input,SUM(output) AS output,SUM(estimated) AS estimated,SUM(confirmed) AS confirmed,SUM(reserved) AS reserved FROM requests WHERE month=? AND status!='blocked' GROUP BY provider,model`, month).map(r => ({
      provider: r.provider, model: r.model, requests: Number(r.count), inputTokens: r.input === null ? null : Number(r.input), outputTokens: r.output === null ? null : Number(r.output), estimatedUSD: r.estimated === null ? null : dollars(r.estimated as bigint), confirmedUSD: r.confirmed === null ? null : dollars(r.confirmed as bigint), reservedUSD: dollars(r.reserved as bigint)
    }));
    return { budgetGuardEnabled: false, currency: 'USD', month, source: 'nidus-local-ledger', updatedAt: this.rows('SELECT MAX(updated_at) AS at FROM requests')[0]?.at ?? null,
      accountReports: this.rows('SELECT report FROM account_reports WHERE month=?', month).map(r => JSON.parse(r.report as string) as AccountReport),
      lastProviderSyncAt: this.rows("SELECT MAX(at) AS at FROM (SELECT at FROM balances UNION ALL SELECT json_extract(report,'$.syncedAt') AS at FROM account_reports)")[0]?.at ?? null,
      total: overview(), providers: providerIds.map(p => overview(p)), requestBudgetUSD: this.budget('request') === null ? null : dollars(this.budget('request')!),
      requests, models, balances: this.rows('SELECT * FROM balances'),
      note: 'Local Nidus requests only. Budget Guard is removed; new requests do not reserve funds. Existing budgets and reservations are historical metadata only. Provider invoices and external usage can differ. Unknown costs remain unknown.' };
  }
}
