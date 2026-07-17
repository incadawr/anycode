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
import { closeSync, writeFileSync } from "node:fs";
import readline from "node:readline";

/** A grandchild that ignores SIGTERM: only a process-GROUP SIGKILL ends it. Its pid is published so a test can assert it actually died. */
const forkStubbornGrandchild = (pidFile) => {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], {
    stdio: "ignore",
  });
  if (pidFile && grandchild.pid !== undefined) {
    writeFileSync(pidFile, String(grandchild.pid));
  }
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

if (args[0] === "--version") {
  if (flag("--version-grandchild")) {
    // The W2-review Critical for the preflight lane: a version wrapper that
    // forks a grandchild and then hangs. Killing only the direct child on
    // timeout strands the grandchild forever — this preflight runs BEFORE any
    // long-lived client exists, so no later group teardown can ever reap it.
    forkStubbornGrandchild(value("--pid-file"));
    setInterval(() => {}, 1_000);
  } else if (flag("--hang-version")) {
    // Never exits on its own — the version-preflight timeout must end it.
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
    forkStubbornGrandchild(value("--pid-file"));
    // Never reads/responds to stdin — every request the doctor sends hangs
    // until its own per-RPC timeout or the overall watchdog fires.
  } else if (flag("--close-stdin")) {
    // A LIVE app-server that closes fd 0 under us (W2-review High): the next
    // write to it raises an asynchronous EPIPE on the parent's stdin socket.
    // With no `error` listener installed there, Node turns that into an
    // unhandled stream error and kills the OWNING process. The marker line is
    // written first so the test knows the read end is gone before it writes.
    process.stdout.write(`${JSON.stringify({ method: "test/stdin-closed" })}\n`);
    closeSync(0);
    setInterval(() => {}, 1_000);
  } else {
    const signedOut = flag("--signed-out");
    const manyPages = flag("--many-pages");
    // A fully FUNCTIONAL app-server that also forks a stubborn helper — the
    // real shape of a live login: it answers RPC and holds the login window
    // open (no --auto-complete-login) while owning a grandchild. Quit must reap
    // the whole group, not just the process it can see.
    if (flag("--fork-helper")) {
      forkStubbornGrandchild(value("--pid-file"));
    }
    const selfPidFile = value("--self-pid-file");
    if (selfPidFile) {
      writeFileSync(selfPidFile, String(process.pid));
    }
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
        // Wire union variants (codex-profiles cut §1.1): flags pick which
        // GetAccountResponse shape the doctor's status automat is fed.
        const account = flag("--api-key-account")
          ? { type: "apiKey" }
          : signedOut || flag("--no-auth-required")
            ? null
            : { type: "chatgpt", email: "sentinel-custody@example.com", planType: "plus" };
        const requiresOpenaiAuth = flag("--no-auth-required") ? false : true;
        const result = flag("--no-requires-field") ? { account } : { account, requiresOpenaiAuth };
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } else if (request.method === "account/rateLimits/read") {
        // Live-shaped 0.144.5 snapshot (W0-R1 probe): ONE populated window,
        // `secondary` present-but-null, byLimitId mirroring the top level,
        // and a rateLimitResetCredits blob the decoder must silently drop.
        if (flag("--no-rate-limits")) {
          process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: "method not found" } })}\n`);
        } else {
          const snapshot = {
            primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1784791993 },
            secondary: null,
            planType: "plus",
            limitName: null,
            credits: { hasCredits: false, unlimited: false, balance: "0" },
          };
          process.stdout.write(
            `${JSON.stringify({ id: request.id, result: { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot }, rateLimitResetCredits: { availableCount: 0, credits: [] } } })}\n`,
          );
        }
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
