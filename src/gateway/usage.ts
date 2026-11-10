// Per-vault usage log. One row per model call, in .nidus/local/usage.sqlite.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NidusError } from '../errors.js';
import { dollars, money } from '../money.js';
import type { ProviderId, Usage } from '../types.js';

const SCHEMA_VERSION = 1;

export interface CallRecord {
  role: string;
  difficulty: string | null;
  agentId?: string | null;
  taskId?: string | null;
  provider: ProviderId;
  model: string;
  reason: string;
  candidateIndex: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  errorCode?: string | null;
  stopReason?: string | null;
  usage?: Usage | null;
  /** Nano-USD. null means the price is unknown, which is never treated as zero. */
  costNano: bigint | null;
  durationMs: number;
}

export interface UsageGroup {
  role: string;
  difficulty: string | null;
  provider: string;
  model: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUSD: string;
  unknownCostCalls: number;
}

export interface UsageSummary {
  month: string;
  calls: number;
  costUSD: string;
  unknownCostCalls: number;
  groups: UsageGroup[];
}

export const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

export class UsageLog {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly now: () => Date = () => new Date()) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch {
      throw new NidusError('storage', 'Could not open the vault usage log.');
    }
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new NidusError('storage', 'The vault usage log was written by a newer Nidus.');
    }
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS calls(
        id TEXT PRIMARY KEY, at TEXT NOT NULL, month TEXT NOT NULL,
        role TEXT NOT NULL, difficulty TEXT, agent TEXT, task TEXT,
        provider TEXT NOT NULL, model TEXT NOT NULL, reason TEXT NOT NULL, candidate INTEGER NOT NULL,
        status TEXT NOT NULL, error TEXT, stop TEXT,
        input INTEGER, output INTEGER, cached INTEGER, writes INTEGER, reasoning INTEGER,
        cost INTEGER, duration_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_month ON calls(month, role, difficulty);
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  close(): void {
    this.db.close();
  }

  record(call: CallRecord): string {
    const id = randomUUID();
    const at = this.now();
    const usage = call.usage;
    this.db.prepare(`INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, at.toISOString(), monthOf(at),
      call.role, call.difficulty, call.agentId ?? null, call.taskId ?? null,
      call.provider, call.model, call.reason, call.candidateIndex,
      call.status, call.errorCode ?? null, call.stopReason ?? null,
      usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.cachedInputTokens ?? null,
      usage?.cacheWriteTokens ?? null, usage?.reasoningTokens ?? null,
      call.costNano, Math.max(0, Math.round(call.durationMs)));
    return id;
  }

  /** Known cost of the month in nano-USD. Calls with an unknown price are not included. */
  monthCost(month = monthOf(this.now())): bigint {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost),0) AS total FROM calls WHERE month=?').get(month) as { total: number | bigint };
    return BigInt(row.total);
  }

  summary(month = monthOf(this.now())): UsageSummary {
    const rows = this.db.prepare(`
      SELECT role, difficulty, provider, model,
        COUNT(*) AS calls,
        SUM(status!='succeeded') AS failed,
        COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cached),0) AS cached,
        COALESCE(SUM(cost),0) AS cost,
        SUM(cost IS NULL AND status='succeeded') AS unknown
      FROM calls WHERE month=?
      GROUP BY role, difficulty, provider, model
      ORDER BY role, difficulty, provider, model`).all(month) as Record<string, string | number | bigint | null>[];

    const groups: UsageGroup[] = rows.map(row => ({
      role: String(row.role),
      difficulty: row.difficulty === null ? null : String(row.difficulty),
      provider: String(row.provider),
      model: String(row.model),
      calls: Number(row.calls),
      failed: Number(row.failed),
      inputTokens: Number(row.input),
      outputTokens: Number(row.output),
      cachedInputTokens: Number(row.cached),
      costUSD: dollars(BigInt(row.cost ?? 0)),
      unknownCostCalls: Number(row.unknown),
    }));
    return {
      month,
      calls: groups.reduce((sum, group) => sum + group.calls, 0),
      costUSD: dollars(this.monthCost(month)),
      unknownCostCalls: groups.reduce((sum, group) => sum + group.unknownCostCalls, 0),
      groups,
    };
  }
}

/** Monthly vault budget in nano-USD, or null when none is set. */
export async function loadBudget(path: string): Promise<bigint | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new NidusError('storage', 'Could not read .nidus/budget.json.');
  }
  try {
    const raw = JSON.parse(text) as { version?: unknown; monthlyUSD?: unknown };
    if (raw.version !== 1) throw new Error();
    return raw.monthlyUSD === null || raw.monthlyUSD === undefined ? null : money(raw.monthlyUSD);
  } catch {
    throw new NidusError('invalid_request', 'Invalid .nidus/budget.json: expected { "version": 1, "monthlyUSD": "<decimal>" | null }.');
  }
}

export interface Warning {
  code: 'budget_exceeded' | 'cost_unknown';
  message: string;
}

/** The budget only warns; it never blocks a call. */
export function budgetWarning(budget: bigint | null, spent: bigint, month: string): Warning | null {
  if (budget === null || spent <= budget) return null;
  return { code: 'budget_exceeded', message: `Vault spending for ${month} is $${dollars(spent)}, over the $${dollars(budget)} budget.` };
}
