import readline from "node:readline";
import { appendFileSync } from "node:fs";

const claude = process.argv.includes("--double-claude");
const log = process.argv.find(arg => arg.startsWith("--double-log="))?.slice("--double-log=".length);
if (process.argv.includes("--version")) {
  process.stdout.write(claude ? "2.1.212 (Claude Code)\n" : "codex-cli 0.144.1\n");
  process.exit(0);
}
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (log) appendFileSync(log, `${line}\n`);
  if (claude) {
    if (request.type !== "control_request") return;
    const response = request.request.subtype === "initialize" ? {
      account: { tokenSource: "oauth" },
      models: ["model-first", "model-chosen"].map(value => ({ value, resolvedModel: value, displayName: value })),
      commands: [],
    } : {};
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
    return;
  }
  if (request.id === undefined) return;
  let result = {};
  switch (request.method) {
    case "account/read": result = { account: { id: "test-account" }, requiresOpenaiAuth: false }; break;
    case "model/list": result = { data: ["model-first", "model-chosen"].map(model => ({
      id: model, model, displayName: model, isDefault: model === "model-first",
      supportedReasoningEfforts: [], defaultReasoningEffort: "medium",
    })), nextCursor: null }; break;
    case "thread/start": result = { thread: { id: "candidate-thread" }, model: request.params.model ?? "model-first" }; break;
    case "account/rateLimits/read": result = { rateLimits: null }; break;
  }
  send({ id: request.id, result });
});
lines.on("close", () => process.exit(0));
