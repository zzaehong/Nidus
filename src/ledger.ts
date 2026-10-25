import { expandedProviders, providerMetadata } from './providers.js';
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
export interface Reservation { id: string; price: Price; bound: bigint; billingMode: 'free' | 'paid' }
type Row = Record<string, string | bigint | null>;
export const ledgerPath = () => join(homedir(), '.local', 'share', 'nidus', 'usage.sqlite');
export class UsageLedger {
  private db: DatabaseSync;
  constructor(path = ledgerPath(), private readonly now: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schema.user_version > 6) { this.db.close(); throw new NidusError('storage', 'Usage ledger schema is newer than this app.'); }
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
      PRAGMA user_version=6;`));
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
  setBudget(scope: unknown, usd: unknown) {
    if (typeof scope !== 'string' || !['total', 'request', ...providerIds].includes(scope)) throw new NidusError('invalid_request', 'Invalid budget scope.');
    const amount = money(usd);
    this.transaction(() => {
      this.db.prepare('INSERT INTO budgets VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET amount=excluded.amount').run(scope, amount);
      this.db.prepare('INSERT INTO budget_changes(at,scope,amount) VALUES(?,?,?)').run(this.now().toISOString(), scope, amount);
    });
    return this.snapshot();
  }
  private budget(scope: string): bigint | null { return this.rows('SELECT amount FROM budgets WHERE scope=?', scope)[0]?.amount as bigint ?? null; }
  private exposure(month: string, provider?: ProviderId): bigint {
    // Pending liabilities from previous months carry forward until resolved; never expire to zero.
    return this.rows(`SELECT COALESCE(SUM(CASE WHEN month=? THEN COALESCE(confirmed,estimated,0) ELSE 0 END + reserved),0) AS n
      FROM requests WHERE (month=? OR reserved>0) ${provider ? 'AND provider=?' : ''}`, month, month, ...(provider ? [provider] : []))[0]!.n as bigint;
  }
  private checkBudget(provider: ProviderId, bound: bigint | null, month: string, exception = false): string | null {
    if (bound === null) return 'unknown_price_or_bound';
    if (bound === 0n || exception) return null;
    const total = this.budget('total'), single = this.budget('request'), specific = this.budget(provider);
    if (total === null || single === null) return 'budget_not_configured';
    if (bound > single) return 'request_budget';
    if (this.exposure(month) >= total || this.exposure(month) + bound > total) return 'monthly_budget';
    if (specific !== null && (this.exposure(month, provider) >= specific || this.exposure(month, provider) + bound > specific)) return 'provider_budget';
    return null;
  }
  // Advisory only. reserve() rechecks this same policy under BEGIN IMMEDIATE.
  quote(provider: ProviderId, request: ChatRequest) {
    return this.transaction(() => {
      const billing = this.billing(provider, request), bound = billing.bound, reason = billing.reason ?? this.checkBudget(provider, bound, this.now().toISOString().slice(0, 7));
      return { billingMode: billing.mode, allowed: reason === null, reason, boundUSD: bound === null ? null : dollars(bound) };
    });
  }
  geminiBilling() {
    const row = this.rows('SELECT * FROM gemini_project WHERE id=1')[0];
    return { state: String(row?.state ?? 'unknown'), project: String(row?.project ?? ''), checkedAt: row?.checked_at ?? null,
      source: 'user-project-attestation', remainingFreeQuota: null,
      note: 'Not Google Billing verification. Incorrect settings can cause charges outside local budgets. Reconfirm after billing changes; reconnecting clears this setting.' };
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
  private billing(provider: ProviderId, request: ChatRequest, credentialHash?: string, execution = false) {
    const plan=this.rows('SELECT * FROM provider_plans WHERE provider=?',provider)[0];
    if ((expandedProviders as readonly string[]).includes(provider) && plan?.state==='free') {
      const price=priceFor(provider,request.model), approval=this.rows('SELECT * FROM model_free_use WHERE provider=? AND model=?',provider,request.model)[0];
      let reason: string|null=null;
      if (execution && (!credentialHash || plan.credential_hash!==credentialHash || approval?.credential_hash!==credentialHash)) reason='free_credential_changed';
      else if (price.freeTier!=='available' || !price.checkedAt || this.now().getTime()-Date.parse(price.checkedAt)>30*86400000) reason='free_model_unverified';
      else if (approval?.status!=='verified' || approval.approved!==1n) reason='free_model_approval_required';
      return {mode:'free' as const,bound:0n,reason};
    }
    const project = this.rows('SELECT * FROM gemini_project WHERE id=1')[0];
    if (provider !== 'gemini' || project?.state !== 'free') return { mode: 'paid' as const, bound: upperCost(provider, request), reason: null as string | null };
    const price = priceFor(provider, request.model);
    let reason: string | null = null;
    if (execution && (!credentialHash || project.credential_hash !== credentialHash)) reason = 'gemini_project_credential_changed';
    else if (price.freeTier !== 'available' || !price.checkedAt || this.now().getTime() - Date.parse(price.checkedAt) > 30 * 86400000) reason = 'gemini_free_model_unverified';
    else if (this.freeUse(provider, request.model).status === 'unavailable') reason = 'gemini_free_unavailable';
    return { mode: 'free' as const, bound: 0n, reason };
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
      source: String(row?.source ?? price.sourceUrl), conditions: String(row?.conditions ?? 'Account eligibility and remaining quota are not verified. Paid upper bound and all budgets still apply.'),
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
      : 'Current account eligibility and remaining quota are unknown. Scoped approval accepts possible paid charges within existing budgets.';
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
  scopedFreeApproval(provider: ProviderId, model: string, credentialHash?: string) {
    if (!this.freeUse(provider, model).approvedForAutomatic) return false;
    return credentialHash === undefined || this.rows('SELECT credential_hash FROM model_free_use WHERE provider=? AND model=?', provider, model)[0]?.credential_hash === credentialHash;
  }
  reserve(provider: ProviderId, request: ChatRequest, task: TaskKind, exception = false, automatic?: { revision: number; difficulty: Difficulty; tier: Tier; credentialHash?: string }, credentialHash?: string): Reservation {
    if (automatic && exception) throw new NidusError('invalid_request', 'Automatic reservations cannot use budget exceptions.');
    const price = priceFor(provider, request.model);
    let bound: bigint | null = null, billingMode: 'free' | 'paid' = 'paid';
    const at = this.now().toISOString(), month = at.slice(0, 7), id = randomUUID();
    const reason = this.transaction(() => {
      const billing = this.billing(provider, request, credentialHash ?? automatic?.credentialHash, true);
      bound = billing.bound; billingMode = billing.mode;
      let block = billing.reason ?? this.checkBudget(provider, bound, month, exception);
      if (automatic) {
        const settings = this.routingSettings();
        if (settings.revision !== automatic.revision || !settings.policies[automatic.difficulty].includes(automatic.tier)) block = 'routing_policy_changed';
        else {
          const assigned = this.rows('SELECT tier FROM model_tiers WHERE provider=? AND model=?', provider, request.model)[0];
          if (!assigned || assigned.tier !== BigInt(automatic.tier) || automatic.tier === 0) block = 'model_tier_mismatch';
          else if (bound !== null && bound > 0n && !settings.allowPaid && (!automatic.credentialHash || !this.scopedFreeApproval(provider, request.model, automatic.credentialHash))) block = 'automatic_paid_disabled';
        }
      }
      this.db.prepare(`INSERT INTO requests(id,at,month,provider,model,task,status,settlement,cost_status,reserved,bound,price_version,price_json,exception,block_reason,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, at, month, provider, request.model, task, block ? 'blocked' : 'pending', block ? 'not_sent' : 'reserved', 'unknown', block ? 0n : bound!, bound, priceVersion(price), JSON.stringify(price), exception ? 1 : 0, block, at);
      this.db.prepare('INSERT INTO request_billing VALUES(?,?,?)').run(id, billingMode, billingMode === 'free' ? JSON.stringify(provider === 'gemini' ? this.geminiBilling() : this.providerPlan(provider)) : 'paid-price-snapshot');
      return block;
    });
    if (reason) { const error = new NidusError('budget', `Budget Guard blocked this request (${reason}). Review Usage & Budget. No inference request was sent.`); error.reason = reason; throw error; }
    return { id, price, bound: bound!, billingMode };
  }
  settle(reservation: Reservation, status: 'succeeded' | 'failed' | 'cancelled', usage?: Usage | null, headers: Record<string, string> = {}) {
    const token = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    this.transaction(() => {
      const saved = this.rows("SELECT price_json,bound FROM requests WHERE id=? AND status='pending'", reservation.id)[0];
      if (!saved) throw new NidusError('storage', 'Request settlement was already recorded or is missing.');
      const free = this.rows('SELECT mode FROM request_billing WHERE id=?', reservation.id)[0]?.mode === 'free';
      const cost = free && token(usage?.inputTokens) !== null && token(usage?.outputTokens) !== null ? 0n : free ? null : calculatedCost(JSON.parse(saved.price_json as string) as Price, usage);
      const result = this.db.prepare(`UPDATE requests SET status=?,settlement=?,cost_status=?,reserved=?,estimated=?,input=?,output=?,cached=?,writes=?,reasoning=?,headers=?,updated_at=?
        WHERE id=? AND status='pending'`).run(status, cost === null ? 'unresolved' : 'estimated', cost === null ? 'unknown' : 'estimated', cost === null ? saved.bound as bigint : 0n, cost,
        token(usage?.inputTokens), token(usage?.outputTokens), token(usage?.cachedInputTokens), token(usage?.cacheWriteTokens), token(usage?.reasoningTokens), JSON.stringify(rateLimitHeaders(new Headers(headers))), this.now().toISOString(), reservation.id);
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
    return { currency: 'USD', month, source: 'nidus-local-ledger', updatedAt: this.rows('SELECT MAX(updated_at) AS at FROM requests')[0]?.at ?? null,
      accountReports: this.rows('SELECT report FROM account_reports WHERE month=?', month).map(r => JSON.parse(r.report as string) as AccountReport),
      lastProviderSyncAt: this.rows("SELECT MAX(at) AS at FROM (SELECT at FROM balances UNION ALL SELECT json_extract(report,'$.syncedAt') AS at FROM account_reports)")[0]?.at ?? null,
      total: overview(), providers: providerIds.map(p => overview(p)), requestBudgetUSD: this.budget('request') === null ? null : dollars(this.budget('request')!),
      requests, models, balances: this.rows('SELECT * FROM balances'),
      note: 'Local Nidus requests only. Reservations may exceed expected cost. Provider invoices and external usage can differ. Pending costs never expire automatically.' };
  }
}
