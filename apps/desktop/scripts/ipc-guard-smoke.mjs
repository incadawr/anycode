/**
 * Honest, isolated main-process smoke for the IPC sender/top-frame guard
 * (ipc-guard.ts). Run with `node scripts/ipc-guard-smoke.mjs --before` on the
 * parent revision and `--after` on the guarded revision; each run boots its
 * own throwaway Electron instance, drives the real renderer over isolated CDP
 * (the same ownership-verified connection as main-navigation-smoke.mjs) and
 * asserts four things:
 *
 *   1. the app's main frame still resolves `window.anycode.settings.get()`;
 *   2. a same-origin SUBFRAME of the renderer either has no bridge or its
 *      invoke is rejected (before: the subframe's invoke RESOLVES — the hole);
 *   3. a foreign window built by a require hook with the very same preload and
 *      renderer URL cannot invoke `settings.get()` — it must reject (before:
 *      it RESOLVES — the hole); after: rejects with the guard's refusal;
 *   4. the detached Markdown popout window (allow-listed at creation) still
 *      works: `mdPreview.read` answers instead of rejecting.
 *
 * The `--before` run is expected to FAIL on steps 2/3 (that is the hole this
 * change closes); `--after` must pass all steps.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const before = process.argv.includes("--before");
if (before === process.argv.includes("--after")) throw new Error("Pass exactly one of --before or --after");
const profile = mkdtempSync(join(tmpdir(), "anycode-ipc-guard-profile-"));
const fixture = mkdtempSync(join(tmpdir(), "anycode-ipc-guard-fixture-"));
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture", custom: [{ id: "custom:fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compatible", models: ["fixture"] }], connections: [{ id: "fixture", providerId: "custom:fixture", label: "Fixture", model: "fixture", models: ["fixture"], transport: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));

// Require-hook: after the app is ready, create a hidden foreign window with
// the SAME preload and renderer URL the real app uses (computed the same way
// main's resolvePreloadPath does: out/preload/index.cjs under the app path,
// plus the dev renderer URL from ELECTRON_RENDERER_URL). This is the "another
// window that carries the preload bridge" threat the guard must refuse.
const hook = join(fixture, "foreign-window.cjs");
writeFileSync(hook, `if (process.type === "browser") setImmediate(() => {
  const electron = require("electron");
  const { app, BrowserWindow } = electron;
  app.whenReady().then(() => {
    setTimeout(() => {
      try {
        const url = process.env.ELECTRON_RENDERER_URL;
        if (!url) return;
        const path = require("path");
        const preload = path.join(app.getAppPath(), "out", "preload", "index.cjs");
        const w = new BrowserWindow({
          show: false,
          width: 500,
          height: 400,
          webPreferences: {
            preload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            additionalArguments: [\`--anycode-renderer-url=\${url}\`],
          },
        });
        void w.loadURL(url + (url.includes("?") ? "&" : "?") + "foreignWindowProbe=1").catch(() => {});
      } catch (error) { /* the probe window is best-effort */ }
    }, 6000);
  });
});`);

const env = { ...buildSmokeEnv(process.env, profile, 0, binary), HOME: profile, ELECTRON_DISABLE_SANDBOX: "1", NODE_OPTIONS: `--require=${hook}` };
const app = launchSmokeElectron(spawn, { env, detached: true, stdio: ["ignore", "ignore", "inherit"] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Electron launcher exited: code=${app.exitCode} signal=${app.signalCode}`);
    const result = await fn(); if (result) return result; await sleep(200);
  }
  throw new Error("Timed out waiting for isolated Electron or probe result");
}
let cdp;
try {
  cdp = await connectIsolatedCdp({ profile, env, launcher: app, wait });
  const call = (method, params = {}, targetSessionId) => cdp.call(method, params, targetSessionId);
  const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

  // (1) The app's own main frame is the trusted sender: its bridge must work.
  await wait(() => evaluate("!!window.anycode"));
  const mainGet = await evaluate("window.anycode.settings.get().then(() => \"resolved\").catch(e => \"rejected:\" + String(e && e.message || e).slice(0, 160))");
  assert.equal(mainGet, "resolved", `main frame settings.get must resolve (got ${mainGet})`);
  console.log(`PASS ${before ? "before" : "after"}: main frame settings.get resolves`);

  // (2) Same-origin subframe of the renderer: either no bridge, or the invoke
  // must be rejected by the guard. A RESOLVING subframe invoke is the hole.
  const iframeProbe = await evaluate(`new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    const done = (value) => { try { frame.remove(); } catch {} resolve(value); };
    frame.onload = async () => {
      try {
        const sub = frame.contentWindow;
        const bridge = typeof sub.anycode;
        if (bridge !== "object" || sub.anycode === null) { done("no-bridge:" + bridge); return; }
        try { await sub.anycode.settings.get(); done("subframe-invoke-RESOLVED"); }
        catch (error) { done("subframe-invoke-rejected:" + String(error && error.message || error).slice(0, 160)); }
      } catch (error) { done("probe-error:" + String(error).slice(0, 160)); }
    };
    frame.src = location.origin + location.pathname;
    document.body.append(frame);
    setTimeout(() => done("iframe-timeout"), 20000);
  })`);
  if (before) {
    console.log(`INFO before: subframe probe -> ${iframeProbe}`);
  } else {
    assert(iframeProbe !== "iframe-timeout", `subframe probe timed out (${iframeProbe})`);
    assert(
      iframeProbe.startsWith("no-bridge:") || iframeProbe.startsWith("subframe-invoke-rejected:"),
      `subframe must have no bridge or a rejected invoke; got ${iframeProbe}`,
    );
    if (iframeProbe.startsWith("subframe-invoke-rejected:")) {
      assert(iframeProbe.includes("refused"), `subframe rejection should be the guard's refusal; got ${iframeProbe}`);
    }
    console.log(`PASS after: renderer subframe cannot invoke (${iframeProbe.split(":")[0]})`);
  }

  // (3) Foreign window with the same preload + renderer URL: its invoke must
  // be refused. Before the guard, such a window IS a valid sender (the hole).
  const foreignPage = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.type === "page" && t.url.includes("foreignWindowProbe=1")), 45000);
  const foreignSession = (await call("Target.attachToTarget", { targetId: foreignPage.targetId, flatten: true })).sessionId;
  const foreignEvaluate = async expression => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, foreignSession)).result.value;
  await wait(async () => (await foreignEvaluate("typeof window.anycode")) === "object");
  const foreignGet = await foreignEvaluate("window.anycode.settings.get().then(() => \"RESOLVED\").catch(e => \"REJECTED:\" + String(e && e.message || e).slice(0, 160))");
  assert(foreignGet.startsWith("REJECTED:"), `foreign window settings.get must reject; got ${foreignGet}`);
  if (!before) assert(foreignGet.includes("refused"), `foreign window rejection should be the guard's refusal; got ${foreignGet}`);
  console.log(`PASS ${before ? "before (hole: foreign window allowed)" : "after"}: foreign same-preload window -> ${foreignGet.slice(0, 80)}`);
  await call("Target.detachFromTarget", { sessionId: foreignSession });

  // (4) The detached Markdown popout is allow-listed at creation: its top
  // frame still gets real answers from mdPreview.read.
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };
  const tab = await api("POST", "/tabs", { kind: "new", workspace: fixture });
  assert.equal(tab.ok, true, JSON.stringify(tab));
  const markdown = join(fixture, "probe.md");
  writeFileSync(markdown, "# IPC guard smoke fixture\n");
  const md = await api("POST", `/tabs/${tab.tabId}/previews`, { path: markdown });
  assert.equal(md.ok, true, JSON.stringify(md));
  const mdId = md.value.previewId;
  const transfer = await api("POST", `/tabs/${tab.tabId}/previews/${mdId}/container`, { target: "window" });
  assert.equal(transfer.ok, true, JSON.stringify(transfer));
  const mdPage = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url.includes("view=md-preview") && t.url.includes(mdId)));
  const mdSession = (await call("Target.attachToTarget", { targetId: mdPage.targetId, flatten: true })).sessionId;
  const mdEvaluate = async expression => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, mdSession)).result.value;
  await wait(async () => (await mdEvaluate("typeof window.anycode")) === "object");
  const read = await mdEvaluate(`window.anycode.mdPreview.read(${JSON.stringify(tab.tabId)}, ${JSON.stringify(mdId)}).then(r => JSON.stringify(r)).catch(e => "REJECTED:" + String(e && e.message || e).slice(0, 160))`);
  assert(!read.startsWith("REJECTED"), `mdPreview.read must work in the allow-listed md window; got ${read}`);
  assert(!read.includes("refused"), `mdPreview.read must not be guard-refused; got ${read}`);
  console.log(`PASS ${before ? "before" : "after"}: allow-listed md popout mdPreview.read answers (${read.slice(0, 60)})`);
  await call("Target.detachFromTarget", { sessionId: mdSession });
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true }); rmSync(fixture, { recursive: true, force: true });
}
