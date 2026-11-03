/** Isolated Electron check of local preview file subresources and navigation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";
import { launchSmokeElectron } from "./smoke-electron-launch.mjs";
import { connectIsolatedCdp } from "./isolated-cdp.mjs";

const profile = realpathSync(mkdtempSync(join(tmpdir(), "anycode-preview-profile-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "anycode-preview-outside-")));
const first = join(profile, "first");
const second = join(profile, "second");
const files = {
  sibling: join(first, "asset.txt"), outside: join(outside, "asset.txt"),
  private: join(profile, ".anycode", "asset.txt"), workspace: join(profile, "asset.txt"),
  next: join(second, "asset.txt"),
};
const firstDoc = join(first, "index.html");
const secondDoc = join(second, "index.html");
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
  mkdirSync(first); mkdirSync(second); mkdirSync(join(profile, ".anycode"), { recursive: true });
  for (const [key, path] of Object.entries(files)) writeFileSync(path, `synthetic-${key}`);
  writeFileSync(firstDoc, `<!doctype html><title>First fixture</title><a id="next" href="${pathToFileURL(secondDoc).href}">Next</a>`);
  writeFileSync(secondDoc, "<!doctype html><title>Second fixture</title>");
  const call = (method, params = {}) => cdp.call(method, params);
  const info = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); } catch { return null; } });
  const api = async (method, path, body) => { const r = await cdp.automation(info, path, method, body); if (!r.ok) throw new Error(`${method} ${path} failed`); return r.result; };
  const tab = await api("POST", "/tabs", { kind: "new", workspace: profile });
  assert.equal(tab.ok, true, JSON.stringify(tab));
  const preview = await api("POST", `/tabs/${tab.tabId}/previews`, { path: firstDoc });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const page = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url === pathToFileURL(firstDoc).href));
  const session = (await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  const evaluate = async expression => { const r = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  async function check(label, path, expected) {
    const url = pathToFileURL(path).href;
    const result = await evaluate(`fetch(${JSON.stringify(url)}).then(r => r.text()).catch(() => null)`);
    console.log(`${label}: ${result === null ? "denied" : `loaded (${result})`}`);
    assert.equal(result, expected);
    if (expected === null) {
      await wait(async () => {
        const log = await api("GET", `/tabs/${tab.tabId}/previews/${preview.value.previewId}/console?tail=100`);
        return log.entries?.some(entry => entry.message.includes("blocked by security policy") && entry.message.includes(url));
      });
    }
  }
  await check("Document sibling", files.sibling, "synthetic-sibling");
  await check("Temp sibling tree", files.outside, null);
  await check("Fake profile .anycode", files.private, null);
  await check("Broad workspace root", files.workspace, null);
  await evaluate("document.querySelector('#next').click(); true");
  await wait(async () => (await evaluate("location.href").catch(() => "")) === pathToFileURL(secondDoc).href);
  await check("New document sibling", files.next, "synthetic-next");
  await check("Previous document sibling", files.sibling, null);
  console.log("PASS: in-page navigation moved the document anchor");

  const workspace = join(profile, "project");
  const workspaceLink = join(profile, "project-link");
  mkdirSync(join(workspace, "site"), { recursive: true });
  mkdirSync(join(workspace, "shared"));
  symlinkSync(workspace, workspaceLink);
  writeFileSync(join(workspace, "shared", "a.css"), "body { color: rgb(12, 34, 56); }");
  const linkedDoc = join(workspace, "site", "index.html");
  writeFileSync(linkedDoc, `<!doctype html><link rel="stylesheet" href="../shared/a.css"><title>Linked workspace</title>`);
  const linkedTab = await api("POST", "/tabs", { kind: "new", workspace: workspaceLink });
  assert.equal(linkedTab.ok, true, JSON.stringify(linkedTab));
  const linkedPreview = await api("POST", `/tabs/${linkedTab.tabId}/previews`, { path: join(workspaceLink, "site", "index.html") });
  assert.equal(linkedPreview.ok, true, JSON.stringify(linkedPreview));
  const linkedPage = await wait(async () => (await call("Target.getTargets")).targetInfos.find(t => t.url === pathToFileURL(linkedDoc).href));
  const linkedSession = (await call("Target.attachToTarget", { targetId: linkedPage.targetId, flatten: true })).sessionId;
  const linkedEval = async expression => {
    const result = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, linkedSession);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  assert.equal(await linkedEval("getComputedStyle(document.body).color"), "rgb(12, 34, 56)");
  assert.equal(await linkedEval(`fetch(${JSON.stringify(pathToFileURL(files.sibling).href)}).then(r => r.text()).catch(() => null)`), null);
  console.log("PASS: symlinked workspace loads ../shared/a.css and blocks files outside the workspace");
} finally {
  if (cdp) { try { const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8")); await cdp.automation(info, "/quit", "POST", {}); } catch {} cdp.ws.close(); }
  if (app.exitCode === null && app.signalCode === null) try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
}
