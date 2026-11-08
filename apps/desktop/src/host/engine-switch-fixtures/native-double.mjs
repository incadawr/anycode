#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const orchestration = process.argv.includes("--double-orchestration");
const claude = process.argv.includes("--double-claude");
const log = process.argv.find(arg => arg.startsWith("--double-log="))?.slice("--double-log=".length);
if (process.argv.includes("--version")) {
  process.stdout.write(claude ? "2.1.212 (Claude Code)\n" : (orchestration ? "codex-cli 0.166.0\n" : "codex-cli 0.144.1\n"));
  process.exit(0);
}
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnNumber = 0;
let selectedModel = "model-first";
let turns = [];
let threadId = "candidate-thread";
const statePath = log ? `${log}.state.json` : undefined;
const saved = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath,"utf8")) : {};
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
let permissionMode = arg("--permission-mode") ?? "plan";
selectedModel = arg("--model") ?? (claude ? "default" : "model-first");
const claudeRef = arg("--resume") ?? arg("--session-id") ?? "candidate-session";
if (claude && saved[claudeRef]) { turnNumber = saved[claudeRef].turnNumber; selectedModel = saved[claudeRef].model; }
const save = (ref, value) => { if (statePath) { saved[ref] = value; writeFileSync(statePath,JSON.stringify(saved)); } };
if (log) appendFileSync(log,`${JSON.stringify({fixtureBoot:{args:process.argv.slice(2)}})}\n`);
// Opt-in scripted mode (session-peer smoke only): active only while the script file exists.
// The script never reaches main or the broker; it only decides what THIS double does for a
// turn it really received: call a bridge tool, answer with a marker, or stay busy until released.
const scriptFile = log?.replace(/\.jsonl$/, "-script.json");
const readScript = () => { try { return scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, "utf8")) : null; } catch { return null; } };
const bridgeToolName = canonical => `anycode_${canonical.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`;
const textOf = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(textOf).join("\n") : typeof value?.text === "string" ? value.text : typeof value?.content === "string" || Array.isArray(value?.content) ? textOf(value.content) : "";
const plan = text => {
  const script = readScript();
  const out = {};
  if (!script) return out;
  const command = script.peerCommands ? text.match(/^peer-command:(.*)$/m) : null;
  if (command) { const parsed = JSON.parse(command[1]); out.command = { tool: bridgeToolName(parsed.tool), arguments: parsed.input }; }
  const reply = script.reply;
  if (reply && text.includes(reply.trigger)) {
    if (reply.kind === "explicit") {
      const header = text.match(/\[AnyCode authenticated agent message (.+)\]$/m);
      if (header) out.command = { tool: bridgeToolName("SessionSend"), arguments: { replyTo: JSON.parse(header[1]).messageId, payload: reply.nonce } };
    } else out.answer = reply.nonce;
  }
  if (script.hold && text.includes(script.hold.trigger)) out.holdFile = script.hold.releaseFile;
  return out;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = async file => { while (file && !existsSync(file)) await sleep(50); };
const serverWaiters = new Map();
let serverRequestNumber = 9000;
const serverRequest = (method, params) => new Promise(resolve => { const id = ++serverRequestNumber; serverWaiters.set(id, resolve); send({ id, method, params }); });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (log) appendFileSync(log, `${line}\n`);
  if (claude) {
    if (request.type === "user") {
      const sessionId = claudeRef;
      const scripted = plan(textOf(request.message));
      const answer = scripted.answer ?? "native fixture answer";
      save(sessionId,{turnNumber:turnNumber+1,model:selectedModel});
      send({ type: "system", subtype: "init", session_id: sessionId, model: selectedModel, permissionMode, tools: [], mcp_servers: [], capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"] });
      const finishClaude = () => {
        send({ type: "assistant", message: { id: `message-${++turnNumber}`, model: selectedModel, content: [{ type: "text", text: answer }] } });
        send({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, result: answer, usage: { input_tokens: 10, output_tokens: 3 } });
      };
      if (scripted.holdFile) void release(scripted.holdFile).then(finishClaude); else finishClaude();
      return;
    }
    if (request.type !== "control_request") return;
    if (request.request.subtype === "set_model") selectedModel = request.request.model;
    if (request.request.subtype === "set_permission_mode") permissionMode = request.request.mode;
    const response = request.request.subtype === "initialize" ? {
      account: { tokenSource: "oauth" },
      models: ["model-first", "model-chosen", "default", "sonnet", "haiku", "opus[1m]"].map(value => ({ value, resolvedModel: value, displayName: value, ...(orchestration && value !== "haiku" ? { supportsEffort:true,supportedEffortLevels:["low","high"] } : {}) })),
      commands: [],
    } : request.request.subtype === "get_context_usage" ? { totalTokens: 10, maxTokens: 100000 } : {};
    send({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
    return;
  }
  if (request.id === undefined) return;
  if (request.method === undefined && serverWaiters.has(request.id)) { serverWaiters.get(request.id)(request); serverWaiters.delete(request.id); return; }
  let result = {};
  switch (request.method) {
    case "config/read": {
      const overlay = process.argv.includes('features.multi_agent=false');
      result = {config:{mcp_servers:{},features:{multi_agent:!overlay,remote_plugin:!overlay},apps:overlay ? {_default:{enabled:false}} : {},sandbox_mode:overlay ? "read-only" : "workspace-write",approval_policy:overlay ? "never" : "on-request"},layers:[]};
      break;
    }
    case "account/read": result = { account: { id: "test-account" }, requiresOpenaiAuth: false }; break;
    case "model/list": result = { data: ["model-first", "model-chosen"].map(model => ({
      id: model, model, displayName: model, isDefault: model === "model-first",
      supportedReasoningEfforts: orchestration && model === "model-first" ? [{reasoningEffort:"low"},{reasoningEffort:"high"}] : [], defaultReasoningEffort: "low",
      inputModalities: model === "model-first" ? ["text","image"] : ["text"],
      ...(orchestration && model === "model-first" ? {serviceTiers:[{id:"priority"}]} : {}),
    })), nextCursor: null }; break;
    case "thread/start": selectedModel = request.params.model ?? "model-first"; threadId = randomUUID(); turns = []; turnNumber = 0; result = { thread: { id: threadId }, model: selectedModel, approvalPolicy:request.params.approvalPolicy,sandbox:{type:"readOnly",networkAccess:false} }; break;
    case "thread/resume": {
      const stored = saved[request.params.threadId];
      if (!stored) { send({id:request.id,error:{code:-32000,message:"no rollout found"}}); return; }
      threadId = request.params.threadId; turns = stored.turns; turnNumber = stored.turnNumber; selectedModel = request.params.model ?? stored.model;
      result = {thread:{id:threadId},model:selectedModel,approvalPolicy:request.params.approvalPolicy,sandbox:{type:"readOnly",networkAccess:false}}; break;
    }
    case "thread/read": result = { thread: { id: threadId, turns } }; break;
    case "turn/start": {
      selectedModel = request.params.model ?? selectedModel;
      const id = `turn-${++turnNumber}`;
      const scripted = plan(textOf(request.params.input));
      const answer = scripted.answer ?? "native fixture answer";
      turns.push({ id, status: "completed", items: [{ type: "userMessage", id: `user-${id}`, content: request.params.input }, { type: "agentMessage", id: `agent-${id}`, text: answer }] });
      save(threadId,{turns,turnNumber,model:selectedModel});
      send({ id: request.id, result: { turn: { id } } });
      const finishTurn = () => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId: id, itemId: `agent-${id}`, delta: answer } });
        send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
      };
      if (!scripted.command && !scripted.holdFile) { setTimeout(finishTurn, 10); return; }
      void (async () => {
        await sleep(10);
        if (scripted.command) {
          const callId = `double-call-${randomUUID()}`;
          const response = await serverRequest("item/tool/call", { threadId, turnId: id, callId, tool: scripted.command.tool, arguments: scripted.command.arguments });
          if (log) appendFileSync(log, `${JSON.stringify({ doubleToolResponse: { callId, tool: scripted.command.tool, result: response.result ?? null, error: response.error ?? null } })}\n`);
        }
        await release(scripted.holdFile);
        finishTurn();
      })();
      return;
    }
    case "account/rateLimits/read": result = { rateLimits: null }; break;
  }
  send({ id: request.id, result });
});
lines.on("close", () => process.exit(0));
