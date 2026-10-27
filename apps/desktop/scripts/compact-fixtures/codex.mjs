#!/usr/bin/env node
// Minimal app-server for the unsupported compact UI smoke; no provider access.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("codex-cli 0.144.3"); process.exit(0); }
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  switch (request.method) {
    case "initialize": result = { userAgent: "fixture/0.144.3", codexHome: process.env.HOME, platformFamily: "unix", platformOs: "macos" }; break;
    case "account/read": result = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }, requiresOpenaiAuth: true }; break;
    case "model/list": result = { data: [{ id: "gpt-fake-1", model: "gpt-fake-1", displayName: "Fixture", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }; break;
    case "thread/start": result = { thread: { id: "fixture-thread" }, model: "gpt-fake-1", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }, reasoningEffort: "high" }; break;
    case "turn/start":
      appendFileSync(join(process.env.HOME, "codex-turns.jsonl"), `${JSON.stringify(request.params)}\n`);
      result = { turn: { id: "fixture-turn", status: "inProgress" } };
      break;
    case "account/rateLimits/read": result = { rateLimits: null }; break;
  }
  send({ id: request.id, result });
});
