// Model Assignment: role and worker difficulty decide the model.
// The caller that delegates the work states the difficulty; nothing here guesses it.
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { NidusError } from '../errors.js';
import { providerIds, type Model, type ProviderId } from '../types.js';

export const difficulties = ['simple', 'normal', 'complex'] as const;
export type Difficulty = typeof difficulties[number];

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface AssignmentTable {
  version: 1;
  /** Ordered candidates per non-worker role, for example main, lead-manager, manager. */
  roles: Record<string, ModelRef[]>;
  worker: Record<Difficulty, ModelRef[]>;
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
  if (split < 1 || !providerIds.includes(provider as ProviderId)) invalidTable(`unknown provider in "${value}".`);
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
  return {
    version: 1,
    roles,
    worker: {
      simple: candidates(worker.simple ?? [], 'worker.simple'),
      normal: candidates(worker.normal ?? [], 'worker.normal'),
      complex: candidates(worker.complex ?? [], 'worker.complex'),
    },
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
  const disk = {
    version: 1,
    roles: Object.fromEntries(Object.entries(table.roles).map(([role, list]) => [role, names(list)])),
    worker: { simple: names(table.worker.simple), normal: names(table.worker.normal), complex: names(table.worker.complex) },
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
