import { parseArgs } from "node:util";
import { providerId } from "./adapters/index.js";
import { credentialEnvironment, EnvironmentCredentials, KeychainStore } from "./credentials.js";
import { ConnectivityEngine } from "./engine.js";
import { NidusError, publicError } from "./errors.js";
import { FileModelStore } from "./storage.js";
import { secretPrompt, chatPrompt } from "./prompt.js";

export const help = `Nidus API Connectivity MVP
  nidus providers
  nidus connect <openai|anthropic|gemini|deepseek> [--env]
  nidus models <provider> [--refresh | --detail <model-id>]
  nidus pricing <provider>
  nidus chat --provider <provider> --model <model-id> [--max-output-tokens 1024]
  nidus usage
  nidus budget <total|request|provider> --usd <decimal USD>
  nidus balance <provider>
  nidus account <openai|anthropic>  # separate session ADMIN_API_KEY
  nidus disconnect <provider>

connect: hidden key entry, model discovery, macOS Keychain storage.
--env: explicit NIDUS_<PROVIDER>_API_KEY session credential; never writes the key.
Budget: set total and request before paid inference; provider limits are optional.
--approve-budget-exception: one explicit chat exception, recorded in the ledger;
unknown prices/unsafe bounds still block. Reservations use full input capacity.
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
      help: { type: "boolean", short: "h" }, refresh: { type: "boolean" }, env: { type: "boolean" },
      provider: { type: "string" }, model: { type: "string" }, detail: { type: "string" },
      "timeout-ms": { type: "string" }, "max-output-tokens": { type: "string" }, usd: { type: "string" }, "approve-budget-exception": { type: "boolean" }
    } }));
  } catch { throw new NidusError("invalid_request", "Invalid arguments. Use nidus --help. API keys must never be command-line arguments."); }
  if (values.help || positionals.length === 0) { write(help); return; }
  const [command, argument] = positionals;
  const commands = ["providers", "connect", "models", "pricing", "chat", "disconnect", "usage", "budget", "balance", "account"];
  if (!commands.includes(command!)) throw new NidusError("invalid_request", "Unknown command. Use nidus --help.");
  const expected = ["providers", "chat", "usage"].includes(command!) ? 1 : 2;
  if (positionals.length !== expected) throw new NidusError("invalid_request", "Unexpected positional arguments. Use nidus --help.");
  const allowed: Record<string, string[]> = {
    usage: [], budget: ["usd"], balance: [], account: [], providers: [], connect: ["env", "timeout-ms"], models: ["refresh", "detail", "timeout-ms"],
    pricing: [], chat: ["provider", "model", "max-output-tokens", "timeout-ms", "approve-budget-exception"], disconnect: []
  };
  if (Object.keys(values).some(v => !allowed[command!]!.includes(v))) throw new NidusError("invalid_request", "Option is not valid for this command.");
  const persistent = new KeychainStore();
  const engine = dependencies.engine ?? new ConnectivityEngine(new EnvironmentCredentials(persistent), new FileModelStore());
  if (command === "usage") { print(engine.usage()); return; }
  if (command === "budget") { print(engine.setBudget(argument, values.usd)); return; }
  if (command === "account") { print(await engine.syncAccount(providerId(argument ?? ""))); return; }
  if (command === "balance") { print(await engine.syncBalance(providerId(argument ?? ""))); return; }
  if (command === "providers") { print(engine.providers()); return; }
  const provider = providerId(command === "chat" ? values.provider ?? "" : argument ?? "");
  const controller = new AbortController(); const cancel = () => controller.abort();
  // Secret prompt manages raw-mode Ctrl-C itself; register HTTP cancellation afterward.
  let inputKey: string | undefined;
  if (command === "connect") {
    if (!values.env && process.env[credentialEnvironment[provider]]) throw new NidusError("invalid_request", "A session credential is active. Use connect --env, or unset it before changing the Keychain credential.");
    inputKey = values.env ? process.env[credentialEnvironment[provider]] : await (dependencies.readSecret ?? secretPrompt)();
  }
  const options = { budgetException: values["approve-budget-exception"] === true, signal: controller.signal, timeoutMs: values["timeout-ms"] === undefined ? (command === "chat" ? 120_000 : 30_000) : Number(values["timeout-ms"]) };
  process.once("SIGINT", cancel);
  try {
    switch (command) {
      case "connect": print(await engine.connect(provider, inputKey ?? "", !values.env, options)); break;
      case "models":
        if (values.detail && values.refresh) throw new NidusError("invalid_request", "Use --detail or --refresh, not both.");
        print(values.detail ? await engine.detail(provider, values.detail, options) : await engine.models(provider, values.refresh || !!process.env[credentialEnvironment[provider]], options)); break;
      case "pricing": print(await engine.pricing(provider)); break;
      case "chat": {
        if (!values.model) throw new NidusError("invalid_request", "--model is required; use models to discover IDs.");
        const text = await (dependencies.readPrompt ?? chatPrompt)();
        print(await engine.chat(provider, { model: values.model, messages: [{ role: "user", content: text }], maxOutputTokens: values["max-output-tokens"] === undefined ? undefined : Number(values["max-output-tokens"]) }, options)); break;
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
