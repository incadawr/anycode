/** Isolated engine fixture driver; orchestration assertions are reported separately.
 * Usage: node apps/desktop/scripts/orchestrate-mode-smoke.mjs --fixture-only [--engines core,codex,claude] [--keep]
 */
import assert from "node:assert/strict";
import { runProtocolChecks, judgeNativeProof, smokeExitCode } from "./orchestrate-smoke-checks.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { smokeProviderProfile } from "./smoke-provider-profile.mjs";
import { createEngineSmokeFixtures, evaluateSmoke, selectSmokeEngine } from "./engine-smoke-fixtures.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const LAUNCH_TIMEOUT_MS = 180_000;
const POLL_MS = 400;

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, fixtureOnly: false, engines: ["core", "codex", "claude"] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--fixture-only") {
      flags.fixtureOnly = true;
    } else if (arg === "--engines") {
      flags.engines = (argv[++i] ?? "").split(",");
      if (flags.engines.some(engine => !["core", "codex", "claude"].includes(engine))) throw new Error("Unsupported engines");
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── process/fs helpers (same as settings-ui-smoke.mjs) ──

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function killTree(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone
  }
}

// ── step bookkeeping ──

class SmokeFailure extends Error {}

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const line = `[step ${name}] ${status} ${detail ?? ""}`.trimEnd();
  if (status === "PASS") {
    console.log(line);
  } else {
    console.error(line);
  }
}

// ── the smoke ──

async function main() {
  if (!FLAGS.fixtureOnly) throw new Error("Explicit --fixture-only is required");
  const profile = mkdtempSync(join(tmpdir(), "anycode-orchestrate-mode-smoke-"));
  const settingsPath = join(profile, "settings.json");
  const ctx = { child: null };
  let fixtures, cdp, launchError;
  const evidence = { engines: FLAGS.engines, launchedAt: new Date().toISOString() };
  try {
    fixtures = await createEngineSmokeFixtures(profile);
    const provider = smokeProviderProfile("custom:local", "core-model", { credentialFromEnv: true });
    Object.assign(provider.connections[0], { baseUrl: fixtures.baseUrl, authOptional: true, transport: "openai-chat-completions" });
    provider.custom = [{ id: "custom:local", name: "Local fixture", baseUrl: fixtures.baseUrl, kind: "openai-compatible", models: ["core-model"] }];
    writeFileSync(settingsPath, JSON.stringify({ version: 2, provider, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false, trustedBinaries: fixtures.consents } }));
    writeFileSync(join(profile, "unavailable-engine"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const env = { ...buildSmokeEnv(process.env, profile, 0, fixtures.binaries.codex), HOME: profile,
      ANYCODE_CLAUDE_BIN: fixtures.binaries.claude, ANYCODE_ENGINE_SWITCH_ENABLED: "1",
      ANYCODE_ISOLATED_NATIVE_FIXTURES: "1", ANYCODE_ISOLATED_ORCHESTRATION_FIXTURES: "1",
      ANYCODE_ISOLATED_FIXTURE_NODE: realpathSync(process.execPath) };
    ctx.child = launchSmokeElectron(spawn, { cwd: repoRoot, env });
    ctx.child.on("error", error => { launchError = error; });
    const wait = async fn => {
      const end = Date.now() + LAUNCH_TIMEOUT_MS;
      while (Date.now() < end) {
        if (launchError) throw launchError;
        if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) throw new SmokeFailure("launcher exited early");
        const result = await fn();
        if (result) return result;
        await sleep(POLL_MS);
      }
      throw new SmokeFailure("isolated launch timed out");
    };
    cdp = await connectIsolatedCdp({ profile, env, launcher: ctx.child, wait });
    await wait(async () => {
      const result = await cdp.call("Runtime.evaluate", { expression: "typeof window.anycode?.createTab === 'function' && !!document.querySelector('main.app')", returnByValue: true });
      return result.result.value === true;
    });
    const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(profile, "launch.png"), Buffer.from(shot.data, "base64"));
    record("isolated-launch", "PASS", "verified disposable Electron renderer");
    const evaluate = expression => evaluateSmoke(cdp, expression);
    const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
    const api = async (path, method = "GET", body) => {
      const response = await cdp.automation(info, path, method, body);
      assert(response.ok, JSON.stringify(response.result));
      return response.result;
    };
    const tab = await evaluate(`window.anycode.createTab({kind:"new",workspace:${JSON.stringify(profile)}})`);
    assert(tab.ok, JSON.stringify(tab));
    await wait(() => evaluate(`!!document.querySelector('button[aria-label="Switch engine"]')`));
    for (const engine of FLAGS.engines) {
      if (!(await evaluate(`document.querySelector('button[aria-label="Switch engine"]')?.textContent === ${JSON.stringify(`${engine} ▾`)}`))) await selectSmokeEngine(evaluate, wait, engine);
      await wait(() => evaluate(`document.querySelector('button[aria-label="Switch engine"]')?.textContent === ${JSON.stringify(`${engine} ▾`)}`));
      const before = await evaluate('document.querySelectorAll(".message-loop-end").length');
      const text = `isolated ${engine} fixture turn`;
      const callsBefore = fixtures.providerCalls;
      await api(`/tabs/${tab.tabId}/prompt`, "POST", { text });
      await wait(async () => (await evaluate('document.querySelectorAll(".message-loop-end").length')) > before);
      await wait(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId].turn.status === "idle");
      assert(await evaluate(`document.body.innerText.includes(${JSON.stringify(engine === "core" ? "core fixture answer" : "native fixture answer")})`));
      if (engine === "core") {
        assert(fixtures.providerCalls > callsBefore);
        assert(JSON.stringify(fixtures.providerInputs.slice(callsBefore)).includes(text));
      }
      else {
        const frames = readFileSync(join(profile, `${engine}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert(frames.some(frame => (engine === "codex" ? frame.method === "turn/start" : frame.type === "user") && JSON.stringify(frame).includes(text)));
      }
      record(`${engine}-fixture-turn`, "PASS", "isolated renderer and fixture wire completed");
      if (engine === "claude") {
        const state = (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId];
        assert.equal(state.orchestrateActive, false);
        const refused = await api(`/tabs/${tab.tabId}/orchestrate`, "POST", { enabled: true });
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, "not_ready");
        record("claude-flag-off", "PASS", "ordinary fixture turn completed with overlay unavailable");
      }
      record(`${engine}-orchestrate-ui`, "SKIP", "ON menu/slash/roles dispatch not exercised by this GUI fixture");
    }
    await cdp.call("Page.reload");
    await wait(async () => {
      try { return (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId]?.connection === "ready"; }
      catch { return false; }
    });
    const reloadNonce = `reload-${Date.now()}`;
    await api(`/tabs/${tab.tabId}/prompt`, "POST", { text: reloadNonce });
    const lastEngine = FLAGS.engines.at(-1);
    await wait(() => lastEngine === "core"
      ? fixtures.providerInputs.some(input => JSON.stringify(input).includes(reloadNonce))
      : readFileSync(join(profile, `${lastEngine}.jsonl`), "utf8").includes(reloadNonce));
    await wait(async () => (await api(`/state/${tab.tabId}`)).snapshot.states[tab.tabId].turn.status === "idle");
    record("gui-reload", "PASS", "same tab accepted a nonce on the engine wire after renderer reload");
    for (const result of await runProtocolChecks(repoRoot, profile)) record(result.name, result.status, result.detail);
    for (const check of ["native-live", "auth-equivalence", "managed-policy"]) {
      const result = judgeNativeProof({ reason: "credential-free fixtures cannot qualify native capabilities" });
      record(check, result.status, result.detail);
    }
  } catch (err) {
    const name = err instanceof SmokeFailure ? err.message.split(":")[0] : "unexpected";
    record(name, "FAIL", err?.message ?? String(err));
  } finally {
    cdp?.ws.close();
    if (ctx.child?.pid) {
      const exited = new Promise(resolve => ctx.child.once("exit", resolve));
      killTree(ctx.child.pid, "SIGTERM");
      await Promise.race([exited, sleep(1000)]);
      killTree(ctx.child.pid, "SIGKILL");
    }
    if (fixtures) await new Promise(resolve => fixtures.fixture.close(resolve));
    writeFileSync(join(profile, "result.json"), JSON.stringify({ ...evidence, results }, null, 2) + "\n");
    if (FLAGS.keep) console.log(`Isolated artifacts: ${profile}`);
    else rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`[orchestrate-mode-smoke] ${results.filter(r => r.status === "PASS").length} PASS, ${failed.length} FAIL, ${results.filter(r => r.status === "SKIP").length} SKIP`);
  process.exit(smokeExitCode(results));
}

main().catch((err) => {
  console.error(`[orchestrate-mode-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
