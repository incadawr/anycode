#!/usr/bin/env node
/**
 * TASK.237 live smoke: the managed-Codex upgrade path on a REAL machine
 * state, without the GUI. Mirrors the env-gated live-smoke convention
 * (ANYCODE_CODEX_LIVE_SMOKE=1; explicit SKIP lines otherwise — never a
 * silent green pass).
 *
 * What it proves (all inside a THROWAWAY home — the real ~/.anycode and the
 * owner's settings.json are never touched):
 *
 *  1. OLD MODELS: the managed 0.144.3 binary (the incident's version, still
 *     present on this machine under ~/.anycode/codex/bin/0.144.3) answers
 *     model/list with the OLD catalog (no gpt-6 family).
 *  2. UPGRADE + NEW MODELS: delegated to the env-gated
 *     codex-managed-upgrade.live-smoke.test.ts, which imports the production
 *     `runCodexManagedUpgrade` (plain node cannot import the .ts module) and
 *     asserts the upgraded binary's model/list serves the gpt-6 family. An
 *     empty catalog fails that leg — it never counts as a pass.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GATE = process.env.ANYCODE_CODEX_LIVE_SMOKE === "1";
const OLD_MANAGED = join(homedir(), ".anycode", "codex", "bin", "0.144.3", "vendor", "aarch64-apple-darwin", "bin", "codex");

function fail(message) {
  console.error(`[managed-upgrade-live-smoke] FAIL: ${message}`);
  process.exit(1);
}

if (!GATE) {
  console.log("[managed-upgrade-live-smoke] SKIP: set ANYCODE_CODEX_LIVE_SMOKE=1 with network access to execute it");
  process.exit(0);
}

if (!existsSync(OLD_MANAGED)) {
  console.log(`[managed-upgrade-live-smoke] SKIP: the incident's old managed 0.144.3 binary is not present at ${OLD_MANAGED}`);
  process.exit(0);
}

// ── 1. the old binary answers --version and its model/list lacks the gpt-6 family ──
const versionProbe = spawnSync(OLD_MANAGED, ["--version"], { encoding: "utf8", timeout: 30_000 });
if (versionProbe.error || versionProbe.status !== 0) {
  fail(`old managed binary --version failed: ${versionProbe.error ?? `exit ${versionProbe.status}`}`);
}
console.log(`[managed-upgrade-live-smoke] old managed binary: ${versionProbe.stdout.trim()}`);

// The catalog is fetched over the network, so the reply latency varies: read
// stdout until the model/list reply arrives, and only then close stdin
// (closing it earlier lets the app-server exit unanswered).
const oldReply = await new Promise((resolve, reject) => {
  const child = spawn(OLD_MANAGED, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  let reply = null;
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("old binary model/list probe timed out"));
  }, 60_000);
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === 3) {
          reply = message;
          child.stdin.end();
        }
      } catch {
        // not a JSON line — tolerant, mirror of the doctor's line client
      }
    }
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", () => {
    clearTimeout(timer);
    resolve(reply);
  });
  child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "anycode-smoke", title: "smoke", version: "0.0.0" }, capabilities: { experimentalApi: false } } }) + "\n");
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ id: 3, method: "model/list", params: {} }) + "\n");
});
let sawModels = false;
let sawGpt6 = false;
if (oldReply?.result && Array.isArray(oldReply.result.data)) {
  sawModels = true;
  const ids = oldReply.result.data.map((entry) => entry.id);
  console.log(`[managed-upgrade-live-smoke] old model/list (${ids.length} models): ${ids.join(", ")}`);
  sawGpt6 = ids.some((id) => /gpt-6/i.test(id));
}
if (!sawModels) {
  fail("old managed binary never answered model/list (account may be signed out — the incident profile is required for this probe)");
}
console.log(`[managed-upgrade-live-smoke] old catalog contains gpt-6 family: ${sawGpt6} (expected false — the incident's symptom)`);
if (sawGpt6) {
  fail("old managed 0.144.3 already serves gpt-6 models — the incident premise no longer reproduces on this account");
}

// ── 2. hand off to the vitest-gated live upgrade test for the new side ──
const vitest = spawnSync("npx", ["vitest", "run", "apps/desktop/src/main/codex-managed-upgrade.live-smoke.test.ts"], {
  encoding: "utf8",
  timeout: 15 * 60_000,
  env: { ...process.env, ANYCODE_CODEX_LIVE_SMOKE: "1" },
});
console.log(vitest.stdout ?? "");
if (vitest.status !== 0) {
  fail(`vitest live upgrade leg failed (exit ${vitest.status})\n${vitest.stderr ?? ""}`);
}
console.log("[managed-upgrade-live-smoke] PASS: old catalog lacked gpt-6; upgrade leg green");
