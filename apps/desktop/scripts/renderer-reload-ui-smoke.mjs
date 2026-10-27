/**
 * Isolated dev smoke for the basic renderer reload handshake (GitHub #19).
 *
 * Run: node apps/desktop/scripts/renderer-reload-ui-smoke.mjs [--keep]
 * Supply ANYCODE_API_KEY (and optionally ANYCODE_BASE_URL) in the environment.
 * The profile, workspace, user data, engine homes and evidence are disposable.
 * This script does not submit a provider prompt or create agent messages.
 * The independent acceptance agent performs the live scenario separately.
 */
import { launchReloadSmoke, assertReloadSnapshot } from "./renderer-reload-smoke-support.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { smokeProviderProfile } from "./smoke-provider-profile.mjs";

console.log("NOT COVERED: generated/refined titles, menu confirmation and packaged shortcuts, live turns, child sessions, approvals, agent delivery states and previews, grouping and minimap navigation, narrow layout, later progress, restart durability, or duplicate model requests. The independent acceptance agent must exercise those plan steps.");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
if (args.some((arg) => arg !== "--keep")) throw new Error("Only --keep is supported; provider credentials must be supplied through the environment");
if (!process.env.ANYCODE_API_KEY) throw new Error("Set ANYCODE_API_KEY for the isolated provider");
// Do not let an inherited TMPDIR put the disposable profile inside an owner directory.
if (process.platform === "win32") throw new Error("This smoke requires a POSIX temporary directory and executable fixture");
const tempRoot = "/tmp";
const profile = mkdtempSync(join(tempRoot, "anycode-renderer-reload-"));
const evidenceDir = mkdtempSync(join(tempRoot, "anycode-renderer-reload-evidence-"));
mkdirSync(evidenceDir, { recursive: true });
const evidence = {
  profile,
  evidenceDir,
  startedAt: new Date().toISOString(),
  steps: [],
  before: null,
  after: null,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name, detail) => {
  evidence.steps.push({ name, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) });
};

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

const workspace = join(profile, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "README.md"), "# Disposable reload smoke workspace\n");
writeFileSync(join(profile, "settings.json"), JSON.stringify({
  version: 2,
  provider: smokeProviderProfile("z-ai", "glm-5.2", { credentialFromEnv: true }),
  tools: {}, permissions: { alwaysAllow: [{ toolName: "Agent" }] },
  ui: { theme: "system" }, security: { allowWeakSecretStorage: false },
}));
// A deliberately unusable engine binary keeps the signed-in engines out of this
// disposable profile; the reload scenario runs on the configured provider.
const unavailableEngine = join(profile, "unavailable-engine");
writeFileSync(unavailableEngine, "#!/bin/sh\nexit 1\n", { mode: 0o700 });

mkdirSync(join(profile, "tmp"), { recursive: true });
const app = launchReloadSmoke(spawn, process.env, profile, workspace, port, unavailableEngine);

let ws;
const pending = new Map();
let nextId = 0;
async function poll(fn, timeout = 60_000, label = "GUI state") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function screenshot(name) {
  const png = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(evidenceDir, name), Buffer.from(png.data, "base64"));
}
/** The renderer's own read-only automation projection (installed DEV-only). */
async function snapshot() {
  return evaluate("window.__anycodeAutomation ? window.__anycodeAutomation.snapshot(1000) : null");
}

try {
  step("launch", { profile, evidenceDir, workspace });
  const target = await poll(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((entry) => entry.type === "page" && !entry.url.startsWith("devtools://"));
    } catch {
      return false;
    }
  }, 90_000, "the dev renderer (CDP target)");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(data);
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    clearTimeout(item.timer);
    if (response.error) item.reject(new Error(JSON.stringify(response.error)));
    else item.resolve(response.result);
  };

  const ready = await poll(async () => {
    const snap = await snapshot();
    return snap?.tabs.length && snap.tabs.every((tab) => typeof tab.sessionId === "string" && tab.sessionId.length > 0 && snap.states[tab.tabId]?.connection === "ready") ? snap : false;
  }, 90_000, "open sessions and their initial handshakes");

  evidence.before = ready.tabs.map((tab) => ({ tabId: tab.tabId, sessionId: tab.sessionId, title: tab.title ?? null }));
  await screenshot("before-reload.png");
  await evaluate("document.documentElement.dataset.reloadSmokeSentinel = 'before-reload'");
  await call("Page.reload", {});
  const reloaded = await poll(async () => {
    const sentinel = await evaluate("document.documentElement.dataset.reloadSmokeSentinel ?? null").catch(() => "waiting");
    if (sentinel !== null) return false;
    const snap = await snapshot().catch(() => null);
    return snap?.tabs.length === ready.tabs.length && snap.tabs.every((tab) => snap.states[tab.tabId]?.connection === "ready") ? snap : false;
  }, 90_000, "the reloaded renderer and session handshakes");
  assertReloadSnapshot(ready, reloaded);
  evidence.after = reloaded.tabs.map((tab) => ({ tabId: tab.tabId, sessionId: tab.sessionId, title: tab.title ?? null }));
  await screenshot("after-reload.png");
  step("forced-reload-handshake", { tabs: reloaded.tabs.length });
  writeFileSync(join(evidenceDir, "report.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS: forced renderer reload replaced the document and restored ${reloaded.tabs.length} open session handshake(s) with the same IDs and title values.\nEvidence: ${evidenceDir}`);

} catch (error) {
  evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    writeFileSync(join(evidenceDir, "report.json"), JSON.stringify(evidence, null, 2));
  } catch {
    /* the evidence directory may already be gone */
  }
  console.error(`FAIL: ${evidence.error}\nEvidence: ${evidenceDir}`);
  process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) await call("Browser.close", {}).catch(() => {});
  ws?.close();
  if (existsSync(join(profile, "automation.json"))) {
    const info = JSON.parse(readFileSync(join(profile, "automation.json"), "utf8"));
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await sleep(500);
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (keep) {
    console.log(`Kept the isolated profile (--keep): ${profile}`);
  } else {
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`Evidence directory (screenshots + report.json): ${evidenceDir}`);
}
