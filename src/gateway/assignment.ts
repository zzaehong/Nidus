// Model Assignment: role and worker difficulty decide the model.
// The caller that delegates the work states the difficulty; nothing here guesses it.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { NidusError } from '../errors.js';
import { gatewayProviderIds, type Model, type ProviderId } from '../types.js';

export const difficulties = ['simple', 'normal', 'complex'] as const;
export type Difficulty = typeof difficulties[number];

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

/** A model the user took out after seeing its work. Auto-fill never puts it back. */
export interface Exclusion {
  ref: string;
  at: string;
  /** Where the work that prompted this was done. */
  role: string;
  difficulty: Difficulty | null;
  /** "slot": out of that one slot; "vault": out of every slot of this Vault. */
  scope: 'slot' | 'vault';
  slot: string | null;
  note: string | null;
  taskId: string | null;
}

export interface AssignmentTable {
  version: 1;
  /** Ordered candidates per non-worker role, for example main, lead-manager, manager. */
  roles: Record<string, ModelRef[]>;
  worker: Record<Difficulty, ModelRef[]>;
  /** Candidates that auto-fill placed, per slot id ("roles.main", "worker.simple"); the rest were the user's own. */
  auto: Record<string, string[]>;
  excluded: Exclusion[];
}

export const slotId = (role: string, difficulty?: Difficulty | null): string => role === 'worker' ? `worker.${difficulty}` : `roles.${role}`;

/** Whether an exclusion keeps a model out of this slot. */
export function excludedFrom(excluded: Exclusion[], ref: string, slot: string): Exclusion | null {
  return excluded.find(x => x.ref === ref && (x.scope === 'vault' || x.slot === slot)) ?? null;
}

export interface AssignTarget {
  role: string;
  /** Required for the worker role, rejected for every other role. */
  difficulty?: Difficulty;
  needs?: { tools?: boolean };
  /** Candidates to pass over for now (e.g. just rate limited), as "provider:model". Used only if another candidate is available. */
  avoid?: string[];
}

export interface Assignment extends ModelRef {
  role: string;
  difficulty: Difficulty | null;
  /** Position of the chosen model in its candidate list; 0 is the first choice. */
  candidateIndex: number;
  reason: string;
  skipped: { ref: string; why: string }[];
  outputTokenLimit: number | null;
}

/** What assignment needs to know about the current machine and vault. */
export interface Availability {
  hasKey(provider: ProviderId): Promise<boolean>;
  cachedModel(provider: ProviderId, model: string): Promise<Model | null>;
  toolsVerified(provider: ProviderId, model: string): Promise<boolean>;
  /** Why a candidate must not be used at this position of its slot, or null. For rules that are not about the model itself. */
  refused?(ref: ModelRef, index: number): Promise<string | null>;
}

const rolePattern = /^[a-z][a-z0-9-]{0,63}$/;

function invalidTable(message: string): never {
  throw new NidusError('invalid_request', `Invalid .nidus/models.json: ${message}`);
}

export const refName = (ref: ModelRef): string => `${ref.provider}:${ref.model}`;

/** "provider:model". Model ids may contain colons and slashes; the provider never does. */
export function parseRef(value: unknown): ModelRef {
  if (typeof value !== 'string') invalidTable('each candidate must be a "provider:model" string.');
  const split = value.indexOf(':');
  const provider = value.slice(0, split);
  const model = value.slice(split + 1);
  // Candidates written before Gemini was split into Free and Paid.
  if (provider === 'gemini') return parseRef(`gemini-free:${model}`);
  if (split < 1 || !gatewayProviderIds.includes(provider as ProviderId)) invalidTable(`unknown provider in "${value}".`);
  if (!model || model.length > 512 || /[\r\n\0]/.test(model)) invalidTable(`missing model id in "${value}".`);
  return { provider: provider as ProviderId, model };
}

function candidates(value: unknown, where: string): ModelRef[] {
  if (!Array.isArray(value)) invalidTable(`"${where}" must be an array.`);
  return value.map(parseRef);
}

export function parseTable(value: unknown): AssignmentTable {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidTable('expected an object.');
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) invalidTable('unsupported version.');
  if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) invalidTable('"roles" must be an object.');
  if (!raw.worker || typeof raw.worker !== 'object' || Array.isArray(raw.worker)) invalidTable('"worker" must be an object.');

  const roles: Record<string, ModelRef[]> = {};
  for (const [role, list] of Object.entries(raw.roles)) {
    if (!rolePattern.test(role) || role === 'worker') invalidTable(`invalid role name "${role}".`);
    roles[role] = candidates(list, `roles.${role}`);
  }
  const worker = raw.worker as Record<string, unknown>;
  const unknown = Object.keys(worker).find(key => !difficulties.includes(key as Difficulty));
  if (unknown) invalidTable(`unknown worker difficulty "${unknown}".`);
  const auto: Record<string, string[]> = {};
  if (raw.auto !== undefined) {
    if (!raw.auto || typeof raw.auto !== 'object' || Array.isArray(raw.auto)) invalidTable('"auto" must be an object.');
    for (const [slot, list] of Object.entries(raw.auto as Record<string, unknown>)) auto[slot] = candidates(list, `auto.${slot}`).map(refName);
  }
  const excluded: Exclusion[] = [];
  if (raw.excluded !== undefined) {
    if (!Array.isArray(raw.excluded)) invalidTable('"excluded" must be an array.');
    for (const item of raw.excluded) {
      const x = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const ref = refName(parseRef(x.ref));
      const scope = x.scope === 'vault' ? 'vault' : 'slot';
      const difficulty = difficulties.includes(x.difficulty as Difficulty) ? x.difficulty as Difficulty : null;
      excluded.push({ ref, at: typeof x.at === 'string' ? x.at : new Date(0).toISOString(), role: typeof x.role === 'string' && rolePattern.test(x.role) ? x.role : 'worker', difficulty, scope,
        slot: scope === 'slot' ? (typeof x.slot === 'string' ? x.slot : null) : null, note: typeof x.note === 'string' && x.note ? x.note.slice(0, 500) : null, taskId: typeof x.taskId === 'string' ? x.taskId : null });
    }
  }
  return {
    version: 1,
    roles,
    worker: {
      simple: candidates(worker.simple ?? [], 'worker.simple'),
      normal: candidates(worker.normal ?? [], 'worker.normal'),
      complex: candidates(worker.complex ?? [], 'worker.complex'),
    },
    auto,
    excluded,
  };
}

export async function loadTable(path: string): Promise<AssignmentTable> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new NidusError('storage', 'Could not read .nidus/models.json.');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    invalidTable('not valid JSON.');
  }
  return parseTable(json);
}

/** Writes the table in its on-disk form: candidates as "provider:model" strings. */
export async function saveTable(path: string, table: AssignmentTable): Promise<void> {
  const names = (list: ModelRef[]) => list.map(refName);
  const auto = Object.fromEntries(Object.entries(table.auto).filter(([, list]) => list.length));
  const disk = {
    version: 1,
    roles: Object.fromEntries(Object.entries(table.roles).map(([role, list]) => [role, names(list)])),
    worker: { simple: names(table.worker.simple), normal: names(table.worker.normal), complex: names(table.worker.complex) },
    ...(Object.keys(auto).length ? { auto } : {}),
    ...(table.excluded.length ? { excluded: table.excluded } : {}),
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(disk, null, 2)}\n`);
    await rename(temporary, path);
  } catch {
    throw new NidusError('storage', 'Could not save .nidus/models.json.');
  }
}

function slot(table: AssignmentTable, target: AssignTarget): { list: ModelRef[]; name: string } {
  if (typeof target.role !== 'string' || !rolePattern.test(target.role)) throw new NidusError('invalid_request', 'A valid role is required.');
  if (target.role === 'worker') {
    if (!target.difficulty || !difficulties.includes(target.difficulty)) {
      throw new NidusError('invalid_request', 'Worker requests need a difficulty: simple, normal or complex.');
    }
    return { list: table.worker[target.difficulty], name: `worker.${target.difficulty}` };
  }
  if (target.difficulty !== undefined) throw new NidusError('invalid_request', 'Difficulty applies only to the worker role.');
  const list = table.roles[target.role];
  if (!list) throw new NidusError('invalid_request', `Role "${target.role}" is not defined in .nidus/models.json.`);
  return { list, name: `roles.${target.role}` };
}

/**
 * Picks the first usable candidate of the slot. Never substitutes a model
 * from another slot: an empty or unusable slot is an error the user resolves.
 */
export async function assign(table: AssignmentTable, target: AssignTarget, availability: Availability): Promise<Assignment> {
  // Prefer a candidate that is not being avoided; if every one is, fall back to the usual order.
  if (target.avoid?.length) {
    try { return await pick(table, target, availability, target.avoid); } catch {}
  }
  return pick(table, target, availability, []);
}

async function pick(table: AssignmentTable, target: AssignTarget, availability: Availability, passOver: string[]): Promise<Assignment> {
  const { list, name } = slot(table, target);
  const skipped: Assignment['skipped'] = [];

  for (const [index, ref] of list.entries()) {
    const skip = (why: string) => skipped.push({ ref: refName(ref), why });
    if (passOver.includes(refName(ref))) { skip('passed over for now (failing or slow lately)'); continue; }
    if (!await availability.hasKey(ref.provider)) { skip('no API key connected'); continue; }
    const refused = await availability.refused?.(ref, index);
    if (refused) { skip(refused); continue; }
    const model = await availability.cachedModel(ref.provider, ref.model);
    if (!model) { skip('model not in the cached model list'); continue; }
    if (model.capabilities.chat === 'unsupported') { skip('model does not support chat'); continue; }

    let tools = '';
    if (target.needs?.tools) {
      if (model.capabilities.tools === 'unsupported') { skip('model does not support tool calls'); continue; }
      const confirmed = model.capabilities.tools === 'supported' || await availability.toolsVerified(ref.provider, ref.model);
      tools = confirmed ? '; tools confirmed' : '; tools unverified';
    }
    const choice = index === 0 ? 'first choice' : `fallback #${index} (${skipped.map(item => `${item.ref}: ${item.why}`).join('; ')})`;
    return {
      ...ref,
      role: target.role,
      difficulty: target.difficulty ?? null,
      candidateIndex: index,
      reason: `${name}: ${choice}${tools}`,
      skipped,
      outputTokenLimit: model.limits.outputTokens,
    };
  }

  const detail = list.length ? skipped.map(item => `${item.ref} (${item.why})`).join(', ') : 'no candidates listed';
  const error = new NidusError('unsupported', `No usable model for ${name}: ${detail}.`);
  error.reason = 'no_assignable_model';
  throw error;
}
