import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NidusError } from './errors.js';
import { dollars, money } from './money.js';
import { calculatedCost, priceFor, priceVersion, upperCost, type Price } from './pricing.js';
import { providerIds, type ChatRequest, type ProviderId, type Usage } from './types.js';

export type BudgetScope = 'total' | 'request' | ProviderId;
export type TaskKind = 'chat' | 'probe';
export interface Reservation { id: string; price: Price; bound: bigint }
type Row = Record<string, string | bigint | null>;
export const ledgerPath = () => join(homedir(), '.local', 'share', 'nidus', 'usage.sqlite');
export class UsageLedger {
  private db: DatabaseSync;
  constructor(path = ledgerPath(), private readonly now: () => Date = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
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
      PRAGMA user_version=1;`);
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
  reserve(provider: ProviderId, request: ChatRequest, task: TaskKind, exception = false): Reservation {
    const price = priceFor(provider, request.model), bound = upperCost(provider, request, price);
    const at = this.now().toISOString(), month = at.slice(0, 7), id = randomUUID();
    const reason = this.transaction(() => {
      const total = this.budget('total'), single = this.budget('request'), specific = this.budget(provider);
      let block: string | null = bound === null ? 'unknown_price_or_bound' : null;
      if (!block && bound! > 0n && !exception) {
        if (total === null || single === null) block = 'budget_not_configured';
        else if (bound! > single) block = 'request_budget';
        else if (this.exposure(month) >= total || this.exposure(month) + bound! > total) block = 'monthly_budget';
        else if (specific !== null && (this.exposure(month, provider) >= specific || this.exposure(month, provider) + bound! > specific)) block = 'provider_budget';
      }
      this.db.prepare(`INSERT INTO requests(id,at,month,provider,model,task,status,settlement,cost_status,reserved,bound,price_version,price_json,exception,block_reason,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, at, month, provider, request.model, task, block ? 'blocked' : 'pending', block ? 'not_sent' : 'reserved', 'unknown', block ? 0n : bound!, bound, priceVersion(price), JSON.stringify(price), exception ? 1 : 0, block, at);
      return block;
    });
    if (reason) throw new NidusError('budget', `Budget Guard blocked this request (${reason}). Review Usage & Budget. No inference request was sent.`);
    return { id, price, bound: bound! };
  }
  settle(reservation: Reservation, status: 'succeeded' | 'failed' | 'cancelled', usage?: Usage | null, headers: Record<string, string> = {}) {
    const cost = calculatedCost(reservation.price, usage);
    const token = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE requests SET status=?,settlement=?,cost_status=?,reserved=?,estimated=?,input=?,output=?,cached=?,writes=?,reasoning=?,headers=?,updated_at=?
        WHERE id=? AND status='pending'`).run(status, cost === null ? 'unresolved' : 'estimated', cost === null ? 'unknown' : 'estimated', cost === null ? reservation.bound : 0n, cost,
        token(usage?.inputTokens), token(usage?.outputTokens), token(usage?.cachedInputTokens), token(usage?.cacheWriteTokens), token(usage?.reasoningTokens), JSON.stringify(headers), this.now().toISOString(), reservation.id);
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
      const level = limit === null ? 'unconfigured' : used >= limit ? 'blocked' : used * 100n >= limit * 90n ? 'saving' : used * 100n >= limit * 80n ? 'warning' : 'normal';
      return { scope: provider ?? 'total', budgetUSD: limit === null ? null : dollars(limit), estimatedUSD: dollars(estimated), confirmedUSD: rows.some(r => r.month === month && r.confirmed !== null) ? dollars(confirmed) : null,
        reservedUSD: dollars(reserved), exposureUSD: dollars(used), remainingUSD: limit === null ? null : dollars(limit > used ? limit - used : 0n), level,
        utilizationPercent: limit && limit > 0n ? Number(used * 10000n / limit) / 100 : null,
        unknownCount: rows.filter(r => r.settlement === 'unresolved' || r.status === 'pending').length,
        unknownPriceCount: rows.filter(r => r.block_reason === 'unknown_price_or_bound').length };
    };
    const requests = this.rows('SELECT * FROM requests ORDER BY at DESC, rowid DESC LIMIT 200').map(r => ({
      id: r.id, at: r.at, provider: r.provider, model: r.model, task: r.task, status: r.status, settlement: r.settlement, costStatus: r.cost_status,
      reservedUSD: dollars(r.reserved as bigint), boundUSD: r.bound === null ? null : dollars(r.bound as bigint), estimatedUSD: r.estimated === null ? null : dollars(r.estimated as bigint), confirmedUSD: r.confirmed === null ? null : dollars(r.confirmed as bigint),
      inputTokens: r.input === null ? null : Number(r.input), outputTokens: r.output === null ? null : Number(r.output), cachedTokens: r.cached === null ? null : Number(r.cached), cacheWriteTokens: r.writes === null ? null : Number(r.writes), reasoningTokens: r.reasoning === null ? null : Number(r.reasoning),
      priceVersion: r.price_version, pricing: JSON.parse(r.price_json as string), exception: r.exception === 1n, blockReason: r.block_reason, headers: JSON.parse(r.headers as string), updatedAt: r.updated_at
    }));
    const models = this.rows(`SELECT provider,model,COUNT(*) AS count,SUM(input) AS input,SUM(output) AS output,SUM(estimated) AS estimated,SUM(confirmed) AS confirmed,SUM(reserved) AS reserved FROM requests WHERE month=? AND status!='blocked' GROUP BY provider,model`, month).map(r => ({
      provider: r.provider, model: r.model, requests: Number(r.count), inputTokens: r.input === null ? null : Number(r.input), outputTokens: r.output === null ? null : Number(r.output), estimatedUSD: r.estimated === null ? null : dollars(r.estimated as bigint), confirmedUSD: r.confirmed === null ? null : dollars(r.confirmed as bigint), reservedUSD: dollars(r.reserved as bigint)
    }));
    return { currency: 'USD', month, source: 'nidus-local-ledger', updatedAt: this.rows('SELECT MAX(updated_at) AS at FROM requests')[0]?.at ?? null,
      lastProviderSyncAt: this.rows('SELECT MAX(at) AS at FROM balances')[0]?.at ?? null,
      total: overview(), providers: providerIds.map(p => overview(p)), requestBudgetUSD: this.budget('request') === null ? null : dollars(this.budget('request')!),
      requests, models, balances: this.rows('SELECT * FROM balances'),
      note: 'Local Nidus requests only. Reservations may exceed expected cost. Provider invoices and external usage can differ. Pending costs never expire automatically.' };
  }
}
