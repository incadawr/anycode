/** Capture a provider grid in isolated profiles; no provider calls or credentials. */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(desktop, "out/provider-icons-tiles-smoke"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const providers = ["anthropic", "openai", "deepseek", "z-ai", "minimax", "opencode", "openrouter", "vllm", "custom"];

async function capture(theme) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-icons-"));
  const fixture = join(profile, "unavailable-engine");
  writeFileSync(fixture, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const now = Math.floor(Date.now() / 1000);
  const connections = providers.map(providerId => ({
    id: `fixture-${providerId}`, providerId, label: providerId === "minimax" ? "MiniMax · International" : providerId,
    model: "example-model", ...(providerId === "minimax" ? { lastQuota: {
      usedPercent: 32, family: "tokens", windowDurationMins: 300, resetsAt: now + 7200,
      observedAt: new Date().toISOString(), source: "minimax-token-plan",
      secondary: { usedPercent: 61, family: "tokens", windowDurationMins: 10080, resetsAt: now + 432000 },
    } } : {}),
  }));
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture-anthropic", connections }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme }, security: { allowWeakSecretStorage: true } }));
  const env = buildSmokeEnv(process.env, profile, 0, fixture);
  const child = launchSmokeElectron(spawn, { cwd: resolve(desktop, "../.."), env, stdio: "inherit", detached: true });
  let cdp, info;
  const wait = async fn => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Launcher exited");
      const value = await fn();
      if (value) return value;
      await sleep(250);
    }
    throw new Error("Timed out waiting for application");
  };
  try {
    cdp = await connectIsolatedCdp({ profile, env, launcher: child, wait });
    info = await wait(() => {
      try { const data = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); return data.pid === cdp.pid && data.port && data.token ? data : null; } catch { return null; }
    });
    const api = async (method, path, body) => cdp.automation(info, path, method, body);
    await wait(async () => { try { return (await api("GET", "/state?tail=0")).status === 200; } catch { return false; } });
    for (const [path, body] of [["/settings/open", {}], ["/settings/pane", { paneId: "provider" }]]) {
      const response = await api("POST", path, body);
      if (response.status !== 200 || !response.result?.ok) throw new Error(`${path} failed: ${JSON.stringify(response.result)}`);
    }
    await wait(async () => { const r = await api("GET", "/settings/provider"); return r.status === 200 && r.result?.rows?.length === providers.length; });
    await sleep(700);
    const shot = await api("GET", "/screenshot");
    if (shot.status !== 200 || typeof shot.result?.png !== "string") throw new Error("Screenshot unavailable");
    mkdirSync(output, { recursive: true });
    const path = join(output, `tiles-${theme}.png`);
    writeFileSync(path, Buffer.from(shot.result.png, "base64"));
    console.log(`Saved ${path}`);
  } finally {
    if (cdp && info) await cdp.automation(info, "/quit", "POST", {}).catch(() => {});
    cdp?.ws.close();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}
for (const theme of ["light", "dark"]) await capture(theme);
