#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const claude = process.argv.includes("--double-claude");
const log = process.argv.find(arg => arg.startsWith("--double-log="))?.slice("--double-log=".length);
if (process.argv.includes("--version")) {
  process.stdout.write(claude ? "2.1.212 (Claude Code)\n" : "codex-cli 0.144.1\n");
  process.exit(0);
}
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnNumber = 0;
let selectedModel = "model-first";
const turns = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (log) appendFileSync(log, `${line}\n`);
  if (claude) {
    if (request.type === "user") {
      const sessionId = process.argv[process.argv.indexOf("--session-id") + 1] ?? "candidate-session";
      send({ type: "system", subtype: "init", session_id: sessionId, model: selectedModel, permissionMode: "plan", tools: [], mcp_servers: [], capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"] });
      send({ type: "assistant", message: { id: `message-${++turnNumber}`, model: selectedModel, content: [{ type: "text", text: "native fixture answer" }] } });
      send({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, result: "native fixture answer", usage: { input_tokens: 10, output_tokens: 3 } });
      return;
    }
    if (request.type !== "control_request") return;
    if (request.request.subtype === "set_model") selectedModel = request.request.model;
    const response = request.request.subtype === "initialize" ? {
      account: { tokenSource: "oauth" },
      models: ["model-first", "model-chosen", "default", "sonnet", "haiku", "opus[1m]"].map(value => ({ value, resolvedModel: value, displayName: value })),
      commands: [],
    } : request.request.subtype === "get_context_usage" ? { totalTokens: 10, maxTokens: 100000 } : {};
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
    case "thread/start": selectedModel = request.params.model ?? "model-first"; result = { thread: { id: "candidate-thread" }, model: selectedModel }; break;
    case "thread/read": result = { thread: { id: "candidate-thread", turns } }; break;
    case "turn/start": {
      const id = `turn-${++turnNumber}`;
      turns.push({ id, status: "completed", items: [{ type: "userMessage", id: `user-${id}`, content: request.params.input }, { type: "agentMessage", id: `agent-${id}`, text: "native fixture answer" }] });
      send({ id: request.id, result: { turn: { id } } });
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId: "candidate-thread", turnId: id, itemId: `agent-${id}`, delta: "native fixture answer" } });
        send({ method: "turn/completed", params: { threadId: "candidate-thread", turn: { id, status: "completed" } } });
      }, 10);
      return;
    }
    case "account/rateLimits/read": result = { rateLimits: null }; break;
  }
  send({ id: request.id, result });
});
lines.on("close", () => process.exit(0));
