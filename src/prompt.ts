import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { NidusError } from "./errors.js";

export async function secretPrompt(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new NidusError("invalid_request", "connect requires an interactive terminal, or --env for an explicit session credential.");
  const input = process.stdin; const output = process.stderr;
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  output.write("API Key (hidden): ");
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: NidusError) => {
      input.removeListener("keypress", onKey); input.removeListener("end", onEnd);
      process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onTerm);
      input.setRawMode(wasRaw); input.pause(); output.write("\n");
      if (error) reject(error); else resolve(value);
      value = "";
    };
    const onEnd = () => finish(new NidusError("cancelled", "Key entry cancelled."));
    const onTerm = () => onEnd();
    const onKey = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) { onEnd(); return; }
      if (key.name === "return" || key.name === "enter") { finish(); return; }
      if (key.name === "backspace" || key.name === "delete") { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
      if (value.length > 16384) finish(new NidusError("invalid_request", "API key exceeds input limit."));
    };
    input.on("keypress", onKey); input.once("end", onEnd); process.once("SIGTERM", onTerm); process.once("SIGINT", onTerm);
  });
}
export async function chatPrompt(): Promise<string> {
  if (process.stdin.isTTY) {
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    try { return await reader.question("Message: "); } finally { reader.close(); }
  }
  let value = "";
  for await (const part of process.stdin) {
    value += part.toString();
    if (Buffer.byteLength(value) > 1024 * 1024) throw new NidusError("invalid_request", "Prompt exceeds 1 MiB.");
  }
  return value.trim();
}
