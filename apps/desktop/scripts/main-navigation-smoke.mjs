/** Run with --before on the parent revision and --after on the guarded revision. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const before = process.argv.includes("--before");
if (before === process.argv.includes("--after")) throw new Error("Pass exactly one of --before or --after");
const profile = mkdtempSync(join(tmpdir(), "anycode-navigation-profile-"));
const fixture = mkdtempSync(join(tmpdir(), "anycode-navigation-fixture-"));
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture", custom: [{ id: "custom:fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compatible", models: ["fixture"] }], connections: [{ id: "fixture", providerId: "custom:fixture", label: "Fixture", model: "fixture", models: ["fixture"], transport: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const opened = join(fixture, "opened.log");
const hook = join(fixture, "opener.cjs");
writeFileSync(hook, `if (process.type === 'browser') setImmediate(() => { const {shell} = require('module').createRequire(${JSON.stringify(fileURLToPath(new URL("../package.json", import.meta.url)))})('electron'); shell.openExternal = async url => { require('fs').appendFileSync(${JSON.stringify(opened)}, url + '\\n'); }; });`);
const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Navigation fixture</title><p id=marker>Local fixture</p>"); });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const target = `http://127.0.0.1:${server.address().port}/fixture`;
const env = { ...buildSmokeEnv(process.env, profile, 0, binary), HOME: profile, ELECTRON_DISABLE_SANDBOX: "1", NODE_OPTIONS: `--require=${hook}` };
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
let cdp;
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait });
  const call = (method, params = {}) => cdp.call(method, params);
  const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  console.log("Initial renderer:", await evaluate("JSON.stringify({url:location.href, bridge:typeof window.anycode})"));
  await wait(() => evaluate("!!window.anycode && !!document.querySelector('.sidebar-settings')"));
  const renderer = await evaluate("location.href");
  if (!before) {
    for (const [name, expression] of [
      ["about anchor", "(()=>{const a=document.createElement('a');a.href='about:blank';document.body.append(a);a.click()})()"],
      ["about query", "location.href='about:blank?x'"],
      ["about fragment", "location.href='about:blank#x'"],
      ["about self", "window.open('about:blank','_self'); null"],
      ["javascript anchor", "(()=>{const a=document.createElement('a');a.href='javascript:1';document.body.append(a);a.click()})()"],
      ["data anchor", "(()=>{const a=document.createElement('a');a.href='data:text/html,<p>Changed</p>';document.body.append(a);a.click()})()"],
      ["blob", "location.href=URL.createObjectURL(new Blob(['<p>Changed</p>'],{type:'text/html'}))"],
    ]) {
      await evaluate(`setTimeout(() => { ${expression}; }, 50); true`);
      await sleep(1200);
      await wait(() => evaluate("!!window.anycode && !!document.querySelector('.sidebar-settings')").catch(() => false));
      assert.equal(await evaluate("location.href"), renderer, `${name} replaced the renderer`);
      assert.equal(await evaluate("typeof window.anycode"), "object");
      console.log(`PASS after: ${name} cannot replace renderer`);
    }
  }
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };

  if (!before) {
    const tab = await api("POST", "/tabs", { kind: "new", workspace: fixture });
    assert.equal(tab.ok, true, JSON.stringify(tab));
    const html = join(fixture, "preview.html");
    writeFileSync(html, "<!doctype html><title>Dock fixture</title><p id=preview-marker>Dock preview works</p>");
    const preview = await api("POST", `/tabs/${tab.tabId}/previews`, { path: html });
    assert.equal(preview.ok, true);
    const id = preview.value.previewId;
    await wait(async () => (await api("GET", `/tabs/${tab.tabId}/previews`)).previews?.some(p => p.previewId === id && p.container === "panel" && p.status === "ready"));
    const selected = await api("POST", `/dock/tabs/${encodeURIComponent(`preview:${id}`)}/click`, {});
    assert.equal(selected.ok, true);
    const page = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url.startsWith("file:") && t.url.includes("preview.html")));
    const session = (await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
    const r = await cdp.call("Runtime.evaluate", { expression: "document.querySelector('#preview-marker')?.textContent", returnByValue: true }, session);
    assert.equal(r.result.value, "Dock preview works");
    await call("Target.detachFromTarget", { sessionId: session });
    console.log("PASS: dock WebContentsView loads fixture in panel");

    const markdown = join(fixture, "preview.md");
    writeFileSync(markdown, "# Markdown bridge fixture\n");
    const md = await api("POST", `/tabs/${tab.tabId}/previews`, { path: markdown });
    assert.equal(md.ok, true, JSON.stringify(md));
    const mdId = md.value.previewId;
    const transfer = await api("POST", `/tabs/${tab.tabId}/previews/${mdId}/container`, { target: "window" });
    assert.equal(transfer.ok, true, JSON.stringify(transfer));
    const mdPage = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url.includes("view=md-preview") && t.url.includes(mdId)));
    const mdSession = (await call("Target.attachToTarget", { targetId: mdPage.targetId, flatten: true })).sessionId;
    const mdEvaluate = async expression => (await cdp.call("Runtime.evaluate", { expression, returnByValue: true }, mdSession)).result.value;
    await wait(async () => (await mdEvaluate("typeof window.anycode")) === "object");
    console.log("PASS: detached Markdown preview has bridge");
    await cdp.call("Page.navigate", { url: "about:blank" }, mdSession);
    await wait(async () => (await mdEvaluate("location.href")) === "about:blank");
    assert.equal(await mdEvaluate("typeof window.anycode"), "undefined");
    console.log("PASS: untrusted about:blank has no bridge");
    await call("Target.detachFromTarget", { sessionId: mdSession });
  }
  const initialTargets = new Set((await call("Target.getTargets")).targetInfos.map(t => t.targetId));
  await evaluate(`window.open(${JSON.stringify(target)}, '_blank'); true`);
  if (before) {
    const child = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => !initialTargets.has(t.targetId) && t.url === target));
    assert(child); console.log("PASS before: window.open created child window");
  } else {
    await sleep(800);
    assert(!(await call("Target.getTargets")).targetInfos.some(t => !initialTargets.has(t.targetId) && t.url === target));
    await wait(() => existsSync(opened) && readFileSync(opened, "utf8").includes(target));
    console.log("PASS after: child denied and external opener stub called");
  }
  const previousOpens = !before ? readFileSync(opened, "utf8").trim().split("\n").length : 0;
  await evaluate(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(target)}; document.body.append(a); a.click(); })()`);
  if (before) {
    await wait(() => evaluate(`location.href === ${JSON.stringify(target)}`));
    const bridge = await evaluate("typeof window.anycode");
    console.log(`PASS before: link replaced main renderer; bridge=${bridge}`);
  } else {
    await wait(() => readFileSync(opened, "utf8").trim().split("\n").length > previousOpens);
    assert.equal(await evaluate("location.href"), renderer);
    const https = "https://example.invalid/fixture";
    await evaluate(`window.open(${JSON.stringify(https)}, '_blank'); true`);
    await wait(() => existsSync(opened) && readFileSync(opened, "utf8").includes(https));
    console.log("PASS after: link blocked; HTTPS sent to opener stub");
  }
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true });
}
