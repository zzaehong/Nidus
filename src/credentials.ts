import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NidusError } from "./errors.js";
import type { ProviderId } from "./types.js";

export interface CredentialStore { get(provider: ProviderId): Promise<string | null>; set(provider: ProviderId, key: string): Promise<void>; delete(provider: ProviderId): Promise<void> }
export const credentialEnvironment: Record<ProviderId, string> = { openai: "NIDUS_OPENAI_API_KEY", anthropic: "NIDUS_ANTHROPIC_API_KEY", gemini: "NIDUS_GEMINI_API_KEY", deepseek: "NIDUS_DEEPSEEK_API_KEY" };

export class KeychainStore implements CredentialStore {
  constructor(private readonly helper = fileURLToPath(new URL("./nidus-keychain", import.meta.url)), private readonly service = "com.nidus.connectivity") {}
  private async call(action: string, provider: ProviderId, key?: string): Promise<string | null> {
    if (process.platform !== "darwin") throw new NidusError("unsupported", "Persistent credentials require macOS Keychain. Use an environment credential for session-only access on other platforms.");
    return new Promise((resolve, reject) => {
      // Secrets go only over a private pipe, never argv, shell commands or environment.
      const child = spawn(this.helper, [], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } });
      let output = "";
      const timer = setTimeout(() => { child.kill(); reject(new NidusError("storage", "Keychain access timed out.")); }, 60_000);
      child.on("error", () => { clearTimeout(timer); reject(new NidusError("storage", "Keychain helper unavailable. Run npm run build:keychain on macOS.")); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", data => { output += data; if (output.length > 65536) child.kill(); });
      child.stdin.on("error", () => {});
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new NidusError("storage", "macOS Keychain access failed or was denied.")); return; }
        try { const value = JSON.parse(output); resolve(typeof value.key === "string" ? value.key : null); }
        catch { reject(new NidusError("storage", "Invalid Keychain response.")); }
      });
      child.stdin.end(JSON.stringify({ action, provider, key, service: this.service }));
    });
  }
  get(provider: ProviderId) { return this.call("get", provider); }
  async set(provider: ProviderId, key: string) { await this.call("set", provider, key); }
  async delete(provider: ProviderId) { await this.call("delete", provider); }
}

export class EnvironmentCredentials implements CredentialStore {
  constructor(private readonly persistent: CredentialStore, private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(provider: ProviderId) { return this.env[credentialEnvironment[provider]] || this.persistent.get(provider); }
  set(provider: ProviderId, key: string) { return this.persistent.set(provider, key); }
  delete(provider: ProviderId) { return this.persistent.delete(provider); }
}
