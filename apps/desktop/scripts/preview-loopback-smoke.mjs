/** Isolated Electron check of the preview loopback grant: one pinned dev-server origin per preview, every other loopback target denied.
 *
 * STATUS: unverified live. The first bring-up never completed a leg: this
 * script's own CDP wrapper dropped the per-target session argument, so every
 * Runtime.evaluate landed on the connect-time app-window session instead of
 * the preview target and timed out. isolated-cdp.mjs itself is fine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-preview-loopback-")));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Two harmless loopback HTTP fixtures: A plays the dev server a preview is
// opened with, B plays a second local service nothing was ever opened against.
let hitsA = 0, hitsB = 0;
const serverA = createServer((req, res) => {
  hitsA += 1;
  res.setHeader("content-type", req.url === "/asset.txt" ? "text/plain" : "text/html");
  res.end(req.url === "/asset.txt"
    ? "synthetic-dev-asset"
    : `<!doctype html><title>Dev fixture</title><script>
window.__devChecks = async (portB, portA) => {
  const rel = await fetch("asset.txt").then(r => r.text()).catch(() => null);
  const otherPort = await fetch("http://localhost:" + portB + "/").then(r => r.text()).catch(() => null);
  const otherHost = await fetch("http://127.0.0.1:" + portA + "/").then(r => r.text()).catch(() => null);
  const ws = await new Promise(resolve => {
    const socket = new WebSocket("ws://localhost:" + portB + "/ws");
    const done = value => { if (!resolve.settled) { resolve.settled = true; resolve(value); } };
    socket.onopen = () => done("open");
    socket.onerror = () => done("error");
    socket.onclose = () => done("closed");
    setTimeout(() => done("timeout"), 3000);
  });
  return { rel, otherPort, otherHost, ws };
};
</script>`);
});
// serverB has no WebSocket endpoint: an upgrade attempt means the gate let a
// denied request through, so count and destroy instead of answering.
let upgradesB = 0;
const serverB = createServer((req, res) => {
  hitsB += 1;
  res.setHeader("content-type", req.url === "/b-asset.txt" ? "text/plain" : "text/html");
  res.end(req.url === "/b-asset.txt" ? "synthetic-second-port" : "<!doctype html><title>Second fixture</title>");
});
serverB.on("upgrade", (req, socket) => { upgradesB += 1; socket.destroy(); });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const portA = await listen(serverA);
const portB = await listen(serverB);

const urlA = `http://localhost:${portA}/`;
const urlB = `http://localhost:${portB}/`;
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture", custom: [{ id: "custom:fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compatible", models: ["fixture"] }], connections: [{ id: "fixture", providerId: "custom:fixture", label: "Fixture", model: "fixture", models: ["fixture"], transport: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const env = { ...buildSmokeEnv(process.env, profile, 0, binary), HOME: profile, ELECTRON_DISABLE_SANDBOX: "1" };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: ["ignore", "ignore", "inherit"] });
async function wait(fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Electron launcher exited: code=${app.exitCode} signal=${app.signalCode}`);
    const result = await fn(); if (result) return result; await sleep(200);
  }
  throw new Error("Timed out waiting for isolated Electron or fixture result");
}
let cdp;
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait });
  mkdirSync(join(profile, ".anycode"), { recursive: true });
  const call = (method, params = {}, session) => cdp.call(method, params, session);
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };
  const tab = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert.equal(tab.ok, true, JSON.stringify(tab));
  const attach = async (pageUrl, readyExpr) => {
    const page = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url === pageUrl)).catch(async error => {
      const targets = await call("Target.getTargets");
      throw new Error(`no target ${pageUrl}; saw: ${targets.targetInfos.map(t => t.url).join(" | ")} — ${error.message}`);
    });
    const attachResponse = await call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const session = attachResponse.sessionId;
    if (!session) throw new Error(`attachToTarget returned no sessionId for ${pageUrl}`);
    if (readyExpr !== undefined) {
      // The target exists as soon as navigation starts; wait for the page's
      // own inline script before driving it.
      const deadline = Date.now() + 60000;
      let last = null;
      while (Date.now() < deadline) {
        const r = await call("Runtime.evaluate", { expression: readyExpr, returnByValue: true }, session);
        last = r;
        if (r.result?.value === true) return session;
        await sleep(200);
      }
      const state = await call("Runtime.evaluate", { expression: "({ ready: document.readyState, title: document.title, href: location.href, body: document.body ? document.body.innerHTML.slice(0, 300) : null })", returnByValue: true }, session).catch(error => ({ error: String(error) }));
      const targets = await call("Target.getTargets");
      throw new Error(`page never became ready (${readyExpr}); last=${JSON.stringify(last).slice(0, 200)}; state=${JSON.stringify(state).slice(0, 300)}; foundTargetId=${page.targetId}; targets=${JSON.stringify(targets.targetInfos.map(t => ({ id: t.targetId.slice(0, 8), type: t.type, url: t.url })))}`);
    }
    return session;
  };
  const evaluator = session => async expression => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // Leg 1 — the dev-server preview: relative assets work, every OTHER
  // loopback origin (second port, second host spelling, ws) is denied.
  const devPreview = await api("POST", `/tabs/${tab.tabId}/previews`, { url: urlA });
  assert.equal(devPreview.ok, true, JSON.stringify(devPreview));
  const devEval = evaluator(await attach(urlA, "typeof window.__devChecks === 'function'"));
  const checks = await devEval(`window.__devChecks(${portB}, ${portA})`);
  assert.equal(checks.rel, "synthetic-dev-asset", "relative dev assets must load from the pinned origin");
  assert.equal(checks.otherPort, null, "fetch to a second loopback port must be denied");
  assert.equal(checks.otherHost, null, "fetch via 127.0.0.1 spelling must be denied");
  assert.equal(upgradesB, 0, "WebSocket to a second loopback port must be denied: no upgrade attempt may reach it");
  console.log(`PASS: pinned origin serves relative assets (${checks.rel}); other port/host/ws denied`);
  const blocked = await api("GET", `/tabs/${tab.tabId}/previews/${devPreview.value.previewId}/console?tail=100`);
  assert.ok(blocked.entries.some(entry => entry.message.includes("blocked by security policy") && entry.message.includes(`http://localhost:${portB}`)), "denials are legible in the preview console");
  assert.equal(hitsB, 0, "the second port must have received no requests at all");

  // Leg 2 — in-page navigation to the second port is denied: the document stays.
  await devEval(`location.href = ${JSON.stringify(urlB)}; true`);
  await sleep(1500);
  assert.equal(await devEval("location.href").catch(() => ""), urlA, "navigation to a second loopback port must not commit");
  assert.equal(hitsB, 0, "a denied navigation must not reach the second port");
  console.log("PASS: in-page navigation to the second loopback port is denied");

  // Leg 3 — a file: preview has NO loopback grant at all.
  const fileDoc = join(profile, "artifact.html");
  writeFileSync(fileDoc, "<!doctype html><title>Artifact fixture</title><script>window.__fileChecks = async (a, b) => ({ a: await fetch('http://localhost:' + a + '/').then(r => r.text()).catch(() => null), b: await fetch('http://localhost:' + b + '/').then(r => r.text()).catch(() => null) });</script>");
  const filePreview = await api("POST", `/tabs/${tab.tabId}/previews`, { path: fileDoc });
  assert.equal(filePreview.ok, true, JSON.stringify(filePreview));
  const fileEval = evaluator(await attach(pathToFileURL(fileDoc).href, "typeof window.__fileChecks === 'function'"));
  const fileChecks = await fileEval(`window.__fileChecks(${portA}, ${portB})`);
  assert.equal(fileChecks.a, null, "a file: preview must not reach the dev server origin");
  assert.equal(fileChecks.b, null, "a file: preview must not reach the second port");
  console.log("PASS: a file: preview has no loopback grant");

  // Leg 4 — the explicit open path legitimately loads the second port and
  // pins IT (a fresh preview, its own grant; the old preview keeps its own).
  const secondPreview = await api("POST", `/tabs/${tab.tabId}/previews`, { url: urlB });
  assert.equal(secondPreview.ok, true, JSON.stringify(secondPreview));
  const hitsBefore = hitsB;
  const secondEval = evaluator(await attach(urlB, "document.readyState === 'complete' || document.readyState === 'interactive'"));
  assert.equal(await secondEval(`fetch("b-asset.txt").then(r => r.text()).catch(() => null)`), "synthetic-second-port");
  assert.equal(await secondEval(`fetch(${JSON.stringify(urlA)}).then(r => r.text()).catch(() => null)`), null, "the second preview must not inherit the first preview's grant");
  assert.ok(hitsB >= hitsBefore + 1, "the explicit open legitimately reached the second port");
  console.log("PASS: explicit open loads the second port and pins only it");

  console.log("PASS: preview loopback grant is pinned to the opened dev-server origin");
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  serverA.close(); serverB.close();
  rmSync(profile, { recursive: true, force: true });
}
