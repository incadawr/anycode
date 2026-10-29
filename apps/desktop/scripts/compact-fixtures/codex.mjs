#!/usr/bin/env node
// Deterministic synthetic native server for GitHub #24; no provider access.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const home = process.env.HOME;
const unsupported = () => existsSync(join(home, "codex-compact-mode")) && readFileSync(join(home, "codex-compact-mode"), "utf8").trim() === "unsupported";
if (process.argv.includes("--version")) { console.log("codex-cli 0.144.3"); process.exit(0); }
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => send({ method, params: { threadId: "fixture-thread", ...params } });
const turns = [];
let active = null;
let compactSequence = 0;
let turnSequence = 0;
let timer;
const usage = (turnId, tokens) => notify("thread/tokenUsage/updated", { turnId, tokenUsage: { last: { totalTokens: tokens }, total: { inputTokens: 47000, outputTokens: 1000, totalTokens: 48000 }, modelContextWindow: 100000 } });
const complete = (status = "completed") => {
  if (!active) return;
  clearInterval(timer);
  const turn = active;
  active = null;
  if (status === "completed") {
    const item = turn.compact ? { type: "contextCompaction", id: `${turn.id}-item` } : { type: "agentMessage", id: `${turn.id}-message`, text: "Fixture ready." };
    turn.items.push(item);
    notify("item/completed", { turnId: turn.id, item });
    usage(turn.id, turn.compact ? 8000 : 47000);
  }
  turn.status = status;
  notify("turn/completed", { turn: { id: turn.id, status, items: turn.items } });
};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => { clearInterval(timer); });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  appendFileSync(join(home, "codex-rpcs.jsonl"), `${JSON.stringify(request)}\n`);
  const respond = (result) => send({ id: request.id, result });
  const reject = (code, message) => send({ id: request.id, error: { code, message } });
  switch (request.method) {
    case "initialize": respond({ userAgent: "fixture/0.144.3", codexHome: home, platformFamily: "unix", platformOs: "macos" }); break;
    case "account/read": respond({ account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }, requiresOpenaiAuth: true }); break;
    case "model/list": respond({ data: [{ id: "gpt-fake-1", model: "gpt-fake-1", displayName: "Fixture", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }); break;
    case "thread/start": case "thread/resume": respond({ thread: { id: "fixture-thread" }, model: "gpt-fake-1", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }, reasoningEffort: "high" }); break;
    case "thread/read": respond({ thread: { id: "fixture-thread", turns: turns.map(({ id, status, items }) => ({ id, status, items })) } }); break;
    case "turn/start": {
      if (active) { reject(-32600, "busy"); break; }
      appendFileSync(join(home, "codex-turns.jsonl"), `${JSON.stringify(request.params)}\n`);
      active = { id: `fixture-turn-${++turnSequence}`, status: "inProgress", items: [], compact: false };
      turns.push(active);
      respond({ turn: { id: active.id, status: active.status } });
      notify("turn/started", { turn: { id: active.id, status: active.status } });
      if (request.params.input.some(v => v.text?.includes("fixture: hold"))) timer = setInterval(() => { if (existsSync(join(home, "release-codex"))) complete(); }, 20);
      else setTimeout(() => complete(), 30);
      break;
    }
    case "thread/compact/start": {
      if (unsupported()) { reject(-32601, "unsupported"); break; }
      if (active) { reject(-32600, "busy"); break; }
      const seq = ++compactSequence;
      active = { id: `fixture-compact-${seq}`, status: "inProgress", items: [], compact: true };
      turns.push(active);
      respond({});
      notify("turn/started", { turn: { id: active.id, status: active.status } });
      notify("item/started", { turnId: active.id, item: { type: "contextCompaction", id: `${active.id}-item` } });
      timer = setInterval(() => { if (existsSync(join(home, `release-codex-compact-${seq}`))) complete(); }, 20);
      break;
    }
    case "turn/interrupt":
      if (!active || active.id !== request.params.turnId) { reject(-32600, "no active turn"); break; }
      respond({}); complete("interrupted"); break;
    case "account/rateLimits/read": respond({ rateLimits: null }); break;
    case "windowsSandbox/readiness": respond({ status: "ready" }); break;
    default: reject(-32601, "Unknown fixture request");
  }
});
