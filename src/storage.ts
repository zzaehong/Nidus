import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { NidusError } from "./errors.js";
import type { Model, ProviderId } from "./types.js";
export interface ModelSnapshot { version: 1; provider: ProviderId; fetchedAt: string; models: Model[] }
export interface ModelStore { load(provider: ProviderId): Promise<ModelSnapshot | null>; save(snapshot: ModelSnapshot): Promise<void>; remove(provider: ProviderId): Promise<void> }
export class FileModelStore implements ModelStore {
  constructor(private readonly directory = join(homedir(), ".local", "share", "nidus")) {}
  async load(provider: ProviderId): Promise<ModelSnapshot | null> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, `${provider}.json`), "utf8")) as ModelSnapshot;
      if (data.version !== 1 || data.provider !== provider || !Array.isArray(data.models) || !data.models.every(m => m.provider === provider && typeof m.id === "string" && m.capabilities) || typeof data.fetchedAt !== "string") throw new Error();
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new NidusError("storage", "Model cache unreadable. Use models --refresh to rebuild it.");
    }
  }
  async save(snapshot: ModelSnapshot): Promise<void> {
    const temporary = join(this.directory, `${snapshot.provider}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, `${snapshot.provider}.json`));
    } catch { throw new NidusError("storage", "Could not save model cache."); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async remove(provider: ProviderId): Promise<void> {
    try { await unlink(join(this.directory, `${provider}.json`)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new NidusError("storage", "Could not remove model cache."); }
  }
}
