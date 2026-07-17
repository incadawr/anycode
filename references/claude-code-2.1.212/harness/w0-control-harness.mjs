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
//
// Env hygiene: strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT/ANTHROPIC_API_KEY/
// ANTHROPIC_AUTH_TOKEN from the child's env (nested-spawn hygiene per lane brief).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";

const [, , scenario, outFixture, claudeBinArg] = process.argv;
if (!scenario || !outFixture) {
  console.error("usage: w0-control-harness.mjs <scenario> <out.jsonl> [claude-bin]");
  process.exit(2);
}
const CLAUDE_BIN = claudeBinArg || process.env.CLAUDE_BIN || "/Users/incadawr/.local/bin/claude";

const env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
  delete env[k];
}

const baseArgs = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
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
function scrub(node) {
  if (Array.isArray(node)) return node.map(scrub);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "email" || k === "organization") { out[k] = "[REDACTED]"; continue; }
      out[k] = scrub(v);
    }
    return out;
  }
  return node;
}

function rec(dir, raw, extra) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw only */ }
  lines.push({ t_ms: Date.now() - t0, dir, ...(extra || {}), raw: parsed ? scrub(parsed) : raw });
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
    function handle(msg) {
      if (msg.type === "control_response") {
        if (msg.response?.request_id === initRequestId) {
          rec("meta", JSON.stringify({ event: "init_handshake_ack", subtype: msg.response?.subtype }));
          if (name === "authprobe") { finish("authprobe_zero_cost_no_turn_sent"); return; }
          if (msg.response?.subtype === "success") afterInit();
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
