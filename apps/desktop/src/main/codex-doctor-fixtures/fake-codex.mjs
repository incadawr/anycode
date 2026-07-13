#!/usr/bin/env node
/**
 * Test-only double for the `codex` CLI, driven by main/codex-doctor.test.ts
 * and main/codex-login.test.ts. Never shipped, never invoked by product code
 * — argv flags select a scripted behavior, including deliberately
 * adversarial ones (`--stubborn`: ignores stdin AND SIGTERM, and forks a
 * grandchild that does the same) used to prove `CodexRpcClient.close()`
 * reaps the WHOLE process group, not just its direct child.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

if (args[0] === "--version") {
  if (flag("--hang-version")) {
    // Never exits on its own — the doctor's version-preflight timeout must
    // SIGKILL it directly (no process group involved at this stage).
    setInterval(() => {}, 1_000);
  } else if (flag("--bad-version")) {
    process.stdout.write("codex-cli 0.99.0\n");
    process.exit(0);
  } else if (flag("--malformed-version")) {
    process.stdout.write("not-a-version\n");
    process.exit(0);
  } else {
    process.stdout.write("codex-cli 0.144.3\n");
    process.exit(0);
  }
} else if (args[0] === "app-server") {
  if (flag("--stubborn")) {
    // Ignore SIGTERM on purpose — only a process-GROUP SIGKILL ends this.
    process.on("SIGTERM", () => {});
    const grandchild = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],
      { stdio: "ignore" },
    );
    const pidFile = value("--pid-file");
    if (pidFile && grandchild.pid !== undefined) {
      writeFileSync(pidFile, String(grandchild.pid));
    }
    // Never reads/responds to stdin — every request the doctor sends hangs
    // until its own per-RPC timeout or the overall watchdog fires.
  } else {
    const signedOut = flag("--signed-out");
    const manyPages = flag("--many-pages");
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (request.method === "initialize") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "fake-codex/0.144.3", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" } })}\n`);
      } else if (request.method === "initialized") {
        // notification — no response.
      } else if (request.method === "account/read") {
        const account = signedOut ? null : { type: "chatgpt", email: "redacted@example.com", planType: "plus" };
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { account, requiresOpenaiAuth: true } })}\n`);
      } else if (request.method === "model/list") {
        const cursor = request.params && request.params.cursor;
        if (manyPages) {
          // Always hands back another cursor — proves the doctor's page cap
          // (CODEX_MODEL_LIST_MAX_PAGES) bounds pagination even against a
          // server that never terminates the sequence.
          const pageNum = cursor ? Number(cursor) + 1 : 1;
          process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: `model-${pageNum}`, model: `model-${pageNum}`, displayName: `Model ${pageNum}` }], nextCursor: String(pageNum) } })}\n`);
        } else if (!cursor) {
          process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: "gpt-fake-1", model: "gpt-fake-1", displayName: "Fake One", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: "page-2" } })}\n`);
        } else {
          process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [{ id: "gpt-fake-2", model: "gpt-fake-2", displayName: "Fake Two" }], nextCursor: null } })}\n`);
        }
      } else if (request.method === "account/login/start") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { type: "chatgpt", authUrl: "https://example.invalid/auth", loginId: "login-1" } })}\n`);
        if (flag("--auto-complete-login")) {
          setTimeout(() => {
            process.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { success: true, loginId: "login-1", error: null } })}\n`);
          }, 20);
        }
      } else if (request.method === "account/login/cancel") {
        process.stdout.write(`${JSON.stringify({ id: request.id, result: { status: "canceled" } })}\n`);
      } else if (request.method === "exit") {
        process.exit(0);
      }
    });
  }
}
