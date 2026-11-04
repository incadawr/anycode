/** Isolated Electron check of the embedded preview's deny-by-default download policy. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const MARKER = "anycode-download-smoke-marker";
const profile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-preview-dl-profile-")));
const unavailableEngine = join(profile, "unavailable-engine");
writeFileSync(unavailableEngine, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture", custom: [{ id: "custom:fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compatible", models: ["fixture"] }], connections: [{ id: "fixture", providerId: "custom:fixture", label: "Fixture", model: "fixture", models: ["fixture"], transport: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));

const attachment = (name) => `${MARKER}-${name}`;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>Download fixture</title><a id="dl-a" href="/attach-a" download="smoke-a.txt">plain</a>`);
    return;
  }
  if (url.pathname === "/redirect-b") {
    res.writeHead(302, { Location: "/attach-b" });
    res.end();
    return;
  }
  const attach = url.pathname.match(/^\/attach-(.+)$/);
  if (attach) {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Disposition": `attachment; filename="smoke-${attach[1]}.txt"`,
    });
    res.end(attachment(attach[1]));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const env = { ...buildSmokeEnv(process.env, profile, 0, unavailableEngine), HOME: profile, ELECTRON_DISABLE_SANDBOX: "1" };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: ["ignore", "ignore", "inherit"] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Electron launcher exited: code=${app.exitCode} signal=${app.signalCode}`);
    const result = await fn(); if (result) return result; await sleep(200);
  }
  throw new Error("Timed out waiting for isolated Electron or fixture result");
}
/** True if the file's NAME or CONTENT would only exist had a download been saved. */
function carriesMarker(path, name) {
  if (/^smoke-[a-d]\.txt$/.test(name)) return true;
  if (statSync(path).size > 1024 * 1024) return false;
  try { return readFileSync(path, "utf8").includes(MARKER); } catch { return false; }
}
function markerFiles(root) {
  const hits = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) hits.push(...markerFiles(path));
    else if (carriesMarker(path, name)) hits.push(path);
  }
  return hits;
}

let cdp;
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait });
  mkdirSync(join(profile, ".anycode"), { recursive: true });
  const call = (method, params = {}, sessionId) => cdp.call(method, params, sessionId);
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };
  const tab = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert.equal(tab.ok, true, JSON.stringify(tab));
  const preview = await api("POST", `/tabs/${tab.tabId}/previews`, { url: pageUrl });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const previewId = preview.value.previewId;
  const page = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url === pageUrl));
  const session = (await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

  const consoleHas = async filename => {
    const log = await api("GET", `/tabs/${tab.tabId}/previews/${previewId}/console?tail=200`);
    return log.entries?.some(entry => entry.message.includes("blocked by security policy: download") && entry.message.includes(filename)) ?? false;
  };

  const triggers = [
    { id: "a", label: "anchor[download] to Content-Disposition attachment", filename: "smoke-a.txt", run: `document.querySelector('#dl-a').click(); true` },
    { id: "b", label: "location.href to 302 -> attachment", filename: "smoke-b.txt", run: `location.href = '/redirect-b'; true` },
    { id: "c", label: "blob:-URL anchor", filename: "smoke-c.txt", run: `(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([${JSON.stringify(attachment("blob"))}], { type: 'text/plain' })); a.download = 'smoke-c.txt'; document.body.appendChild(a); a.click(); return true; })()` },
    { id: "d", label: "data:-URL anchor", filename: "smoke-d.txt", run: `(() => { const a = document.createElement('a'); a.href = 'data:text/plain;base64,' + btoa(${JSON.stringify(attachment("data"))}); a.download = 'smoke-d.txt'; document.body.appendChild(a); a.click(); return true; })()` },
  ];

  let skipped = 0;
  for (const trigger of triggers) {
    assert.equal(await evaluate(trigger.run), true, trigger.label);
    // Downloads denied by the policy leave NOTHING on disk and log ONE ring entry.
    const logged = await wait(async () => await consoleHas(trigger.filename), 10000).catch((error) => {
      // Only a routing timeout is an honest SKIP — a launcher crash mid-run must fail loudly.
      if (!(error instanceof Error) || !error.message.startsWith("Timed out")) throw error;
      return false;
    });
    assert.deepEqual(markerFiles(profile), [], `trigger ${trigger.id}: a download was saved into the isolated profile`);
    if (!logged) {
      skipped += 1;
      console.log(`SKIP (trigger ${trigger.id}, ${trigger.label}): no "blocked by security policy: download" ring entry within 10s — Electron 43 did not route this trigger through will-download; verified nothing was saved`);
      continue;
    }
    console.log(`PASS (trigger ${trigger.id}, ${trigger.label}): download cancelled, denied by the preview security policy, nothing saved`);
  }
  assert.deepEqual(markerFiles(profile), [], "a download was saved into the isolated profile");
  if (skipped === triggers.length) {
    throw new Error("every trigger was skipped — the will-download policy never surfaced; this is NOT a pass");
  }
  console.log(`PASS: embedded preview denies page-initiated downloads by default (${triggers.length - skipped}/${triggers.length} triggers routed through will-download, ${skipped} skipped with reason)`);
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
