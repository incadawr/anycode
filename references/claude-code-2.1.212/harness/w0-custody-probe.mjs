#!/usr/bin/env node
// CC-W0-R1 custody probe (NOT product code). Answers: does CLAUDE_CONFIG_DIR
// isolation close the custody gap where the owner's global ~/.claude/CLAUDE.md
// and AutoMem MEMORY.md leak into a headless `claude -p` session context even
// under `--setting-sources project,local`?
//
// Speaks the raw NDJSON + control-protocol wire, same shapes as
// w0-control-harness.mjs (request/response shapes read from
// @anthropic-ai/claude-agent-sdk@0.3.212's sdk.d.ts). Kept as a separate file
// per lane brief (w0-control-harness.mjs is owned by a parallel lane).
//
// Method ladder per arm:
//   1. control_request{subtype:"get_context_usage"} right after the
//      initialize handshake ack -- structural, $0, num_turns:0 (no user turn
//      is ever sent).
//   2. If that yields no usable memoryFiles signal, fall back to sending the
//      user message "/context" verbatim -- local slash command, also $0,
//      num_turns:0 (confirmed shape: fixtures/w0-10-slashcmd.jsonl).
//
// Usage:
//   node w0-custody-probe.mjs <arm> <out-fixture.jsonl> [claude-bin]
//   arm in {A-default, B-isolated, C-project}
//
// CLAUDE_CONFIG_DIR handling:
//   A-default  -> CLAUDE_CONFIG_DIR left UNSET (whatever the invoking shell has).
//   B-isolated -> CLAUDE_CONFIG_DIR must be pre-set by the CALLER to a fresh
//                 mktemp -d before invoking this script (so the same empty dir
//                 can be inspected afterward if needed).
//   C-project  -> same as B (isolated CLAUDE_CONFIG_DIR), cwd is the repo
//                 worktree root so project-level AGENTS.md is in scope; this
//                 script does not change cwd itself, run it from the worktree.
//
// Env hygiene: strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT/ANTHROPIC_API_KEY/
// ANTHROPIC_AUTH_TOKEN from the child's env (nested-spawn hygiene per lane brief).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";

const [, , arm, outFixture, claudeBinArg] = process.argv;
if (!arm || !outFixture) {
  console.error("usage: w0-custody-probe.mjs <arm> <out.jsonl> [claude-bin]");
  process.exit(2);
}
const CLAUDE_BIN = claudeBinArg || process.env.CLAUDE_BIN || "/Users/incadawr/.local/share/claude/versions/2.1.212";

const env = { ...process.env };
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
  delete env[k];
}

const baseArgs = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--replay-user-messages",
  "--setting-sources", "project,local",
  "--strict-mcp-config",
  // Hidden but required flag for control-protocol can_use_tool routing over
  // stdio in headless -p mode (see w0-control-harness.mjs comment).
  "--permission-prompt-tool", "stdio",
  "--permission-mode", "default",
];

const lines = [];
const t0 = Date.now();
const HOME = os.homedir();

// Custody scrub: redact email/organization (control-protocol initialize
// response) recursively, plus collapse the real $HOME prefix to [HOME] so the
// fixture is safe for a public repo while keeping the structural facts
// (which paths, which levels, how many tokens) intact.
function scrub(node) {
  if (typeof node === "string") return node.split(HOME).join("[HOME]");
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
  lines.push({ t_ms: Date.now() - t0, dir, ...(extra || {}), raw: parsed ? scrub(parsed) : scrub(raw) });
}
function flush() {
  fs.writeFileSync(outFixture, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function runArm() {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, baseArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stderr.on("data", (d) => rec("stderr", JSON.stringify(d.toString())));
    child.on("close", (code, signal) => { rec("meta", JSON.stringify({ event: "close", code, signal })); finish("close"); });

    let initRequestId = null;
    let usageRequestId = null;
    let usageAttempted = false;
    let usageSucceeded = false;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      rec("out", line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      handle(msg);
    });

    function handle(msg) {
      if (msg.type === "control_response") {
        if (msg.response?.request_id === initRequestId) {
          rec("meta", JSON.stringify({ event: "init_handshake_ack", subtype: msg.response?.subtype }));
          if (msg.response?.subtype === "success") {
            // FORCE_SLASH=1 skips Method 1 entirely -- used for a supplementary
            // cross-check of Method 2 against a Method-1 result on the same arm.
            if (process.env.FORCE_SLASH === "1") sendContextSlashCommand();
            else sendGetContextUsage();
          }
          return;
        }
        if (msg.response?.request_id === usageRequestId) {
          usageAttempted = true;
          rec("meta", JSON.stringify({ event: "get_context_usage_ack", subtype: msg.response?.subtype }));
          if (msg.response?.subtype === "success") {
            usageSucceeded = true;
            finish("get_context_usage_success_no_turn_sent");
          } else {
            // Method 1 gave an error/unsupported response -> fall back to Method 2 (/context).
            sendContextSlashCommand();
          }
          return;
        }
        return;
      }
      if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
        send({
          type: "control_response",
          response: { subtype: "success", request_id: msg.request_id, response: { behavior: "allow", updatedInput: msg.request.input, toolUseID: msg.request.tool_use_id } },
        });
        return;
      }
      if (msg.type === "control_request") {
        send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unhandled_by_custody_probe" } });
        return;
      }
      if (msg.type === "system" && msg.subtype === "init") {
        rec("meta", JSON.stringify({ event: "init_seen", session_id: msg.session_id, memory_paths: msg.memory_paths }));
        return;
      }
      if (msg.type === "result") {
        rec("meta", JSON.stringify({ event: "result_seen", subtype: msg.subtype, num_turns: msg.num_turns, total_cost_usd: msg.total_cost_usd }));
        setTimeout(() => finish("result_done"), 200);
        return;
      }
    }

    function sendGetContextUsage() {
      usageRequestId = randomUUID();
      send({ type: "control_request", request_id: usageRequestId, request: { subtype: "get_context_usage" } });
      // Belt-and-suspenders: if the CLI never answers (older wire, hang), fall
      // back to Method 2 rather than block the whole probe run.
      setTimeout(() => {
        if (!usageAttempted) {
          rec("meta", JSON.stringify({ event: "get_context_usage_timeout_fallback_to_slashcmd" }));
          sendContextSlashCommand();
        }
      }, 5000);
    }

    let slashSent = false;
    function sendContextSlashCommand() {
      if (slashSent || usageSucceeded) return;
      slashSent = true;
      send({ type: "user", message: { role: "user", content: "/context" } });
    }

    // Kick off handshake
    initRequestId = randomUUID();
    send({ type: "control_request", request_id: initRequestId, request: { subtype: "initialize" } });

    // Hard ceiling so a hung arm doesn't block the whole probe run.
    const ceiling = setTimeout(() => finish("timeout_ceiling"), 45000);
    ceiling.unref();
  });
}

await runArm();
flush();
console.error(`wrote ${lines.length} lines to ${outFixture}`);
