import { parseArgs } from "node:util";
import { providerId } from "./adapters/index.js";
import { credentialEnvironment, EnvironmentCredentials, KeychainStore } from "./credentials.js";
import { ConnectivityEngine } from "./engine.js";
import { NidusError, publicError } from "./errors.js";
import { FileModelStore } from "./storage.js";
import { secretPrompt, chatPrompt } from "./prompt.js";

export const help = `Nidus API Connectivity MVP
  nidus providers
  nidus connect <provider> [--env] [--account-id <cloudflare-account-id>]
  nidus models <provider> [--refresh | --detail <model-id>]
  nidus pricing <provider>
  nidus chat --provider <provider> --model <model-id> [--max-output-tokens 1024]
  nidus chat --auto [--difficulty simple|normal|complex]
  nidus routing
  nidus routing-context [--difficulty normal]
  nidus soft-budget <provider> --usd <amount> | --delete
  nidus routing-policy <simple|normal|complex> --tiers 2,1
  nidus model-tier <provider> --model <id> --tier <0|1|2|3|default>
  nidus billing <provider>
  nidus billing-set <provider> --billing-type free_only|hybrid|paid_only|unknown [--allow-paid] --confirm-billing --accept-charge-risk
  nidus chat --provider <provider> --model <id> --approve-once  # accepts possible paid charges for one Unknown-account request
  nidus usage
  nidus balance <provider>
  nidus account <openai|anthropic>  # separate session ADMIN_API_KEY
  nidus disconnect <provider>

connect: hidden key entry, model discovery, macOS Keychain storage.
--env: explicit NIDUS_<PROVIDER>_API_KEY session credential; never writes the key.
Usage: no monetary budget or reservations. Account billing type and Provider permissions apply.
chat: message from stdin or interactive prompt. JSON on stdout; errors on stderr.
--timeout-ms 30000 (chat default: 120000). Ctrl-C cancels an HTTP request.
`;

export interface CliDependencies {
  engine?: ConnectivityEngine;
  readSecret?: () => Promise<string>;
  readPrompt?: () => Promise<string>;
  write?: (text: string) => void;
}
export async function main(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<void> {
  const write = dependencies.write ?? (text => { process.stdout.write(text); });
  const print = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      usd: { type: "string" }, delete: { type: "boolean" },
      "billing-type": {type:"string"}, "allow-paid": {type:"boolean"}, "confirm-billing": {type:"boolean"}, "accept-charge-risk": {type:"boolean"}, "approve-once": {type:"boolean"},
      "account-id": {type:"string"}, help: { type: "boolean", short: "h" }, refresh: { type: "boolean" }, env: { type: "boolean" },
      tiers: { type: "string" }, tier: { type: "string" }, auto: { type: "boolean" }, difficulty: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, detail: { type: "string" },
      "timeout-ms": { type: "string" }, "max-output-tokens": { type: "string" },
    } }));
  } catch { throw new NidusError("invalid_request", "Invalid arguments. Use nidus --help. API keys must never be command-line arguments."); }
  if (values.help || positionals.length === 0) { write(help); return; }
  const [command, argument] = positionals;
  const commands = ["routing-context", "soft-budget","billing", "billing-set","providers", "connect", "models", "pricing", "chat", "disconnect", "usage", "balance", "account", "routing", "routing-policy", "model-tier"];
  if (!commands.includes(command!)) throw new NidusError("invalid_request", "Unknown command. Use nidus --help.");
  const expected = ["providers", "chat", "usage", "routing", "routing-context"].includes(command!) ? 1 : 2;
  if (positionals.length !== expected) throw new NidusError("invalid_request", "Unexpected positional arguments. Use nidus --help.");
  const allowed: Record<string, string[]> = {
    "routing-context": ["difficulty"], "soft-budget": ["usd", "delete"], billing: [], "billing-set": ["billing-type", "allow-paid", "confirm-billing", "accept-charge-risk", "account-id"], routing: [], "routing-policy": ["tiers"], "model-tier": ["model", "tier"], usage: [], balance: [], account: [], providers: [], connect: ["env", "timeout-ms", "account-id", "billing-type", "allow-paid", "confirm-billing", "accept-charge-risk"], models: ["refresh", "detail", "timeout-ms"],
    pricing: [], chat: ["approve-once", "auto", "difficulty", "provider", "model", "max-output-tokens", "timeout-ms"], disconnect: []
  };
  if (Object.keys(values).some(v => !allowed[command!]!.includes(v))) throw new NidusError("invalid_request", "Option is not valid for this command.");
  const persistent = new KeychainStore();
  const engine = dependencies.engine ?? new ConnectivityEngine(new EnvironmentCredentials(persistent), new FileModelStore());
  if (command === 'routing-context') { print(await engine.buildRoutingDecisionContext({type:'chat',difficulty:(values.difficulty ?? 'normal') as import('./router.js').Difficulty,requiredCapabilities:['text'],inputCharacters:null,estimatedInputTokens:null})); return; }
  if (command === 'soft-budget') {
    if ((values.delete === true) === (values.usd !== undefined)) throw new NidusError('invalid_request','Specify either --usd or --delete.');
    print(engine.setSoftBudget(providerId(argument ?? ''), values.delete ? null : values.usd)); return;
  }
  if (command === 'billing') {print(await engine.accountPermission(providerId(argument ?? '')));return;}
  if (command === 'billing-set') {print(await engine.setAccountPermission(providerId(argument ?? ''),values['billing-type'],values['allow-paid']===true,values['confirm-billing']===true,values['accept-charge-risk']===true,values['account-id'] ?? ''));return;}
  if (command === 'routing') { print(await engine.routingSettings()); return; }
  if (command === 'routing-policy') { print(await engine.setRoutingPolicy(argument, values.tiers === '' ? [] : values.tiers?.split(',').map(Number))); return; }
  if (command === 'model-tier') { print(await engine.setModelTier(providerId(argument ?? ''), values.model, values.tier === 'default' ? null : values.tier === undefined || values.tier === '' ? undefined : Number(values.tier))); return; }
  if (command === "usage") { print(engine.usage()); return; }
  if (command === "account") { print(await engine.syncAccount(providerId(argument ?? ""))); return; }
  if (command === "balance") { print(await engine.syncBalance(providerId(argument ?? ""))); return; }
  if (command === "providers") { print(engine.providers()); return; }
  if (values.auto && (values.provider || values.model || values["approve-once"])) throw new NidusError('invalid_request', 'Automatic chat cannot specify a manual model.');
  if (values.difficulty && !values.auto) throw new NidusError('invalid_request', 'Difficulty requires --auto.');
  const provider = values.auto ? 'openai' : providerId(command === "chat" ? values.provider ?? "" : argument ?? "");
  const controller = new AbortController(); const cancel = () => controller.abort();
  // Secret prompt manages raw-mode Ctrl-C itself; register HTTP cancellation afterward.
  let inputKey: string | undefined;
  if (command === "connect") {
    if (!values.env && process.env[credentialEnvironment[provider]]) throw new NidusError("invalid_request", "A session credential is active. Use connect --env, or unset it before changing the Keychain credential.");
    inputKey = values.env ? process.env[credentialEnvironment[provider]] : await (dependencies.readSecret ?? secretPrompt)();
  }
  const options = { signal: controller.signal, timeoutMs: values["timeout-ms"] === undefined ? (command === "chat" ? 120_000 : 30_000) : Number(values["timeout-ms"]) };
  process.once("SIGINT", cancel);
  try {
    switch (command) {
      case "connect": print(await engine.connect(provider, inputKey ?? "", !values.env, options, values["account-id"] ?? (provider === "cloudflare" ? process.env.NIDUS_CLOUDFLARE_ACCOUNT_ID : undefined), values['billing-type'] ? {state:values['billing-type'],paidAllowed:values['allow-paid']===true,confirmed:values['confirm-billing']===true,riskAccepted:values['accept-charge-risk']===true} : undefined)); break;
      case "models":
        if (values.detail && values.refresh) throw new NidusError("invalid_request", "Use --detail or --refresh, not both.");
        print(values.detail ? await engine.detail(provider, values.detail, options) : await engine.models(provider, values.refresh || !!process.env[credentialEnvironment[provider]], options)); break;
      case "pricing": print(await engine.pricing(provider)); break;
      case "chat": {
        if (!values.auto && !values.model) throw new NidusError("invalid_request", "--model is required; use models to discover IDs.");
        const text = await (dependencies.readPrompt ?? chatPrompt)();
        const request = { model: values.model ?? 'automatic', messages: [{ role: 'user' as const, content: text }], maxOutputTokens: values['max-output-tokens'] === undefined ? undefined : Number(values['max-output-tokens']) };
        const consent=values['approve-once'] ? await engine.issueConsent(provider,request.model,'chat',true) : undefined;
        print(values.auto ? await engine.autoChat(request, values.difficulty, options) : await engine.chat(provider, request, {...options,consentToken:consent?.token})); break;
      }
      case "disconnect":
        if (process.env[credentialEnvironment[provider]]) throw new NidusError("invalid_request", "Unset the session environment credential before disconnecting the stored credential.");
        print(await engine.disconnect(provider)); break;
    }
  } finally { inputKey = undefined; process.removeListener("SIGINT", cancel); }
}
export function report(error: unknown): void {
  const safe = publicError(error);
  process.stderr.write(`${JSON.stringify({ error: safe.toJSON() })}\n`);
  process.exitCode = safe.code === "cancelled" ? 130 : 1;
}
