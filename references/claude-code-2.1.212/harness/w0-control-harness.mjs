#!/usr/bin/env node
// CC-W0 recon harness (NOT product code). Speaks the raw NDJSON + control-protocol
// wire to a real `claude -p` child, using the exact request/response shapes read
// from @anthropic-ai/claude-agent-sdk@0.3.212's sdk.d.ts (installed to a throwaway
// /tmp dir for recon only, never shipped). Logs every stdin/stdout line with a
// direction tag and a receipt timestamp so buffering/timing can be inspected.
//
// Usage:
//   node w0-control-harness.mjs <scenario> <out-fixture.jsonl> [claude-bin]
//
// Scenarios: baseline | interrupt-early | interrupt-pending | permmodes | resume-emit
//            | authprobe | usage-probe | setmodel-probe
//
// usage-probe / setmodel-probe / authprobe are HANDSHAKE-ONLY: they drive the
// control channel and finish without ever sending a `user` message, so they
// bill $0 (no `type:"result"` is ever produced — its presence in a fixture from
// these scenarios would mean the probe design leaked a live turn).
//
// Env hygiene: strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT/ANTHROPIC_API_KEY/
// ANTHROPIC_AUTH_TOKEN from the child's env (nested-spawn hygiene per lane brief).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";

const [, , scenario, outFixture, claudeBinArg] = process.argv;
if (!scenario || !outFixture) {
  console.error("usage: w0-control-harness.mjs <scenario> <out.jsonl> [claude-bin]");
  process.exit(2);
}
const CLAUDE_BIN = claudeBinArg || process.env.CLAUDE_BIN || "[HOME]/.local/bin/claude";

const env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
  delete env[k];
}

// W0_NO_REPLAY=1 drops --replay-user-messages, to test whether a wire artifact
// is genuinely emitted by the CLI or is only an echo of that flag.
const baseArgs = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  ...(process.env.W0_NO_REPLAY === "1" ? [] : ["--replay-user-messages"]),
  "--setting-sources", "project,local",
  "--strict-mcp-config",
  // Hidden flag (absent from --help in v2.1.212, confirmed present in the
  // @anthropic-ai/claude-agent-sdk@0.3.212 argv builder): without this, a
  // control-protocol `initialize` handshake alone does NOT route can_use_tool
  // over the control channel — headless -p mode just auto-denies with
  // "you haven't granted it yet" (observed live, see w0-02 NOTES).
  "--permission-prompt-tool", "stdio",
];

const lines = [];
const t0 = Date.now();

// Custody scrub: the control-protocol `initialize` response carries the
// logged-in account's email/org (SDKControlInitializeResponse.account) — this
// is NOT gated by --setting-sources and must never land in a public-repo
// fixture. Redact in place, recursively, at record time.
//
// Home-path redaction: get_context_usage.memoryFiles[].path (and other file
// paths in control payloads) carry the absolute home prefix. The structural
// fact — which files, how many tokens — is contract-relevant and kept; the
// operator's username is not. Applied to string values AND object keys, since
// some payloads key by path.
// Two encodings of the home path leak into control payloads:
//   1. literal            -> /Users/<user>/.claude/...
//   2. dash-encoded slug  -> ~/.claude/projects/-Users-<user>-projects-.../
// get_context_usage.memoryFiles[].path carries BOTH (an AutoMem file lives under
// the slug dir), so redacting only the literal form still ships the username.
const HOME = os.homedir();
const HOME_SLUG = HOME.replace(/\//g, "-");
function scrubPath(s) {
  let out = s;
  if (HOME && out.includes(HOME)) out = out.split(HOME).join("[HOME]");
  if (HOME_SLUG && out.includes(HOME_SLUG)) out = out.split(HOME_SLUG).join("[HOME-SLUG]");
  return out;
}
function scrub(node) {
  if (typeof node === "string") return scrubPath(node);
  if (Array.isArray(node)) return node.map(scrub);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const key = scrubPath(k);
      if (key === "email" || key === "organization") { out[key] = "[REDACTED]"; continue; }
      out[key] = scrub(v);
    }
    return out;
  }
  return node;
}

function rec(dir, raw, extra) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw only */ }
  lines.push({ t_ms: Date.now() - t0, dir, ...(extra || {}), raw: parsed ? scrub(parsed) : scrubPath(String(raw)) });
}
function flush() {
  fs.writeFileSync(outFixture, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function runScenario(name) {
  return new Promise((resolve) => {
    const extraArgs = name === "permmodes2"
      ? ["--permission-mode", "auto"]
      : name === "isolation-strict"
        ? ["--permission-mode", "default", "--disable-slash-commands"]
        : ["--permission-mode", "default"];
    const child = spawn(CLAUDE_BIN, [...baseArgs, ...extraArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      rec("meta", JSON.stringify({ event: "finish", reason }));
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 1500);
      resolve();
    };

    function send(obj) {
      const line = JSON.stringify(obj);
      rec("in", line);
      child.stdin.write(line + "\n");
    }

    // Handshake-only probe sequencing: label each control_request we originate so
    // its control_response can be matched back and drive the next step. Used by
    // the $0 scenarios (usage-probe / setmodel-probe) which never send a `user`
    // message and therefore never bill a model turn.
    const pendingControl = new Map();
    function sendControl(label, request) {
      const reqId = randomUUID();
      pendingControl.set(reqId, label);
      send({ type: "control_request", request_id: reqId, request });
      return reqId;
    }

    const rl = createInterface({ input: child.stdout });
    let turnCount = 0;
    let modeIdx = 0;
    const modeSequence = name === "permmodes2" ? ["auto", "plan"] : ["default", "bypassPermissions", "acceptEdits", "dontAsk", "auto", "plan"];
    const modePrompts = Object.fromEntries(modeSequence.map((m) => [
      m,
      `Use the Write tool to create a file at /tmp/w0-cc-permmode-${m}.txt containing exactly: OK`,
    ]));

    rl.on("line", (line) => {
      if (!line.trim()) return;
      rec("out", line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      handle(msg);
    });

    child.stderr.on("data", (d) => rec("stderr", JSON.stringify(d.toString())));
    child.on("close", (code, signal) => { rec("meta", JSON.stringify({ event: "close", code, signal })); finish("close"); });

    let initRequestId = null;
    let initPayload = null;
    function handle(msg) {
      if (msg.type === "control_response") {
        if (msg.response?.request_id === initRequestId) {
          initPayload = msg.response?.response || null;
          rec("meta", JSON.stringify({ event: "init_handshake_ack", subtype: msg.response?.subtype }));
          if (name === "authprobe") { finish("authprobe_zero_cost_no_turn_sent"); return; }
          if (msg.response?.subtype === "success") afterInit();
          return;
        }
        const label = pendingControl.get(msg.response?.request_id);
        if (label) {
          pendingControl.delete(msg.response.request_id);
          rec("meta", JSON.stringify({ event: "probe_response", label, subtype: msg.response?.subtype }));
          probeStep(label, msg.response?.response);
        }
        return; // our own requests' acks
      }
      if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
        if (name === "interrupt-pending" && !msg.__respondedOnce) {
          // Deliberately hold this can_use_tool pending; fire interrupt instead of allowing.
          rec("meta", JSON.stringify({ event: "can_use_tool_seen_holding_for_interrupt", request_id: msg.request_id }));
          send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
          // Answer it slightly later so we can see whether CLI still wants an answer post-interrupt.
          setTimeout(() => {
            send({
              type: "control_response",
              response: { subtype: "success", request_id: msg.request_id, response: { behavior: "allow", updatedInput: msg.request.input, toolUseID: msg.request.tool_use_id } },
            });
          }, 300);
          return;
        }
        send({
          type: "control_response",
          response: { subtype: "success", request_id: msg.request_id, response: { behavior: "allow", updatedInput: msg.request.input, toolUseID: msg.request.tool_use_id } },
        });
        return;
      }
      if (msg.type === "control_request") {
        // Unhandled subtype from CLI -> us (hook_callback/mcp_message/etc). Fail closed like the real client will.
        send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unhandled_by_w0_harness" } });
        return;
      }
      if (msg.type === "system" && msg.subtype === "init") {
        rec("meta", JSON.stringify({ event: "init_seen", session_id: msg.session_id, model: msg.model, permissionMode: msg.permissionMode, capabilities: msg.capabilities }));
        if (name === "isolation-strict") finish("init_seen_no_turn_needed");
        return;
      }
      if (msg.type === "result") {
        turnCount += 1;
        rec("meta", JSON.stringify({ event: "result_seen", turnCount, subtype: msg.subtype }));
        afterResult();
      }
    }

    function afterInit() {
      if (name === "isolation-strict") {
        send({ type: "user", message: { role: "user", content: "Reply with: OK" } });
      } else if (name === "baseline") {
        send({ type: "user", message: { role: "user", content: "Run the bash command: echo hello-from-w0" } });
      } else if (name === "writeprobe") {
        send({ type: "user", message: { role: "user", content: "Use the Write tool to create a file at /tmp/w0-cc-writeprobe.txt containing exactly: OK" } });
      } else if (name === "interrupt-early") {
        send({ type: "user", message: { role: "user", content: "Use the Write tool to create a file at /tmp/w0-cc-interrupt-early.txt containing exactly: OK" } });
        setTimeout(() => {
          rec("meta", JSON.stringify({ event: "sending_early_interrupt" }));
          send({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
        }, 25);
      } else if (name === "interrupt-pending") {
        send({ type: "user", message: { role: "user", content: "Use the Write tool to create a file at /tmp/w0-cc-interrupt-pending.txt containing exactly: OK" } });
      } else if (name === "permmodes" || name === "permmodes2") {
        send({ type: "user", message: { role: "user", content: modePrompts[modeSequence[modeIdx]] } });
      } else if (name === "resume-emit") {
        send({ type: "user", message: { role: "user", content: "Reply with exactly: RESUME-OK" } });
      } else if (name === "persistence") {
        send({ type: "user", message: { role: "user", content: "Reply with exactly: TURN-ONE-OK" } });
      } else if (name === "usage-probe") {
        sendControl("get_usage", { subtype: "get_usage" });
      } else if (name === "setmodel-probe") {
        rec("meta", JSON.stringify({
          event: "init_models_offered",
          models: (initPayload?.models || []).map((m) => ({ value: m.value, resolvedModel: m.resolvedModel })),
        }));
        sendControl("ctx_before", { subtype: "get_context_usage" });
      }
    }

    // Handshake-only step machines. Neither ever sends a `user` message, so no
    // model turn is billed; `get_context_usage.model` is used as the free
    // observable for whether a set_model actually took effect.
    let baselineModel = null;
    function probeStep(label, payload) {
      if (name === "usage-probe") {
        if (label === "get_usage") { sendControl("get_context_usage", { subtype: "get_context_usage" }); return; }
        if (label === "get_context_usage") { finish("usage_probe_done_no_turn_sent"); return; }
        return;
      }
      if (name !== "setmodel-probe") return;
      if (label === "ctx_before") {
        baselineModel = payload?.model ?? null;
        // Pick a model that differs from the session's current one, so a successful
        // set_model is discriminable from a silent no-op via get_context_usage.model.
        const offered = initPayload?.models || [];
        const target = (offered.find((m) => m.resolvedModel && m.resolvedModel !== baselineModel) || offered[0])?.value;
        rec("meta", JSON.stringify({ event: "setmodel_target_chosen", baselineModel, target }));
        sendControl("set_model_valid", { subtype: "set_model", model: target });
        return;
      }
      if (label === "set_model_valid") { sendControl("ctx_after_valid", { subtype: "get_context_usage" }); return; }
      if (label === "ctx_after_valid") {
        rec("meta", JSON.stringify({ event: "model_after_valid_setmodel", model: payload?.model ?? null, baselineModel }));
        sendControl("set_model_invalid", { subtype: "set_model", model: "no-such-model-xyz" });
        return;
      }
      if (label === "set_model_invalid") { sendControl("ctx_after_invalid", { subtype: "get_context_usage" }); return; }
      if (label === "ctx_after_invalid") {
        rec("meta", JSON.stringify({ event: "model_after_invalid_setmodel", model: payload?.model ?? null }));
        finish("setmodel_probe_done_no_turn_sent");
      }
    }

    function afterResult() {
      if (name === "permmodes" || name === "permmodes2") {
        modeIdx += 1;
        if (modeIdx >= modeSequence.length) { finish("permmodes_done"); return; }
        const nextMode = modeSequence[modeIdx];
        const reqId = randomUUID();
        send({ type: "control_request", request_id: reqId, request: { subtype: "set_permission_mode", mode: nextMode } });
        setTimeout(() => {
          send({ type: "user", message: { role: "user", content: modePrompts[nextMode] } });
        }, 200);
        return;
      }
      if (name === "persistence" && turnCount === 1) {
        rec("meta", JSON.stringify({ event: "sending_second_turn_same_process" }));
        send({ type: "user", message: { role: "user", content: "Reply with exactly: TURN-TWO-OK" } });
        return;
      }
      if (name === "persistence" && turnCount === 2) {
        rec("meta", JSON.stringify({ event: "closing_stdin_eof_now" }));
        child.stdin.end();
        return; // wait for natural process close event, not our finish() timer
      }
      // single-turn scenarios end after first result
      setTimeout(() => finish("result_done"), 200);
    }

    // Kick off handshake
    initRequestId = randomUUID();
    send({ type: "control_request", request_id: initRequestId, request: { subtype: "initialize" } });

    // Hard ceiling so a hung scenario doesn't block the whole probe run.
    const ceiling = setTimeout(() => finish("timeout_ceiling"), 45000);
    ceiling.unref();
  });
}

await runScenario(scenario);
flush();
console.error(`wrote ${lines.length} lines to ${outFixture}`);
