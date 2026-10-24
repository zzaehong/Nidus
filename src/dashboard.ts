// One bounded request per child process. stdout is exclusively the response envelope.
import { pathToFileURL } from "node:url";
import { ConnectivityEngine } from "./engine.js";
import { KeychainStore } from "./credentials.js";
import { FileModelStore } from "./storage.js";
import { providerId } from "./adapters/index.js";
import { NidusError, publicError } from "./errors.js";
import type { ChatRequest } from "./types.js";

export async function dispatch(input: unknown, engine: ConnectivityEngine): Promise<unknown> {
  if (!input || typeof input !== "object") throw new NidusError("invalid_request", "Invalid dashboard request.");
  const r = input as Record<string, unknown>;
  if (r.method === "ping") return { ready: true };
  if (r.method === "usage") return engine.usage();
  if (r.method === 'gemini-billing-set') return engine.setGeminiBilling(r.state, r.project, r.confirmed, r.riskAccepted);
  if (r.method === 'routing-settings') return engine.routingSettings();
  if (r.method === 'routing-policy-set') return engine.setRoutingPolicy(r.difficulty, r.tiers);
  if (r.method === 'automatic-paid-set') return engine.setAutomaticPaid(r.allowed);
  if (r.method === 'free-use-set') return engine.setFreeUse(providerId(typeof r.provider === 'string' ? r.provider : ''), r.model, r.status, r.approved, r.accountConfirmed, r.chargeRiskAccepted);
  if (r.method === 'model-tier-set') return engine.setModelTier(providerId(typeof r.provider === 'string' ? r.provider : ''), r.model, r.tier);
  if (r.method === "budget-set") return engine.setBudget(r.scope, r.usd);
  if (r.method === "route-plan" || r.method === "auto-chat") {
    if (!r.request || typeof r.request !== 'object') throw new NidusError('invalid_request', 'Invalid chat request.');
    return r.method === 'route-plan' ? engine.routePlan(r.request as ChatRequest, r.difficulty)
      : engine.autoChat(r.request as ChatRequest, r.difficulty, { timeoutMs: 120_000 });
  }
  const provider = providerId(typeof r.provider === "string" ? r.provider : "");
  switch (r.method) {
    case "account-sync": return engine.syncAccount(provider);
    case "balance-sync": return engine.syncBalance(provider);
    case "cached": return engine.cachedModels(provider);
    case "connect":
      if (typeof r.key !== "string") throw new NidusError("missing_key", "API Key is required.");
      return engine.connect(provider, r.key);
    case "models": return engine.models(provider, true);
    case "detail":
      if (typeof r.model !== "string") throw new NidusError("invalid_request", "Select a model.");
      return engine.detail(provider, r.model);
    case "pricing": return engine.pricing(provider);
    case "probe":
      if (typeof r.model !== "string" || r.confirmed !== true || (r.allowInferred !== undefined && typeof r.allowInferred !== "boolean"))
        throw new NidusError("invalid_request", "Confirm probe cost and select a discovered model.");
      return engine.probe(provider, r.model, r.allowInferred === true);
    case "chat":
      if (!r.request || typeof r.request !== "object") throw new NidusError("invalid_request", "Invalid chat request.");
      return engine.chat(provider, r.request as ChatRequest, { timeoutMs: 120_000 });
    case "disconnect": return engine.disconnect(provider);
    default: throw new NidusError("invalid_request", "Unknown dashboard operation.");
  }
}

async function main() {
  const timer = setTimeout(() => process.exit(1), 240_000);
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1_048_576) throw new NidusError("invalid_request", "Request too large.");
      chunks.push(chunk);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new NidusError("invalid_request", "Invalid request JSON."); }
    const result = await dispatch(input, new ConnectivityEngine(new KeychainStore(), new FileModelStore()));
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) { process.stdout.write(JSON.stringify({ error: publicError(error).toJSON() })); }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
