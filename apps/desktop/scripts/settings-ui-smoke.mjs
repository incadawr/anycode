/**
 * Live GUI smoke for P7.16 F11 (design/slice-P7.16-cut.md §5 W5): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s settings routes)
 * exercising the fullscreen Settings page + human permissions editor DoD:
 * (i) 7-pane rail with "provider" as the default active pane, (ii) rules
 * grouped-by-tool + removable through the real form, (iii) Bash pattern
 * sanitization at rule-CREATE time proven through the real manual-add form
 * (not the raw store call).
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted verbatim from
 * `sidebar-ui-smoke.mjs` (same disposable-profile discipline), EXCEPT this
 * script deliberately does NOT override `ANYCODE_SETTINGS_PATH` /
 * `ANYCODE_SECRETS_PATH` (design §5 W5: "the smoke runs against the real
 * `~/.anycode/settings.json`" — sanitization/grouping/removal must be proven
 * against the owner's actual persisted rules, not a seeded throwaway file).
 * `providerReady` (main/host-env.ts:269) only depends on settings.json's
 * `provider.id`/`model` + secrets.json's vault entry — NOT on the (still
 * isolated) userData/db/automation-info paths — so the app boots straight
 * into the zero-tab shell (main/index.ts: no ANYCODE_WORKSPACE => no open-tab
 * dialog, no auto-tab) with the sidebar settings gear present. This smoke
 * never creates a tab; it only drives the settings dialog.
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`) — a NEW sibling of sidebar-ui-smoke.mjs, not an edit.
 *
 * Usage:   node apps/desktop/scripts/settings-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then does NOT quit an app it did not launch.
 *   --keep         Do not delete the per-run automation profile dir on exit
 *                   (debugging). Never affects real-settings hygiene cleanup,
 *                   which always runs (§ hygiene below).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * HYGIENE (critical, design §5 W5): every rule this script adds to the REAL
 * `~/.anycode/settings.json` is removed in a try/finally, even on mid-run
 * failure — including the sanitized `node *` rule from step 3. Nonce-suffixed
 * literals are used where the assertion allows it (step 4's
 * "git-smoke-nonce *"); step 3's pattern is fixed by the design table (it
 * must sanitize to exactly "node *" to prove the classifier), so its cleanup
 * is tracked explicitly rather than derived from a nonce. This script NEVER
 * removes a rule it did not itself add — before touching the Bash/WebFetch
 * groups it snapshots their prior contents and aborts rather than risking a
 * collision if an identical rule is already present.
 *
 * Each of the 7 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down (app + settings-rule cleanup) and exits 1.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// The two rules this smoke adds to Bash: the env-prefixed pattern the design
// table (§4.2) requires sanitizing down to exactly "node *" (step 3), and a
// nonce-suffixed literal (step 4) used only to prove grouping (2 rules, 1
// group) — not itself testing sanitization.
const BASH_RAW_PATTERN = 'OUT="/tmp/smoke" node *';
const BASH_SANITIZED_PATTERN = "node *";
const BASH_NONCE_PATTERN = "git-smoke-nonce *";
const WEBFETCH_TOOL = "WebFetch";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { attach: false, keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--attach") {
      flags.attach = true;
    } else if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else {
      console.warn(`[settings-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from sidebar-ui-smoke.mjs) ──

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

/** Kills the whole spawn tree, not just the direct child (detached -> own process group on POSIX). */
function killTree(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone — nothing to do.
  }
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

// ── HTTP helpers against the automation channel (README.md routes) ──

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

/** `api()` + hard-fail on transport error or non-200 (the request never even reached the facade). */
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

/** A POST action expected to succeed at the facade level too (`{ok:true, ...}`). */
async function apiAction(ctx, step, path, body) {
  const result = await apiOk(ctx, step, "POST", path, body);
  if (result?.ok !== true) {
    fail(step, `POST ${path} rejected: ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Poll `GET /state` until the renderer facade has finished installing (DEV
 * dynamic import races the page load) — same readiness signal as every other
 * `*-ui-smoke.mjs` in this directory.
 */
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

async function getSettings(ctx, step) {
  return apiOk(ctx, step, "GET", "/settings");
}

function findGroup(settings, toolName) {
  return settings?.permissions?.groups?.find((g) => g.toolName === toolName);
}

// ── step 1: launch (or attach to) the dev app, open Settings, assert DoD (i) ──

async function step1LaunchAndOpen(ctx) {
  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(1, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(1, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
  } else {
    // Per-run disposable profile for userData/db/discovery ONLY — deliberately
    // does NOT set ANYCODE_SETTINGS_PATH/ANYCODE_SECRETS_PATH (see file
    // header): this smoke must read/write the REAL ~/.anycode/settings.json
    // and the real secrets vault so `providerReady` is true from the owner's
    // actual configured provider, and so DoD (ii)/(iii) are proven against
    // real persisted rules, not a seeded throwaway file.
    const profile = mkdtempSync(join(tmpdir(), "anycode-settings-smoke-profile-"));
    ctx.profile = profile;
    ctx.profileUserDataDir = join(profile, "user-data");
    ctx.profileDbPath = join(profile, "db.sqlite");
    ctx.profileAutomationInfo = join(profile, "automation.json");

    const t0 = Date.now();
    const env = {
      ...process.env,
      ANYCODE_AUTOMATION: "1",
      ANYCODE_USER_DATA_DIR: ctx.profileUserDataDir,
      ANYCODE_DB_PATH: ctx.profileDbPath,
      ANYCODE_AUTOMATION_INFO: ctx.profileAutomationInfo,
    };
    if (FLAGS.port !== undefined) {
      env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
    }

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
        fail(1, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
      }
      const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
      if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
        info = candidate;
        break;
      }
      await sleep(500);
    }
    if (info === null) {
      fail(1, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
  }

  await waitForFacade(ctx, 1);

  const opened = await apiAction(ctx, 1, "/settings/open", {});
  assert(1, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);

  const state = await getSettings(ctx, 1);
  assert(1, state.open === true, `expected open===true, got ${JSON.stringify(state.open)}`);
  assert(1, state.activePane === "provider", `expected activePane==="provider", got ${JSON.stringify(state.activePane)}`);
  assert(1, Array.isArray(state.panesVisible) && state.panesVisible.length === 7, `expected panesVisible.length===7, got ${JSON.stringify(state.panesVisible)}`);

  pass(1, `settings opened; activePane="provider"; panesVisible=${JSON.stringify(state.panesVisible)}`);
}

// ── step 2: switch to the permissions pane ──

async function step2SelectPermissionsPane(ctx) {
  const result = await apiAction(ctx, 2, "/settings/pane", { paneId: "permissions" });
  assert(2, result.ok === true, `settings/pane rejected: ${JSON.stringify(result)}`);

  const state = await getSettings(ctx, 2);
  assert(2, state.activePane === "permissions", `expected activePane==="permissions", got ${JSON.stringify(state.activePane)}`);

  pass(2, "pane switched to permissions");
}

// ── step 3: add a Bash rule via the env-prefixed pattern -> DoD (iii), sanitization through the real form ──

async function step3AddSanitizedBashRule(ctx) {
  // Snapshot-then-add hygiene guard (design §5 W5): never delete a rule this
  // script did not itself add. If the sanitized pattern is ALREADY present in
  // the real settings.json before we add anything, abort rather than risk
  // clobbering (or later spuriously removing) a rule the owner created.
  const before = await getSettings(ctx, 3);
  const preexisting = findGroup(before, "Bash")?.rules?.some((r) => r.pattern === BASH_SANITIZED_PATTERN);
  assert(
    3,
    !preexisting,
    `refusing to run: a Bash rule with pattern "${BASH_SANITIZED_PATTERN}" already exists in the real settings.json — this smoke cannot safely distinguish it from its own addition`,
  );
  // Baseline for step 4's grouping assertion: the real settings.json already
  // carries the owner's own Bash rules, so "2 rules" (design §5 W5 step 4)
  // means "2 MORE than whatever was already here", not "2 total".
  ctx.bashRuleCountBaseline = findGroup(before, "Bash")?.rules?.length ?? 0;

  const added = await apiAction(ctx, 3, "/settings/permissions/add", { toolName: "Bash", pattern: BASH_RAW_PATTERN });
  assert(3, added.ok === true, `permissions/add (sanitized) rejected: ${JSON.stringify(added)}`);
  ctx.addedBashSanitized = true; // teardown must remove this even if a later step throws

  const state = await getSettings(ctx, 3);
  const group = findGroup(state, "Bash");
  assert(3, group !== undefined, `expected a Bash group after adding, got groups=${JSON.stringify(state.permissions?.groups)}`);
  assert(
    3,
    group.rules.some((r) => r.pattern === BASH_SANITIZED_PATTERN),
    `expected Bash group to contain sanitized pattern "${BASH_SANITIZED_PATTERN}", got ${JSON.stringify(group.rules)}`,
  );
  assert(
    3,
    !group.rules.some((r) => r.pattern === BASH_RAW_PATTERN),
    `Bash group still contains the RAW env-prefixed pattern "${BASH_RAW_PATTERN}" — sanitization did not fire through the real form: ${JSON.stringify(group.rules)}`,
  );

  pass(3, `Bash rule sanitized at create-time: "${BASH_RAW_PATTERN}" -> "${BASH_SANITIZED_PATTERN}"`);
}

// ── step 4: add a second Bash rule (grouping) + a pattern-less WebFetch rule ("all uses") ──

async function step4GroupingAndAllUses(ctx) {
  const before = await getSettings(ctx, 4);
  const bashNoncePreexisting = findGroup(before, "Bash")?.rules?.some((r) => r.pattern === BASH_NONCE_PATTERN);
  assert(4, !bashNoncePreexisting, `refusing to run: a Bash rule with pattern "${BASH_NONCE_PATTERN}" already exists in the real settings.json`);
  const webfetchAllUsesPreexisting = findGroup(before, WEBFETCH_TOOL)?.rules?.some((r) => r.pattern === null);
  assert(4, !webfetchAllUsesPreexisting, `refusing to run: a bare (all-uses) ${WEBFETCH_TOOL} rule already exists in the real settings.json`);

  const addedNonce = await apiAction(ctx, 4, "/settings/permissions/add", { toolName: "Bash", pattern: BASH_NONCE_PATTERN });
  assert(4, addedNonce.ok === true, `permissions/add (nonce) rejected: ${JSON.stringify(addedNonce)}`);
  ctx.addedBashNonce = true;

  let state = await getSettings(ctx, 4);
  let bashGroups = state.permissions.groups.filter((g) => g.toolName === "Bash");
  assert(4, bashGroups.length === 1, `expected exactly ONE Bash group, got ${bashGroups.length}: ${JSON.stringify(state.permissions.groups)}`);
  // The real settings.json may already carry the owner's own Bash rules
  // (design §5 W5's "2 rules" assumes a fresh file) — assert 2 MORE than the
  // step-3 baseline, and that both of this run's patterns are present, so the
  // grouping proof holds regardless of pre-existing real rules.
  const expectedBashCount = ctx.bashRuleCountBaseline + 2;
  assert(
    4,
    bashGroups[0].rules.length === expectedBashCount,
    `expected the Bash group to have baseline(${ctx.bashRuleCountBaseline}) + 2 = ${expectedBashCount} rules, got ${bashGroups[0].rules.length}: ${JSON.stringify(bashGroups[0].rules)}`,
  );
  assert(
    4,
    bashGroups[0].rules.some((r) => r.pattern === BASH_SANITIZED_PATTERN) && bashGroups[0].rules.some((r) => r.pattern === BASH_NONCE_PATTERN),
    `expected the single Bash group to contain BOTH added patterns, got ${JSON.stringify(bashGroups[0].rules)}`,
  );

  const addedWebfetch = await apiAction(ctx, 4, "/settings/permissions/add", { toolName: WEBFETCH_TOOL });
  assert(4, addedWebfetch.ok === true, `permissions/add (${WEBFETCH_TOOL}, no pattern) rejected: ${JSON.stringify(addedWebfetch)}`);
  ctx.addedWebfetchAllUses = true;

  state = await getSettings(ctx, 4);
  const webfetchGroup = findGroup(state, WEBFETCH_TOOL);
  assert(4, webfetchGroup !== undefined, `expected a ${WEBFETCH_TOOL} group after adding, got groups=${JSON.stringify(state.permissions.groups)}`);
  const webfetchRule = webfetchGroup.rules.find((r) => r.pattern === null);
  assert(4, webfetchRule !== undefined, `expected a pattern===null rule in the ${WEBFETCH_TOOL} group, got ${JSON.stringify(webfetchGroup.rules)}`);
  assert(4, webfetchRule.display === "all uses", `expected display==="all uses" for the pattern-less rule, got ${JSON.stringify(webfetchRule.display)}`);

  pass(4, `grouping verified (1 Bash group, 2 rules); ${WEBFETCH_TOOL} bare rule renders display="all uses"`);
}

// ── step 5: remove all three added rules -> DoD (ii), grouped + removable ──

async function step5RemoveAll(ctx) {
  if (ctx.addedBashSanitized) {
    const removed = await apiAction(ctx, 5, "/settings/permissions/remove", { toolName: "Bash", pattern: BASH_SANITIZED_PATTERN });
    assert(5, removed.ok === true, `permissions/remove (sanitized) rejected: ${JSON.stringify(removed)}`);
    ctx.addedBashSanitized = false;
  }
  if (ctx.addedBashNonce) {
    const removed = await apiAction(ctx, 5, "/settings/permissions/remove", { toolName: "Bash", pattern: BASH_NONCE_PATTERN });
    assert(5, removed.ok === true, `permissions/remove (nonce) rejected: ${JSON.stringify(removed)}`);
    ctx.addedBashNonce = false;
  }
  if (ctx.addedWebfetchAllUses) {
    const removed = await apiAction(ctx, 5, "/settings/permissions/remove", { toolName: WEBFETCH_TOOL });
    assert(5, removed.ok === true, `permissions/remove (${WEBFETCH_TOOL}) rejected: ${JSON.stringify(removed)}`);
    ctx.addedWebfetchAllUses = false;
  }

  const state = await getSettings(ctx, 5);
  assert(5, findGroup(state, WEBFETCH_TOOL) === undefined, `expected the ${WEBFETCH_TOOL} group to be gone, got ${JSON.stringify(findGroup(state, WEBFETCH_TOOL))}`);
  const bashGroup = findGroup(state, "Bash");
  const stillPresent = bashGroup?.rules?.some((r) => r.pattern === BASH_SANITIZED_PATTERN || r.pattern === BASH_NONCE_PATTERN);
  assert(5, !stillPresent, `Bash group still contains a rule this smoke added: ${JSON.stringify(bashGroup?.rules)}`);

  pass(5, "all three added rules removed; groups gone from the real settings.json");
}

// ── step 6: search — NARROWED per design §5 W5 authorization ──
//
// W4's facade has NO write path for the search input (SettingsDom exposes
// `searchQuery(): string` read-only — grep confirms zero
// fill/type/setSearch method on the facade or a `/settings/search` route in
// server.ts/README.md). The cut explicitly authorizes narrowing the smoke to
// open/add/group/remove when the DOM-typing path isn't available/flaky, and
// keeping search coverage in `filterSettingsPanes` unit tests instead (DoD
// i-iii do not include search). This step is a documented no-op, not a
// skipped assertion.

function step6SearchNarrowed() {
  pass(6, "narrowed per design §5 W5: no automation write-path exists for the search input (facade read-only); search is covered by filterSettingsPanes unit tests instead");
}

// ── step 7: close settings ──

async function step7Close(ctx) {
  const closed = await apiAction(ctx, 7, "/settings/close", {});
  assert(7, closed.ok === true, `settings/close rejected: ${JSON.stringify(closed)}`);

  const state = await getSettings(ctx, 7);
  assert(7, state.open === false, `expected open===false after close, got ${JSON.stringify(state.open)}`);

  pass(7, "settings closed");
}

// ── teardown ──

/**
 * Thin memoizing wrapper (model-pill-smoke/sidebar-ui-smoke precedent):
 * every caller awaits the SAME shared promise, so a signal landing mid-flight
 * genuinely waits for the real settings-rule cleanup instead of racing it.
 */
function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

/** Best-effort removal of any rule this run added but did not already clean up in step 5 — runs even after a mid-run failure. Never removes a rule it did not itself add. */
async function cleanupResidualRules(ctx) {
  if (!ctx.port || !ctx.token) {
    return;
  }
  const residual = [
    ctx.addedBashSanitized && { toolName: "Bash", pattern: BASH_SANITIZED_PATTERN },
    ctx.addedBashNonce && { toolName: "Bash", pattern: BASH_NONCE_PATTERN },
    ctx.addedWebfetchAllUses && { toolName: WEBFETCH_TOOL },
  ].filter(Boolean);
  for (const rule of residual) {
    try {
      const resp = await api(ctx, "POST", "/settings/permissions/remove", rule);
      if (resp.body?.ok !== true) {
        console.warn(`[settings-ui-smoke] hygiene cleanup: failed to remove residual rule ${JSON.stringify(rule)}: ${JSON.stringify(resp.body)}`);
      } else {
        console.log(`[settings-ui-smoke] hygiene cleanup: removed residual rule ${JSON.stringify(rule)}`);
      }
    } catch (err) {
      console.warn(`[settings-ui-smoke] hygiene cleanup: error removing residual rule ${JSON.stringify(rule)}: ${err?.message ?? err}`);
    }
  }
}

async function runTeardown(ctx, failedStep) {
  // Settings-rule hygiene FIRST, before the app is torn down / port closed —
  // this is the mandatory real-settings cleanup (design §5 W5), independent
  // of whether the app is spawned or attached, and must run even if an
  // earlier step threw mid-way through adding rules.
  await cleanupResidualRules(ctx);

  if (ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      }
      // --attach: nothing else of ours to close — this smoke opens/closes the
      // shared Settings dialog but creates no tabs.
    } catch {
      // best-effort — the app may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[settings-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[settings-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  if (ctx.profile && existsSync(ctx.profile)) {
    if (FLAGS.keep) {
      console.log(`[settings-ui-smoke] --keep set, automation profile preserved at: ${ctx.profile}`);
    } else {
      try {
        rmSync(ctx.profile, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[settings-ui-smoke] failed to remove automation profile: ${err?.message ?? err}`);
      }
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `STOPPED at step ${failedStep}`;
  console.log(`\n[settings-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[settings-ui-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[settings-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    port: undefined,
    token: undefined,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    addedBashSanitized: false,
    addedBashNonce: false,
    addedWebfetchAllUses: false,
    bashRuleCountBaseline: 0,
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    await step1LaunchAndOpen(ctx);
    await step2SelectPermissionsPane(ctx);
    await step3AddSanitizedBashRule(ctx);
    await step4GroupingAndAllUses(ctx);
    await step5RemoveAll(ctx);
    step6SearchNarrowed();
    await step7Close(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[settings-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[settings-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
