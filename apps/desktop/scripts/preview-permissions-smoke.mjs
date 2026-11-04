/** Isolated Electron check: every preview permission path denies (request, check, device, display capture, subframes). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-preview-permissions-profile-")));
const doc = join(profile, "permissions.html");
const binary = join(profile, "unavailable-engine");
writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
writeFileSync(join(profile, "settings.json"), JSON.stringify({ version: 2, provider: { activeConnectionId: "fixture", custom: [{ id: "custom:fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", kind: "openai-compatible", models: ["fixture"] }], connections: [{ id: "fixture", providerId: "custom:fixture", label: "Fixture", model: "fixture", models: ["fixture"], transport: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", authOptional: true }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "dark" }, security: { allowWeakSecretStorage: false } }));
const env = { ...buildSmokeEnv(process.env, profile, 0, binary), HOME: profile, ELECTRON_DISABLE_SANDBOX: "1" };
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
  writeFileSync(doc, "<!doctype html><title>Permissions fixture</title><body>synthetic</body>");
  const call = (method, params = {}, session) => cdp.call(method, params, session);
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };
  const tab = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert.equal(tab.ok, true, JSON.stringify(tab));
  const preview = await api("POST", `/tabs/${tab.tabId}/previews`, { path: doc });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const page = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url === pathToFileURL(doc).href));
  const session = (await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  const evaluate = async expression => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  console.log(`Electron: ${(await evaluate("navigator.userAgent")).match(/Electron\/(\S+)/)?.[1] ?? "unknown"}`);
  // Every probe returns "denied:<name>" on policy rejection, "granted" if the
  // permission somehow passes, or a JSON-able payload for structured checks.
  const probe = expr => `(async () => ${expr})()`;
  const rejects = async (label, expr) => { const result = await evaluate(probe(expr)); console.log(`${label}: ${result}`); assert.ok(typeof result === "string" && result.startsWith("denied:"), `${label} must be denied, got ${result}`); };
  await rejects("getUserMedia video", `navigator.mediaDevices.getUserMedia({video:true}).then(() => "granted").catch(e => "denied:" + e.name)`);
  await rejects("getUserMedia audio", `navigator.mediaDevices.getUserMedia({audio:true}).then(() => "granted").catch(e => "denied:" + e.name)`);
  await rejects("getDisplayMedia", `navigator.mediaDevices.getDisplayMedia({video:true}).then(() => "granted").catch(e => "denied:" + e.name)`);
  // clipboard.readText() refuses an UNFOCUSED document regardless of any
  // permission handler — focus the page first so the rejection below is
  // attributable to the deny policy.
  await call("Page.bringToFront", {}, session);
  await wait(async () => (await evaluate("document.hasFocus()")) === true, 10000);
  await rejects(`clipboard.readText (focused=${await evaluate("document.hasFocus()")})`, `navigator.clipboard.readText().then(() => "granted").catch(e => "denied:" + e.name)`);
  await rejects("hid.requestDevice", `navigator.hid.requestDevice({filters:[]}).then(() => "granted").catch(e => "denied:" + e.name)`);
  await rejects("usb.requestDevice", `navigator.usb.requestDevice({filters:[]}).then(() => "granted").catch(e => "denied:" + e.name)`);
  await rejects("serial.requestPort", `navigator.serial.requestPort().then(() => "granted").catch(e => "denied:" + e.name)`);
  for (const [label, expr] of [["hid.getDevices", "navigator.hid.getDevices().then(d => d.length)"], ["usb.getDevices", "navigator.usb.getDevices().then(d => d.length)"], ["serial.getPorts", "navigator.serial.getPorts().then(d => d.length)"]]) {
    const count = await evaluate(probe(expr));
    console.log(`${label}: ${count}`);
    assert.equal(count, 0);
  }
  const geoCode = await evaluate(probe(`new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve("granted"), err => resolve(err.code), {timeout:5000}))`));
  console.log(`geolocation: ${geoCode}`);
  assert.equal(geoCode, 1); // GeolocationPositionError.PERMISSION_DENIED
  const notif = await evaluate(probe(`new Promise(resolve => Notification.requestPermission(resolve))`));
  console.log(`Notification.requestPermission: ${notif}`);
  assert.equal(notif, "denied");
  const cameraQuery = await evaluate(probe(`navigator.permissions.query({name:"camera"}).then(s => s.state).catch(e => "error:" + e.name)`));
  console.log(`permissions.query camera: ${cameraQuery}`);
  assert.equal(cameraQuery, "denied");
  // Same-document (srcdoc, inherits the page origin) subframe must hit the
  // same deny policy: notifications and geolocation.
  const frame = await evaluate(probe(`new Promise(resolve => {
    const f = document.createElement("iframe");
    f.srcdoc = "<!doctype html><body>iframe fixture</body>";
    f.onload = async () => {
      const w = f.contentWindow;
      const notif = await new Promise(res => { try { w.Notification.requestPermission(res); } catch (e) { res("error:" + e.name); } });
      const geo = await new Promise(res => { w.navigator.geolocation.getCurrentPosition(() => res("granted"), err => res(err.code), {timeout:5000}); });
      resolve({ notif, geo });
    };
    document.body.appendChild(f);
  })`));
  console.log(`iframe srcdoc: ${JSON.stringify(frame)}`);
  assert.deepEqual(frame, { notif: "denied", geo: 1 });
  console.log("PASS: preview sessions deny every permission path (request, check, device, display capture, clipboard, geolocation, notifications, HID/USB/serial, subframes)");
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true });
}
