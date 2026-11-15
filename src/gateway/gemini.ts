// Gemini as two providers: "gemini-free" (a key of a project without billing: free quota, no
// charge) and "gemini-paid" (a key of a billed project: every call is charged). They share the
// endpoint and wire format and differ in key, project, quota and the rules below.
//   - Which one a key belongs to is not read off the key or a model name. The user connects a key
//     to one of them; what Google says about the project (billing linked, the quota a refused
//     call names) then confirms or contradicts it.
//   - The free provider stops calling as soon as there is evidence its project is billed.
//   - The paid provider is used only where the user put it first, unless they allow it as a fallback.
//
//   .nidus/local/providers.json   project, fallback permission and manual limits per provider;
//                                 the record of moving the connection from before the split
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NidusError } from '../errors.js';
import type { ModelStore } from '../storage.js';
import { gatewayProviderIds, type ProviderId } from '../types.js';
import { quotaKinds, type QuotaKind } from './quota/quota.js';
import type { GeminiTier } from './quota/google.js';

export const geminiProviders = ['gemini-free', 'gemini-paid'] as const;
export type SplitGemini = typeof geminiProviders[number];
export const isSplitGemini = (provider: string): provider is SplitGemini => provider === 'gemini-free' || provider === 'gemini-paid';
export const tierOf = (provider: SplitGemini): GeminiTier => provider === 'gemini-free' ? 'free' : 'paid';

/** A provider the Vault gateway offers. */
export function providerId(value: string): ProviderId {
  if (!gatewayProviderIds.includes(value as ProviderId)) throw new NidusError('invalid_request', `Provider must be one of: ${gatewayProviderIds.join(', ')}.`);
  return value as ProviderId;
}

export type ManualLimits = Record<string, Partial<Record<QuotaKind, number>>>;

export interface ProviderSettings {
  /** Google Cloud project of this provider's API key (id or number). */
  project?: string;
  /** Paid only: may be used when the candidates before it are unavailable. Off unless the user turns it on. */
  allowFallback?: boolean;
  /** Limits the user entered, for when Google gives none. */
  limits?: ManualLimits;
}

export interface SettingsFile {
  version: 1;
  providers: Record<string, ProviderSettings>;
  /** The connection from before the split was moved here; shown until the user confirms where it belongs. */
  geminiMigration?: { at: string; to: SplitGemini; found: boolean; keyChecked: boolean; acknowledged: boolean };
}

export class ProviderSettingsStore {
  constructor(private readonly file: string) {}

  async load(): Promise<SettingsFile> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw?.version === 1 && raw.providers && typeof raw.providers === 'object') return raw;
    } catch {}
    return { version: 1, providers: {} };
  }

  async save(settings: SettingsFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const pending = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(pending, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(pending, this.file);
  }

  async change(edit: (settings: SettingsFile) => void): Promise<SettingsFile> {
    const settings = await this.load();
    edit(settings);
    await this.save(settings);
    return settings;
  }
}

/** Limits as the user typed them: whole numbers of zero or more; an empty value removes the limit. */
export function manualLimits(value: unknown): ManualLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NidusError('invalid_request', 'Limits must be an object of model -> { rpm, tpm, rpd }.');
  const out: ManualLimits = {};
  for (const [model, kinds] of Object.entries(value as Record<string, unknown>)) {
    if (!model || model.length > 200 || !kinds || typeof kinds !== 'object') continue;
    const row: Partial<Record<QuotaKind, number>> = {};
    for (const kind of quotaKinds) {
      const n = (kinds as Record<string, unknown>)[kind];
      if (n === null || n === undefined || n === '') continue;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new NidusError('invalid_request', `Limit ${kind} of ${model} must be a whole number of 0 or more.`);
      row[kind] = n;
    }
    if (Object.keys(row).length) out[model] = row;
  }
  return out;
}

async function rewrite(path: string, change: (text: string) => string): Promise<boolean> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return false; }
  const next = change(text);
  if (next === text) return false;
  const pending = `${path}.${randomUUID()}.tmp`;
  await writeFile(pending, next);
  await rename(pending, path);
  return true;
}

/** Renames a provider in everything a Vault keeps by provider id: candidates, model cache, check results. */
export async function moveProviderData(files: { modelsFile: string; checksFile: string }, models: ModelStore, from: ProviderId, to: ProviderId): Promise<boolean> {
  const refs = (text: string) => text.replaceAll(`"${from}:`, `"${to}:`);
  let moved = await rewrite(files.modelsFile, refs);
  moved = await rewrite(files.checksFile, refs) || moved;
  const snapshot = await models.load(from).catch(() => null);
  if (snapshot) {
    await models.save({ ...snapshot, provider: to, models: snapshot.models.map(model => ({ ...model, provider: to })) });
    await models.remove(from);
    moved = true;
  }
  return moved;
}
