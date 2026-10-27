#!/usr/bin/env node
// Deterministic stream-json CLI for the compact UI smoke; never contacts a provider.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  console.log("2.1.212 (Claude Code)");
  process.exit(0);
}
const home = process.env.HOME;
if (!home) throw new Error("fixture requires an isolated HOME");
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const result = () => send({ type: "result", subtype: "success", is_error: false, result: "fixture complete", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0 });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    const body = frame.request?.subtype === "initialize"
      ? { account: { tokenSource: "oauth", subscriptionType: "Claude Max", apiProvider: "firstParty" }, models: [{ value: "default", resolvedModel: "default", displayName: "Default" }], commands: [] }
      : frame.request?.subtype === "get_context_usage" ? { totalTokens: 1000, maxTokens: 200000 } : {};
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: body } });
    return;
  }
  if (frame.type !== "user") return;
  const text = frame.message?.content;
  appendFileSync(join(home, "claude-frames.jsonl"), `${JSON.stringify(frame)}\n`);
  if (text === "/compact") { result(); return; }
  if (text === "fixture: hold") {
    const timer = setInterval(() => {
      if (existsSync(join(home, "release-claude"))) { clearInterval(timer); result(); }
    }, 50);
    timer.unref();
    return;
  }
  send({ type: "assistant", message: { id: "fixture-answer", model: "default", role: "assistant", content: [{ type: "text", text: "fixture ready" }] } });
  result();
});
