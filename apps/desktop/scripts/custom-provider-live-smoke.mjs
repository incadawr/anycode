/**
 * W4-S5 — custom provider live smoke (W5-S + пины F2/F-E), plan
 * `working-docs/build/design/w4-plan-fable-iter8.md` row W4-S5 + ruling
 * iter-9 §1c (S5 goes FIRST on BASE=e49aa85, no codex automation infra
 * needed).
 *
 * WHAT THIS PROVES, live on a REAL Electron dev instance against a REAL
 * LM Studio endpoint (`http://localhost:1234/v1`, localhost-http legal per
 * cut §9.2 — zero owner quota, zero external network):
 *
 *   W5-S   A hand-edited `custom:<id>` record + a connection pointing at it
 *          (`providerId:"custom:lmstudio"` + `activeConnectionId` — the
 *          hand-edit is the ONLY way to connect one today, see the GUI-gap
 *          finding) boots providerReady (FX4 kind-implied transport ladder,
 *          authOptional for openai-family), a real tab opens, "Fetch models"
 *          pulls the live model list from the endpoint, and a REAL turn on
 *          `openai/gpt-oss-20b` renders an assistant reply in the tab.
 *   F2     The custom provider's curated `models[]` shows up in the live
 *          composer model picker (ModelPill probe `modelItems` — FXH's
 *          `providerModelsFor`; the other two consumers, StartScreen +
 *          CodexRolloutImportDialog, share the SAME helper and are
 *          unit-covered — the composer picker is the live minimum the plan
 *          names).
 *   F-E    apiKey custody of the "Add custom provider" form
 *          (SettingsScreen.tsx `CustomProvidersSection` — the two-step flow:
 *          enter key -> Fetch models -> pick models -> Save):
 *            (1) Fetch models does NOT clear the key field;
 *            (2) Cancel + reopen -> field EMPTY;
 *            (3) successful Save + reopen -> field EMPTY;
 *            (4) a Save refusal (non-loopback http baseUrl) KEEPS the field
 *                (best-effort per plan).
 *          Forms 1-3 are GENERATED for real ("зелёный без порождения формы
 *          = ложь"): every field is typed through native-setter + dispatched
 *          `input` events on the REAL DOM (the same technique the automation
 *          facade's subagents editor/set uses), every button is a REAL
 *          `.click()`.
 *
 * DRIVER: the automation HTTP channel (`main/automation/*`, precedent
 * `provider-connections-ui-smoke.mjs`) for launch/tabs/turn/model-pill/
 * settings-dialog navigation + screenshots — plus CDP (Chromium DevTools
 * Protocol over `REMOTE_DEBUGGING_PORT`, a first-class electron-vite dev
 * lever) for the CustomProvidersSection form, which has NO automation
 * routes yet (S5 runs BEFORE the W4-F0 infra chunk by ruling iter-9; CDP
 * `Runtime.evaluate` against the real page is a read/drive layer, zero
 * production-code change). Node >=22 only (global `fetch` + global
 * `WebSocket`), ZERO npm deps — scripts/ precedent.
 *
 * ISOLATION: disposable mktemp profile (userData/db/discovery/settings/
 * secrets all app-scoped, `~/.anycode` and `~/.codex*` untouched);
 * settings.json is PRE-WRITTEN (the mandated hand-edit). Foreground only,
 * trap teardown, orphan check after teardown.
 *
 * Usage:   node apps/desktop/scripts/custom-provider-live-smoke.mjs [--keep]
 *
 * Evidence PNGs land in `working-docs/references/w4-live-evidence/s5-*.png`
 * (untracked). Each step prints `[step N] PASS/FAIL`; first FAIL tears down
 * and exits 1.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const TOTAL_STEPS = 12;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;
const EVIDENCE_DIR = join(repoRoot, "working-docs", "references", "w4-live-evidence");

const LMSTUDIO_BASE_URL = "http://localhost:1234/v1";
/**
 * The Add-form's "Fetch models" path appends a hard-coded "/v1/models"
 * (provider-ipc.ts MODELS_PATH) — it expects the base WITHOUT the "/v1"
 * segment, while the session wire (core normalizeExplicitBaseUrl + the AI
 * SDK's "/chat/completions" suffix) expects the base WITH it. The two
 * consumers of the SAME record field disagree — recorded as finding S5-2
 * (a record whose baseUrl fetches models cannot run a turn, and vice
 * versa). The form steps below use the fetch-compatible shape so the F-E
 * custody forms are genuinely generated against the live endpoint.
 */
const FORM_BASE_URL = "http://localhost:1234";
const TURN_MODEL = "openai/gpt-oss-20b";
const CURATED_MODELS = ["google/gemma-4-12b-qat", "openai/gpt-oss-20b"];
const CUSTOM_ID = "custom:lmstudio";

// ── CLI flags ──

const FLAGS = { keep: process.argv.slice(2).includes("--keep") };

// ── small process/fs helpers (provider-connections-ui-smoke.mjs precedent) ──

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readDiscoveryFile(path) {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof info?.pid === "number" &&
      typeof info?.port === "number" &&
      typeof info?.token === "string" &&
      typeof info?.startedAt === "number"
    ) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function killTree(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone.
  }
}

/** Reserves a loopback port with nothing listening (CDP port pick). */
function reserveUnusedPort() {
  return new Promise((resolveReserved, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolveReserved(port));
    });
  });
}

// ── step bookkeeping ──

class SmokeFailure extends Error {
  constructor(step, detail) {
    super(`step ${step} failed: ${detail}`);
    this.step = step;
  }
}

let passCount = 0;

function pass(step, detail) {
  passCount += 1;
  console.log(`[step ${step}] PASS ${detail ?? ""}`.trimEnd());
}

function fail(step, detail) {
  console.error(`[step ${step}] FAIL ${detail ?? ""}`.trimEnd());
  throw new SmokeFailure(step, detail);
}

function assert(step, cond, detail) {
  if (!cond) {
    fail(step, detail);
  }
}

// ── automation-channel HTTP helpers (precedent) ──

async function api(ctx, method, path, body) {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, init);
  const text = await res.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

async function apiOk(ctx, step, method, path, body) {
  let resp;
  try {
    resp = await api(ctx, method, path, body);
  } catch (err) {
    fail(step, `${method} ${path} threw: ${err?.message ?? err}`);
  }
  if (resp.status !== 200) {
    fail(step, `${method} ${path} -> HTTP ${resp.status}: ${JSON.stringify(resp.body)}`);
  }
  return resp.body;
}

async function waitUntilTab(ctx, step, tabId, until, timeoutMs) {
  const body = { tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} for tab ${tabId} did not match: ${JSON.stringify(result)}`);
  }
  return result;
}

async function pollUntil(timeoutMs, pollMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(pollMs);
  }
}

async function waitForFacade(ctx, step, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    let resp;
    try {
      resp = await api(ctx, "GET", "/state?tail=0");
    } catch {
      resp = { status: 0 };
    }
    if (resp.status === 200) {
      return;
    }
    if (Date.now() - start >= timeoutMs) {
      fail(step, `renderer facade never installed within ${timeoutMs}ms (last GET /state -> HTTP ${resp.status})`);
    }
    await sleep(150);
  }
}

/** Best-effort PNG evidence into the untracked w4-live-evidence dir. */
async function saveScreenshot(ctx, name) {
  await sleep(400);
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[custom-provider-live-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return null;
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
    return filePath;
  } catch (err) {
    console.warn(`[custom-provider-live-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
    return null;
  }
}

function readJsonDisk(step, path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(step, `failed to read/parse ${label} at ${path}: ${err?.message ?? err}`);
  }
}

// ── CDP client (Node 22 global WebSocket, zero deps) ──

async function cdpConnect(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
      if (target) break;
    } catch {
      // CDP endpoint not up yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`no CDP page target on port ${port} within ${timeoutMs}ms`);
    }
    await sleep(400);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = () => resolveOpen();
    ws.onerror = () => rejectOpen(new Error("CDP websocket failed to open"));
  });
  const pending = new Map();
  let nextId = 1;
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: resolveMsg } = pending.get(msg.id);
      pending.delete(msg.id);
      resolveMsg(msg);
    }
  };
  return {
    /** Evaluates `expression` in the page, returns the JSON value. Throws on a page-side exception. */
    async eval(expression) {
      const id = nextId++;
      const msg = await new Promise((resolveMsg, rejectMsg) => {
        pending.set(id, { resolve: resolveMsg });
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rejectMsg(new Error("CDP eval timed out (20s)"));
          }
        }, 20_000);
      });
      if (msg.error) {
        throw new Error(`CDP protocol error: ${JSON.stringify(msg.error)}`);
      }
      if (msg.result?.exceptionDetails) {
        throw new Error(`CDP page exception: ${JSON.stringify(msg.result.exceptionDetails).slice(0, 600)}`);
      }
      return msg.result?.result?.value;
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed.
      }
    },
  };
}

// ── browser-side expressions for CustomProvidersSection (SettingsScreen.tsx) ──
//
// The section is located by its rendered `.settings-section-title` text
// ("Custom providers"); fields by their `.settings-field-label` text — the
// same structural-identification approach the facade's subagents editor/set
// documents ("no aria-label exists on these fields").

const FIND_SECTION_JS = `
  const sec = Array.from(document.querySelectorAll(".settings-section")).find(
    (s) => (s.querySelector(".settings-section-title")?.textContent ?? "").trim() === "Custom providers",
  );
`;

function cpsStateExpr() {
  return `(() => {
    ${FIND_SECTION_JS}
    if (!sec) return { present: false };
    const fieldEl = (label) => {
      const fields = Array.from(sec.querySelectorAll("label.settings-field"));
      const f = fields.find((el) => (el.querySelector(".settings-field-label")?.textContent ?? "").trim() === label);
      return f ? f.querySelector("input, select") : null;
    };
    const val = (label) => {
      const el = fieldEl(label);
      return el ? el.value : null;
    };
    const err = sec.querySelector('.settings-notice[role="alert"]');
    return {
      present: true,
      formOpen: fieldEl("API key") !== null,
      buttons: Array.from(sec.querySelectorAll("button")).map((b) => b.textContent.trim()),
      rows: Array.from(sec.querySelectorAll('ul[aria-label="Custom providers"] li')).map((li) => li.textContent.trim()),
      fetchedModels: Array.from(sec.querySelectorAll("fieldset label")).map((l) => l.textContent.trim()),
      name: val("Name"),
      baseUrl: val("Base URL"),
      kind: val("Kind"),
      apiKey: val("API key"),
      errorText: err ? err.textContent.trim() : null,
    };
  })()`;
}

function cpsClickExpr(buttonText) {
  return `(() => {
    ${FIND_SECTION_JS}
    if (!sec) return { ok: false, reason: "no_section" };
    const btn = Array.from(sec.querySelectorAll("button")).find((b) => b.textContent.trim() === ${JSON.stringify(buttonText)});
    if (!btn) return { ok: false, reason: "no_button" };
    if (btn.disabled) return { ok: false, reason: "disabled" };
    btn.click();
    return { ok: true };
  })()`;
}

/** React-compatible field write: native value setter + dispatched input/change event. */
function cpsSetExpr(label, value) {
  return `(() => {
    ${FIND_SECTION_JS}
    if (!sec) return { ok: false, reason: "no_section" };
    const fields = Array.from(sec.querySelectorAll("label.settings-field"));
    const f = fields.find((el) => (el.querySelector(".settings-field-label")?.textContent ?? "").trim() === ${JSON.stringify(label)});
    if (!f) return { ok: false, reason: "no_field" };
    const input = f.querySelector("input, select");
    if (!input) return { ok: false, reason: "no_input" };
    const isSelect = input.tagName === "SELECT";
    const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(isSelect ? "change" : "input", { bubbles: true }));
    return { ok: true };
  })()`;
}

async function cdpAction(cdp, step, expr, what) {
  const result = await cdp.eval(expr);
  assert(step, result?.ok === true, `${what} refused: ${JSON.stringify(result)}`);
  return result;
}

async function pollCpsState(cdp, step, predicate, timeoutMs = 15_000) {
  let last = null;
  const result = await pollUntil(timeoutMs, 200, async () => {
    const state = await cdp.eval(cpsStateExpr());
    last = state;
    return state?.present === true && predicate(state) ? state : undefined;
  });
  assert(step, result !== null, `CustomProvidersSection predicate never matched within ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
  return result;
}

// ── the hand-edited settings.json (THE mandated setup: cut §13.2-S / plan W4-S5) ──

function handEditedSettings() {
  return {
    version: 2,
    provider: {
      activeConnectionId: "conn-lmstudio",
      connections: [
        {
          id: "conn-lmstudio",
          providerId: CUSTOM_ID,
          label: "LM Studio (hand-edit)",
          model: TURN_MODEL,
        },
      ],
      custom: [
        {
          id: CUSTOM_ID,
          name: "LM Studio",
          baseUrl: LMSTUDIO_BASE_URL,
          kind: "openai-compatible",
          models: CURATED_MODELS,
        },
      ],
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

// ── launch / teardown ──

async function launchApp(step) {
  const profile = mkdtempSync(join(tmpdir(), "anycode-customprov-smoke-profile-"));
  const cdpPort = await reserveUnusedPort();
  const ctx = {
    profile,
    cdpPort,
    profileUserDataDir: join(profile, "user-data"),
    profileDbPath: join(profile, "db.sqlite"),
    profileAutomationInfo: join(profile, "automation.json"),
    settingsPath: join(profile, "settings.json"),
    secretsPath: join(profile, "secrets.json"),
    port: undefined,
    token: undefined,
    appPid: null,
    child: null,
    cdp: null,
    workspace: null,
    tabId: null,
    teardownPromise: null,
  };

  // THE hand-edit (plan W4-S5 mandate): the custom record + the connection
  // that activates it are written BEFORE first boot — there is no GUI path
  // that creates this connection (the GUI-gap finding this run documents).
  writeFileSync(ctx.settingsPath, JSON.stringify(handEditedSettings(), null, 2));

  const t0 = Date.now();
  const env = {
    ...process.env,
    ANYCODE_AUTOMATION: "1",
    ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
    ANYCODE_DB_PATH: ctx.profileDbPath,
    ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    ANYCODE_SETTINGS_PATH: ctx.settingsPath,
    ANYCODE_SECRETS_PATH: ctx.secretsPath,
    // electron-vite dev lever: appends --remote-debugging-port=<port> to the
    // Electron argv (dist/chunks/lib-*.js reads this env var under isDev).
    REMOTE_DEBUGGING_PORT: String(cdpPort),
  };
  // No ANYCODE_API_KEY/MODEL/BASE_URL: readiness must come PURELY from the
  // hand-edited custom record route (FX4 kind-implied transport ladder +
  // authOptional) — an env credential would mask a broken custom route.
  delete env.ANYCODE_API_KEY;
  delete env.ANYCODE_MODEL;
  delete env.ANYCODE_BASE_URL;

  const child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  ctx.child = child;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let info = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(step, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
    if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
      info = candidate;
      break;
    }
    await sleep(500);
  }
  if (info === null) {
    fail(step, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo}`);
  }
  ctx.port = info.port;
  ctx.token = info.token;
  ctx.appPid = info.pid;
  await waitForFacade(ctx, step);
  pass(step, `app launched (pid=${info.pid}) on automation port ${info.port}, CDP port ${cdpPort}, profile=${profile} (settings.json hand-edited pre-boot: ${CUSTOM_ID} -> ${LMSTUDIO_BASE_URL})`);
  return ctx;
}

function teardown(ctx) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = teardownApp(ctx);
  }
  return ctx.teardownPromise;
}

async function teardownApp(ctx) {
  if (ctx.cdp) {
    ctx.cdp.close();
    ctx.cdp = null;
  }
  if (ctx.port && ctx.token && ctx.child) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort.
    }
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[custom-provider-live-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[custom-provider-live-smoke] still alive after SIGTERM — SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }
  const dirs = [ctx.profile, ctx.workspace];
  for (const dir of dirs) {
    if (dir && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[custom-provider-live-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[custom-provider-live-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Steps
// ══════════════════════════════════════════════════════════════════════════

/** Pre-flight: LM Studio must be alive and offering the turn model (external precondition — SKIP-class if absent). */
async function step0Preflight() {
  let models = [];
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(5_000) });
    const parsed = await res.json();
    models = (parsed?.data ?? []).map((m) => m.id);
  } catch (err) {
    console.error(`SKIP: LM Studio unreachable at ${LMSTUDIO_BASE_URL} (${err?.message ?? err}) — external precondition absent`);
    process.exit(2);
  }
  if (!models.includes(TURN_MODEL)) {
    console.error(`SKIP: LM Studio does not offer ${TURN_MODEL} (has: ${JSON.stringify(models)})`);
    process.exit(2);
  }
  console.log(`[preflight] LM Studio alive, offers ${JSON.stringify(models)}`);
}

async function step2ReadyNoWelcome(ctx) {
  // providerReady must flip true purely off the hand-edited custom route:
  // WelcomeScreen (the not-ready empty state) must NOT mount — its embedded
  // drawer would read drawer.open=true with the Settings grid unmounted.
  const state = await pollUntil(20_000, 300, async () => {
    const resp = await api(ctx, "GET", "/settings/provider");
    return resp.status === 200 ? resp.body : undefined;
  });
  assert(2, state !== null, "GET /settings/provider never answered");
  assert(
    2,
    state.drawer.open === false,
    `WelcomeScreen mounted (embedded drawer open) — providerReady did NOT flip off the hand-edited custom:* route (FX4 readiness gate broken): ${JSON.stringify(state.drawer)}`,
  );
  pass(2, `providerReady flipped purely off the hand-edited ${CUSTOM_ID} record (openai-compatible kind => authOptional, no vault key, no env credential) — no WelcomeScreen`);
}

async function step3CreateTab(ctx) {
  ctx.workspace = mkdtempSync(join(tmpdir(), "anycode-customprov-smoke-ws-"));
  writeFileSync(join(ctx.workspace, "seed.txt"), "custom-provider live smoke workspace\n");
  const created = await apiOk(ctx, 3, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(3, created.ok === true, `tab creation failed: ${JSON.stringify(created)}`);
  ctx.tabId = created.tabId;
  await waitUntilTab(ctx, 3, ctx.tabId, { connection: "ready" }, 60_000);
  pass(3, `tab ${ctx.tabId} ready — host fork booted on the custom provider's env (baseUrl=${LMSTUDIO_BASE_URL}, model=${TURN_MODEL})`);
}

async function step4PinF2ComposerPicker(ctx) {
  const pill = await pollUntil(15_000, 300, async () => {
    const resp = await api(ctx, "GET", `/tabs/${ctx.tabId}/model-pill`);
    return resp.status === 200 && resp.body?.ok === true && resp.body.present === true ? resp.body : undefined;
  });
  assert(4, pill !== null, "model pill never became present (model null pre-host_ready?)");
  assert(4, pill.currentModel === TURN_MODEL, `expected currentModel=${TURN_MODEL}, got ${pill.currentModel}`);

  // KNOWN PROBE DRIFT (recorded as a finding, W4-findings-S5.md S5-1): the
  // automation probe's modelItems (automation.ts:4092) still derives models
  // with the PRE-FXH expression `catalog.find(id)?.models` — no
  // `provider.custom` fallback, no pinned-connection target — so for a
  // `custom:*` provider it reports only the current model even when the real
  // popover lists the whole curated set. The load-bearing F2 assert below
  // therefore reads the REAL rendered popover DOM via CDP (the product's own
  // `.model-pill-item` nodes, ModelPill.tsx page==="model"), which is
  // STRICTLY more live than the probe. The probe reading is logged for the
  // drift record, not asserted on.
  const probeItemIds = (pill.modelItems ?? []).map((m) => m.id);
  console.log(`           [probe-drift record] automation model-pill probe offers: ${JSON.stringify(probeItemIds)}`);

  ctx.cdp = await cdpConnect(ctx.cdpPort);
  const opened = await ctx.cdp.eval(`(() => {
    const chip = document.querySelector(".model-pill-chip");
    if (!chip) return { ok: false, reason: "no_chip" };
    chip.click();
    return { ok: true };
  })()`);
  assert(4, opened?.ok === true, `could not open the model-pill popover: ${JSON.stringify(opened)}`);
  const navigated = await pollUntil(5_000, 150, async () => {
    const r = await ctx.cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll(".model-pill-row"));
      const modelRow = rows.find((b) => b.querySelector(".model-pill-row-name")?.textContent.trim() === "Model");
      if (!modelRow) return null;
      modelRow.click();
      return true;
    })()`);
    return r === true ? true : undefined;
  });
  assert(4, navigated === true, "popover root's Model row never appeared");
  const domItems = await pollUntil(5_000, 150, async () => {
    const items = await ctx.cdp.eval(`(() => {
      const els = Array.from(document.querySelectorAll(".model-pill-item .model-pill-item-name"));
      return els.map((el) => el.textContent.trim());
    })()`);
    return Array.isArray(items) && items.length > 0 ? items : undefined;
  });
  assert(4, domItems !== null, "model page never rendered any .model-pill-item");
  for (const curated of CURATED_MODELS) {
    assert(
      4,
      domItems.includes(curated),
      `PIN F2 RED: curated custom-provider model "${curated}" missing from the REAL rendered composer picker (providerModelsFor custom fallback broken in the PRODUCT); popover lists: ${JSON.stringify(domItems)}`,
    );
  }
  await saveScreenshot(ctx, "s5-01-composer-model-picker");
  // Close the popover (Escape through the popover's own keydown handler) so
  // the composer is clean for the turn.
  await ctx.cdp.eval(`(() => {
    const pop = document.querySelector(".model-pill-popover");
    if (pop) pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  pass(
    4,
    `PIN F2: the REAL rendered composer picker (ModelPill popover, model page) lists the custom provider's curated models ${JSON.stringify(domItems)} — providerModelsFor's custom:<id> fallback proven live in the product DOM (probe drift recorded separately as finding S5-1)`,
  );
}

async function step5LiveTurn(ctx) {
  const sendResult = await apiOk(ctx, 5, "POST", `/tabs/${ctx.tabId}/prompt`, {
    text: "What is 7*6? Reply with just the number.",
  });
  assert(5, sendResult.ok === true, `prompt send rejected: ${JSON.stringify(sendResult)}`);
  await waitUntilTab(ctx, 5, ctx.tabId, { turnStatus: "running" }, 30_000);
  await waitUntilTab(ctx, 5, ctx.tabId, { turnStatus: "idle" }, 240_000);

  const state = await apiOk(ctx, 5, "GET", `/state/${ctx.tabId}`);
  const blocks = state?.snapshot?.states?.[ctx.tabId]?.transcript ?? [];
  const errors = blocks.filter((b) => b.kind === "error");
  assert(5, errors.length === 0, `turn produced error block(s): ${JSON.stringify(errors).slice(0, 800)}`);
  const answer = blocks.filter((b) => b.kind === "assistant_text").at(-1);
  assert(5, answer !== undefined, `no assistant_text block in transcript: ${JSON.stringify(blocks.slice(-5)).slice(0, 800)}`);
  assert(
    5,
    /42/.test(answer.text),
    `assistant reply does not contain the expected answer 42 — got: ${JSON.stringify(answer.text).slice(0, 300)}`,
  );
  await saveScreenshot(ctx, "s5-02-live-turn-response");
  pass(5, `W5-S live turn on ${TURN_MODEL} via ${LMSTUDIO_BASE_URL}: assistant replied ${JSON.stringify(answer.text).slice(0, 80)} — rendered in the real tab, zero owner quota spent`);
}

async function step6OpenSettingsCustomSection(ctx) {
  const openResult = await apiOk(ctx, 6, "POST", "/settings/open", {});
  assert(6, openResult.ok === true, `settings/open rejected: ${JSON.stringify(openResult)}`);
  const paneResult = await apiOk(ctx, 6, "POST", "/settings/pane", { paneId: "provider" });
  assert(6, paneResult.ok === true, `settings/pane provider rejected: ${JSON.stringify(paneResult)}`);

  const state = await pollCpsState(ctx.cdp, 6, (s) => s.present === true, 20_000);
  assert(6, state.formOpen === false, `expected the add-form closed on first open, got formOpen=${state.formOpen}`);
  assert(
    6,
    state.rows.some((r) => r.includes("LM Studio")),
    `hand-edited custom record not listed in the Custom providers section: ${JSON.stringify(state.rows)}`,
  );
  await saveScreenshot(ctx, "s5-03-custom-providers-section");
  pass(6, `Settings -> Provider pane: Custom providers section lists the hand-edited record (${JSON.stringify(state.rows)})`);
}

async function step7PinFE1FetchKeepsKey(ctx) {
  const cdp = ctx.cdp;
  // FORM 1 (generated for real): open the add form, type key + baseUrl,
  // click the real "Fetch models" button (a REAL main-process GET against
  // the live endpoint), assert the key field SURVIVES the fetch.
  await cdpAction(cdp, 7, cpsClickExpr("+ Add custom provider"), `click "+ Add custom provider"`);
  await pollCpsState(cdp, 7, (s) => s.formOpen === true);
  await cdpAction(cdp, 7, cpsSetExpr("Name", "FE Custody One"), "set Name");
  await cdpAction(cdp, 7, cpsSetExpr("Base URL", FORM_BASE_URL), "set Base URL (fetch-compatible shape, see S5-2 note)");
  await cdpAction(cdp, 7, cpsSetExpr("API key", "sk-test-custody-fe1"), "set API key");
  const preFetch = await cdp.eval(cpsStateExpr());
  assert(7, preFetch.apiKey === "sk-test-custody-fe1", `typed key did not land in the field: ${JSON.stringify(preFetch.apiKey)}`);
  await cdpAction(cdp, 7, cpsClickExpr("Fetch models"), `click "Fetch models"`);
  const fetched = await pollCpsState(cdp, 7, (s) => s.fetchedModels.length > 0, 20_000);
  assert(
    7,
    fetched.fetchedModels.includes(TURN_MODEL),
    `live fetch did not surface ${TURN_MODEL} — got ${JSON.stringify(fetched.fetchedModels)}`,
  );
  assert(
    7,
    fetched.apiKey === "sk-test-custody-fe1",
    `PIN F-E(1) RED: "Fetch models" cleared the apiKey field (two-step flow custody broken) — field now: ${JSON.stringify(fetched.apiKey)}`,
  );
  await saveScreenshot(ctx, "s5-04-fe1-fetch-models-keeps-key");
  pass(
    7,
    `PIN F-E(1): form GENERATED, live fetch pulled ${JSON.stringify(fetched.fetchedModels)} from ${FORM_BASE_URL}/v1/models, apiKey field still holds the typed value after Fetch`,
  );
}

async function step8PinFE2CancelClears(ctx) {
  const cdp = ctx.cdp;
  // FORM 2: Cancel the (still-filled) form, reopen, assert EVERY field is empty.
  await cdpAction(cdp, 8, cpsClickExpr("Cancel"), `click "Cancel"`);
  await pollCpsState(cdp, 8, (s) => s.formOpen === false);
  await cdpAction(cdp, 8, cpsClickExpr("+ Add custom provider"), `reopen the add form`);
  const reopened = await pollCpsState(cdp, 8, (s) => s.formOpen === true);
  assert(
    8,
    reopened.apiKey === "",
    `PIN F-E(2) RED: apiKey survived Cancel->reopen (resetForm custody broken): ${JSON.stringify(reopened.apiKey)}`,
  );
  assert(8, reopened.name === "" && reopened.baseUrl === "", `Cancel left stale metadata: name=${JSON.stringify(reopened.name)} baseUrl=${JSON.stringify(reopened.baseUrl)}`);
  assert(8, reopened.fetchedModels.length === 0, `Cancel left a stale fetched-models list: ${JSON.stringify(reopened.fetchedModels)}`);
  await saveScreenshot(ctx, "s5-05-fe2-cancel-clears");
  pass(8, `PIN F-E(2): Cancel -> reopen: apiKey/name/baseUrl/fetched-models all EMPTY`);
}

async function step9PinFE3SaveClears(ctx) {
  const cdp = ctx.cdp;
  // FORM 3: full two-step create (key -> fetch -> save), then reopen: empty.
  await cdpAction(cdp, 9, cpsSetExpr("Name", "FE Custody Save"), "set Name");
  await cdpAction(cdp, 9, cpsSetExpr("Base URL", FORM_BASE_URL), "set Base URL (fetch-compatible shape, see S5-2 note)");
  await cdpAction(cdp, 9, cpsSetExpr("API key", "sk-test-custody-fe3"), "set API key");
  await cdpAction(cdp, 9, cpsClickExpr("Fetch models"), `click "Fetch models"`);
  await pollCpsState(cdp, 9, (s) => s.fetchedModels.length > 0, 20_000);
  await cdpAction(cdp, 9, cpsClickExpr("Save"), `click "Save"`);
  const saved = await pollCpsState(cdp, 9, (s) => s.formOpen === false && s.rows.some((r) => r.includes("FE Custody Save")), 20_000);
  await cdpAction(cdp, 9, cpsClickExpr("+ Add custom provider"), `reopen after save`);
  const reopened = await pollCpsState(cdp, 9, (s) => s.formOpen === true);
  assert(
    9,
    reopened.apiKey === "",
    `PIN F-E(3) RED: apiKey survived a successful Save->reopen: ${JSON.stringify(reopened.apiKey)}`,
  );
  // Close the form so step 10 starts from a clean slate.
  await cdpAction(cdp, 9, cpsClickExpr("Cancel"), `close the empty form`);

  // Disk custody: the created record is in settings.json, its key is in the
  // vault as CIPHERTEXT under provider.custom:<uuid>.apiKey, and NO plaintext
  // sk-test-custody-* ever landed in either file.
  const settingsDisk = readJsonDisk(9, ctx.settingsPath, "settings.json");
  const customList = settingsDisk?.provider?.custom ?? [];
  const created = customList.find((c) => c.name === "FE Custody Save");
  assert(9, created !== undefined, `saved record missing from settings.json custom[]: ${JSON.stringify(customList.map((c) => c.name))}`);
  assert(9, /^custom:/.test(created.id), `created record id not custom:-prefixed: ${created.id}`);
  const secretsDisk = readJsonDisk(9, ctx.secretsPath, "secrets.json");
  const secretKeys = Object.keys(secretsDisk?.entries ?? {});
  assert(
    9,
    secretKeys.includes(`provider.${created.id}.apiKey`),
    `vault key provider.${created.id}.apiKey missing; keys: ${JSON.stringify(secretKeys)}`,
  );
  const settingsRaw = readFileSync(ctx.settingsPath, "utf8");
  const secretsRaw = readFileSync(ctx.secretsPath, "utf8");
  assert(9, !settingsRaw.includes("sk-test-custody"), "PLAINTEXT KEY LEAKED into settings.json");
  assert(9, !secretsRaw.includes("sk-test-custody"), "PLAINTEXT KEY LEAKED into secrets.json (vault did not encrypt)");
  await saveScreenshot(ctx, "s5-06-fe3-saved-row");
  pass(
    9,
    `PIN F-E(3): Save created "${created.id}" (row ${JSON.stringify(saved.rows.at(-1))}), key VAULTED (ciphertext under provider.${created.id}.apiKey), reopened form EMPTY, zero plaintext on disk`,
  );
}

async function step10PinFE4RefusalKeeps(ctx) {
  const cdp = ctx.cdp;
  // FORM 4 (best-effort per plan): a save-refusal must KEEP the typed key so
  // the user can fix the input without retyping it. Non-loopback http baseUrl
  // is refused by isAllowedCustomProviderUrl (cut §9.2) at create.
  await cdpAction(cdp, 10, cpsClickExpr("+ Add custom provider"), `open form for refusal case`);
  await pollCpsState(cdp, 10, (s) => s.formOpen === true);
  await cdpAction(cdp, 10, cpsSetExpr("Name", "FE Custody Refused"), "set Name");
  await cdpAction(cdp, 10, cpsSetExpr("Base URL", "http://192.0.2.10/v1"), "set refused Base URL (http non-loopback, TEST-NET)");
  await cdpAction(cdp, 10, cpsSetExpr("API key", "sk-test-custody-fe4"), "set API key");
  await cdpAction(cdp, 10, cpsClickExpr("Save"), `click "Save" (expecting refusal)`);
  const refused = await pollCpsState(cdp, 10, (s) => s.errorText !== null, 15_000);
  assert(10, refused.formOpen === true, `refusal CLOSED the form (it must stay open for retry)`);
  assert(
    10,
    refused.apiKey === "sk-test-custody-fe4",
    `PIN F-E(4) RED: a Save refusal cleared the apiKey field: ${JSON.stringify(refused.apiKey)}`,
  );
  await saveScreenshot(ctx, "s5-07-fe4-refusal-keeps-key");
  await cdpAction(cdp, 10, cpsClickExpr("Cancel"), `close the refused form`);
  // The refused record must have left ZERO trace on disk.
  const settingsDisk = readJsonDisk(10, ctx.settingsPath, "settings.json");
  assert(
    10,
    !(settingsDisk?.provider?.custom ?? []).some((c) => c.name === "FE Custody Refused"),
    "a REFUSED create still persisted a record",
  );
  pass(10, `PIN F-E(4): Save refusal (error: ${JSON.stringify(refused.errorText)}) kept the typed key in the field, persisted NOTHING`);
}

async function step11GuiGapProbe(ctx) {
  // GUI-gap (documented owner-residual, ruling iter-9 residual (в)): the
  // connections drawer is the ONLY place a user can pick a provider for a
  // connection — probe whether the saved custom provider is offered there.
  const addResult = await apiOk(ctx, 11, "POST", "/settings/provider/add", {});
  assert(11, addResult.ok === true, `provider/add rejected: ${JSON.stringify(addResult)}`);
  const options = await ctx.cdp.eval(`(() => {
    const selects = Array.from(document.querySelectorAll("select"));
    const all = selects.map((s) => Array.from(s.options).map((o) => o.value));
    return all.find((opts) => opts.includes("anthropic")) ?? null;
  })()`);
  const closeResult = await apiOk(ctx, 11, "POST", "/settings/provider/drawer/close", {});
  assert(11, closeResult.ok === true, `drawer/close rejected: ${JSON.stringify(closeResult)}`);
  assert(11, options !== null, "could not locate the drawer's provider <select>");
  const offersCustom = options.some((v) => v.startsWith("custom:"));
  console.log(
    `           [gui-gap probe] drawer provider options: ${JSON.stringify(options)} — custom:* offered: ${offersCustom}`,
  );
  pass(
    11,
    offersCustom
      ? `drawer DOES offer custom:* providers (GUI-gap narrower than ruled — see findings)`
      : `GUI-gap CONFIRMED live: the connection drawer's provider <select> offers only builtin catalog ids ${JSON.stringify(options)} — a saved custom provider cannot be connected/activated from the GUI (hand-edit settings.json is the only path; documented as owner-residual)`,
  );
}

async function step12TeardownAndOrphans(ctx) {
  await teardown(ctx);
  // Orphan check with a settle window: nothing may still reference the
  // disposable profile dir after the app is gone.
  await sleep(3_000);
  let orphans = "";
  try {
    orphans = execFileSync("pgrep", ["-f", ctx.profile], { encoding: "utf8" }).trim();
  } catch (err) {
    if (err.status === 1) {
      orphans = ""; // no matches — the good case.
    } else {
      throw err;
    }
  }
  assert(12, orphans === "", `ORPHANS after teardown+settle: pids ${orphans.split("\n").join(", ")}`);
  pass(12, `teardown clean — orphan=0 (no process references ${ctx.profile})`);
}

// ── orchestration ──

function installSignalTeardown(getCtx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[custom-provider-live-smoke] received ${signal} — tearing down…`);
    const ctx = getCtx();
    (ctx ? teardown(ctx) : Promise.resolve())
      .catch((err) => console.error(`[custom-provider-live-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  await step0Preflight();

  let currentCtx = null;
  installSignalTeardown(() => currentCtx);

  let failedStep = null;
  let ctx = null;
  try {
    ctx = await launchApp(1);
    currentCtx = ctx;
    await step2ReadyNoWelcome(ctx);
    await step3CreateTab(ctx);
    await step4PinF2ComposerPicker(ctx);
    await step5LiveTurn(ctx);
    await step6OpenSettingsCustomSection(ctx);
    await step7PinFE1FetchKeepsKey(ctx);
    await step8PinFE2CancelClears(ctx);
    await step9PinFE3SaveClears(ctx);
    await step10PinFE4RefusalKeeps(ctx);
    await step11GuiGapProbe(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[custom-provider-live-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }
  if (ctx) {
    try {
      await step12TeardownAndOrphans(ctx);
    } catch (err) {
      failedStep = failedStep ?? (err instanceof SmokeFailure ? err.step : "unknown (teardown)");
    }
    currentCtx = null;
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[custom-provider-live-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[custom-provider-live-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
