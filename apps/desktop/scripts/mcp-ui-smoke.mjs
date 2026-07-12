/**
 * Live GUI smoke for P7.19 F22 (design/slice-P7.19-cut.md §4 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "MCP Servers pane
 * probe/driver" routes) against a seeded project `.anycode/config.json` and a
 * seeded, ISOLATED `ANYCODE_MCP_IMPORT_HOME` fixture directory standing in
 * for `~/.claude.json` / `~/.codex/config.toml` / `~/.zcode/cli/config.json`.
 * It exercises the full stack: config-view join (dot/tools-count/badges),
 * the lossless enable/disable toggle (`setMcpServerEnabled`, preserving
 * cwd/secret env values + every unrelated top-level config key), and the
 * explicit-trust import flow (scan -> consent-gated apply -> forced
 * `enabled:false`, secret VALUES never present in the probe JSON — custody
 * proven by execution, not by reading the source).
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted from
 * `settings-ui-smoke.mjs`/`git-ui-smoke.mjs` (same disposable-profile
 * discipline) — a NEW sibling, not an edit. Unlike settings-ui-smoke.mjs,
 * this script creates its OWN tab against a seeded temp workspace (git-ui-
 * smoke.mjs's `POST /tabs {kind:"new"}` pattern) — it does NOT override
 * `ANYCODE_SETTINGS_PATH`/`ANYCODE_SECRETS_PATH`, so `providerReady` comes
 * from the real, already-configured provider on the machine running this
 * script (same as every other tab-creating smoke in this directory).
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/mcp-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance — read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch, and it does NOT
 *                   override that instance's ANYCODE_MCP_IMPORT_HOME (the
 *                   import-scan steps then read the REAL machine's harness
 *                   configs — only the toggle/row-shape steps are meaningful
 *                   under --attach; import assertions may legitimately differ).
 *   --keep         Do not delete the temp workspace / import-home / automation
 *                   profile dirs on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Each of the 7 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (populated pane, open import
 * dialog) is written to `apps/desktop/out/mcp-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const FIXTURE_SERVER_PATH = join(repoRoot, "packages", "core", "src", "mcp", "fixtures", "fixture-server.mjs");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const MCP_CONNECT_TIMEOUT_MS = 30_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// ── fixture identities (deterministic, collision-free with each other) ──

const SERVER_A_NAME = "fixture-echo-a";
const SERVER_B_NAME = "disabled-dummy-b";
// Non-mcp top-level key the project config.json is seeded with (design §4 W4
// point 3: proves the writer never touches keys outside `mcpServers`, the
// shared-file invariant config-write.ts's header documents).
const TELEMETRY_MARKER = "mcp-ui-smoke-preserve-me";

const CLAUDE_SERVER_NAME = "claude-fixture-server";
const CLAUDE_SENTINEL_KEY = "SENTINEL_MCP_SECRET_93F1";
const CLAUDE_SENTINEL_VALUE = "claude-secret-93f1-do-not-leak";
const CODEX_SERVER_NAME = "codex-fixture-server";
const CODEX_ENV_KEY = "CODEX_FIXTURE_TOKEN";
const CODEX_ENV_VALUE = "codex-token-value-77";
const ZCODE_SERVER_NAME = "zcode-fixture-server";

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
      console.warn(`[mcp-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── small process/fs helpers (lifted from git-ui-smoke.mjs/settings-ui-smoke.mjs) ──

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

/** Cheap deep-equality for plain JSON values (all our fixtures are JSON-round-tripped, so key order is stable). */
function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

/** `POST /wait` + hard-fail if the condition never matched within the timeout. */
async function waitUntilTab(ctx, step, until, timeoutMs) {
  const body = { tabId: ctx.tabId, until };
  if (timeoutMs !== undefined) {
    body.timeoutMs = timeoutMs;
  }
  const result = await apiOk(ctx, step, "POST", "/wait", body);
  if (result.matched !== true) {
    fail(step, `/wait ${JSON.stringify(until)} did not match: ${JSON.stringify(result)}`);
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

async function getMcpPane(ctx, step) {
  return apiOk(ctx, step, "GET", "/settings/mcp");
}

function findRow(probe, name) {
  return probe?.rows?.find((r) => r.name === name);
}

/** Best-effort PNG evidence via `GET /screenshot` — never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[mcp-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[mcp-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

function readWorkspaceConfig(ctx) {
  return JSON.parse(readFileSync(ctx.workspaceConfigPath, "utf8"));
}

// ── step 1: bootstrap the temp workspace config + the isolated import-home fixtures ──

function step1BootstrapFixtures(ctx) {
  const wsRoot = mkdtempSync(join(tmpdir(), "anycode-mcp-smoke-ws-"));
  ctx.workspace = wsRoot;
  const anycodeDir = join(wsRoot, ".anycode");
  mkdirSync(anycodeDir, { recursive: true });
  ctx.workspaceConfigPath = join(anycodeDir, "config.json");

  ctx.seededConfig = {
    mcpServers: {
      [SERVER_A_NAME]: {
        command: process.execPath,
        args: [FIXTURE_SERVER_PATH],
        enabled: true,
      },
      [SERVER_B_NAME]: {
        command: "/nonexistent/dummy-mcp-binary",
        args: ["--dummy-flag"],
        cwd: "/tmp",
        env: { DUMMY_VAR: "dummy-value-keep-me" },
        enabled: false,
      },
    },
    telemetry: { enabled: false, smokeMarker: TELEMETRY_MARKER },
  };
  writeFileSync(ctx.workspaceConfigPath, JSON.stringify(ctx.seededConfig, null, 2));

  const importHome = mkdtempSync(join(tmpdir(), "anycode-mcp-smoke-home-"));
  ctx.importHome = importHome;

  // ~/.claude.json — top-level mcpServers, one entry carrying the sentinel env value.
  writeFileSync(
    join(importHome, ".claude.json"),
    JSON.stringify(
      {
        mcpServers: {
          [CLAUDE_SERVER_NAME]: {
            command: "node",
            args: ["claude-server.js"],
            env: { [CLAUDE_SENTINEL_KEY]: CLAUDE_SENTINEL_VALUE },
          },
        },
      },
      null,
      2,
    ),
  );

  // ~/.codex/config.toml — [mcp_servers.<name>] table, one entry with an env value.
  const codexDir = join(importHome, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "config.toml"),
    [
      `[mcp_servers.${CODEX_SERVER_NAME}]`,
      `command = "node"`,
      `args = ["codex-server.js"]`,
      ``,
      `[mcp_servers.${CODEX_SERVER_NAME}.env]`,
      `${CODEX_ENV_KEY} = "${CODEX_ENV_VALUE}"`,
      ``,
    ].join("\n"),
  );

  // ~/.zcode/cli/config.json — mcp.servers.<name>, no secrets needed for this one.
  const zcodeDir = join(importHome, ".zcode", "cli");
  mkdirSync(zcodeDir, { recursive: true });
  writeFileSync(
    join(zcodeDir, "config.json"),
    JSON.stringify({ mcp: { servers: { [ZCODE_SERVER_NAME]: { command: "node", args: ["zcode-server.js"] } } } }, null, 2),
  );

  pass(1, `workspace seeded at ${wsRoot} (A=${SERVER_A_NAME} enabled, B=${SERVER_B_NAME} disabled); import-home seeded at ${importHome} (claude/codex/zcode, 1 candidate each)`);
}

// ── step 2: launch (or attach to) the dev app, create a tab against the seeded workspace ──

async function step2LaunchAndCreateTab(ctx) {
  if (FLAGS.attach) {
    const info = readDiscoveryFile(DISCOVERY_PATH);
    if (info === null) {
      fail(2, `--attach given but no valid discovery file at ${DISCOVERY_PATH}`);
    }
    if (!isPidAlive(info.pid)) {
      fail(2, `--attach discovery file points at a dead pid ${info.pid} (stale file?)`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    ctx.child = null;
  } else {
    const profile = mkdtempSync(join(tmpdir(), "anycode-mcp-smoke-profile-"));
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
      // dev/test-only override (automation/README.md "MCP Servers pane
      // probe/driver" section) — points the import scan's `home` at our
      // disposable fixture directory instead of the real machine's harness
      // configs. Production code path is unaffected (falls back to
      // os.homedir() when unset).
      ANYCODE_MCP_IMPORT_HOME: ctx.importHome,
    };
    delete env.ANYCODE_WORKSPACE; // this smoke creates its own tab explicitly (below)
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
        fail(2, `dev process exited early (code=${child.exitCode}, signal=${child.signalCode}) before publishing discovery`);
      }
      const candidate = readDiscoveryFile(ctx.profileAutomationInfo);
      if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
        info = candidate;
        break;
      }
      await sleep(500);
    }
    if (info === null) {
      fail(2, `timed out after ${LAUNCH_TIMEOUT_MS}ms waiting for ${ctx.profileAutomationInfo} (startedAt > ${t0})`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
  }

  await waitForFacade(ctx, 2);

  const created = await apiOk(ctx, 2, "POST", "/tabs", { kind: "new", workspace: ctx.workspace });
  assert(2, created.ok === true, `POST /tabs rejected: ${JSON.stringify(created)}`);
  ctx.tabId = created.tabId;

  await waitUntilTab(ctx, 2, { connection: "ready" }, 60_000);

  pass(2, `app launched, tab ${ctx.tabId} ready for ${ctx.workspace}`);
}

// ── step 3: open Settings -> "mcp" pane, wait for the config-view join to settle, assert row A/B shapes ──

async function step3OpenPaneAndAssertRows(ctx) {
  const opened = await apiAction(ctx, 3, "/settings/open", {});
  assert(3, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);

  const selected = await apiAction(ctx, 3, "/settings/pane", { paneId: "mcp" });
  assert(3, selected.ok === true, `settings/pane("mcp") rejected: ${JSON.stringify(selected)}`);

  // The config-view snapshot fetch (bridge.get) AND the fixture server's real
  // stdio initialize handshake are both async — poll until row A reports
  // connected, or fail out with whatever the last probe read was.
  const start = Date.now();
  let probe = null;
  for (;;) {
    probe = await getMcpPane(ctx, 3);
    const rowA = findRow(probe, SERVER_A_NAME);
    if (rowA && rowA.dotKind === "completed") {
      break;
    }
    if (Date.now() - start >= MCP_CONNECT_TIMEOUT_MS) {
      fail(3, `row "${SERVER_A_NAME}" never reached dotKind:"completed" within ${MCP_CONNECT_TIMEOUT_MS}ms — last probe: ${JSON.stringify(probe)}`);
    }
    await sleep(300);
  }
  ctx.lastProbe = probe;

  assert(3, probe.problems === 0, `expected 0 config problems, got ${probe.problems}: ${JSON.stringify(probe)}`);

  const rowA = findRow(probe, SERVER_A_NAME);
  assert(3, rowA.source === "project", `row A expected source "project", got ${JSON.stringify(rowA)}`);
  assert(3, rowA.enabled === true, `row A expected enabled:true, got ${JSON.stringify(rowA)}`);
  assert(3, rowA.toolsBadge === "6 tools", `row A expected toolsBadge "6 tools" (fixture registers 6), got ${JSON.stringify(rowA)}`);
  assert(3, rowA.commandLine.includes(FIXTURE_SERVER_PATH), `row A commandLine should include the fixture server path, got ${JSON.stringify(rowA)}`);

  const rowB = findRow(probe, SERVER_B_NAME);
  assert(3, rowB !== undefined, `expected row "${SERVER_B_NAME}" to be present (config-view-only row — this is the whole point of the join, W3 §4)`);
  assert(3, rowB.enabled === false, `row B expected enabled:false, got ${JSON.stringify(rowB)}`);
  assert(3, rowB.dotKind === "off", `row B expected dotKind:"off", got ${JSON.stringify(rowB)}`);
  assert(3, rowB.toolsBadge === null, `row B (disabled) must never show a tools badge, got ${JSON.stringify(rowB)}`);

  await saveScreenshot(ctx, "step3-mcp-pane-populated");

  pass(3, `row A connected (${rowA.toolsBadge}), row B present disabled with no tools badge — config-view join proven`);
}

// ── step 4: toggle B on; assert the probe AND the on-disk file (lossless, non-mcp keys preserved) ──

async function step4ToggleAndAssertDisk(ctx) {
  const before = readWorkspaceConfig(ctx);
  const beforeB = before.mcpServers[SERVER_B_NAME];
  assert(4, beforeB?.enabled === false, `precondition: on-disk B.enabled should still be false, got ${JSON.stringify(beforeB)}`);

  const toggled = await apiAction(ctx, 4, "/settings/mcp/toggle", { name: SERVER_B_NAME });
  assert(4, toggled.ok === true, `settings/mcp/toggle rejected: ${JSON.stringify(toggled)}`);

  const probe = await getMcpPane(ctx, 4);
  const rowB = findRow(probe, SERVER_B_NAME);
  assert(4, rowB?.enabled === true, `probe expected row B enabled:true after toggle, got ${JSON.stringify(rowB)}`);

  const after = readWorkspaceConfig(ctx);
  const afterB = after.mcpServers[SERVER_B_NAME];
  assert(4, afterB?.enabled === true, `on-disk B.enabled expected true, got ${JSON.stringify(afterB)}`);
  const beforeBSansEnabled = { ...beforeB, enabled: true };
  assert(
    4,
    deepEqualJson(afterB, beforeBSansEnabled),
    `on-disk B entry should be byte-identical to the seed except enabled — before=${JSON.stringify(beforeB)} after=${JSON.stringify(afterB)}`,
  );
  assert(
    4,
    deepEqualJson(after.telemetry, ctx.seededConfig.telemetry),
    `on-disk non-mcp "telemetry" key must be preserved byte-identically — before=${JSON.stringify(ctx.seededConfig.telemetry)} after=${JSON.stringify(after.telemetry)}`,
  );
  const afterA = after.mcpServers[SERVER_A_NAME];
  assert(
    4,
    deepEqualJson(afterA, before.mcpServers[SERVER_A_NAME]),
    `on-disk A entry must be untouched by B's toggle, got ${JSON.stringify(afterA)}`,
  );

  pass(4, `B toggled enabled (lossless: cwd/env/args intact); non-mcp "telemetry" key + server A byte-preserved`);
}

// ── step 5: open the import dialog; assert 3 candidates across 3 harnesses; assert the sentinel VALUE never crosses ──

async function step5OpenImportAndAssertCustody(ctx) {
  const opened = await apiAction(ctx, 5, "/settings/mcp/import/open", {});
  assert(5, opened.ok === true, `settings/mcp/import/open rejected: ${JSON.stringify(opened)}`);

  const probe = await getMcpPane(ctx, 5);
  assert(5, probe.importOpen === true, `expected importOpen:true, got ${JSON.stringify(probe.importOpen)}`);
  assert(5, probe.importCandidates.length === 3, `expected 3 import candidates, got ${probe.importCandidates.length}: ${JSON.stringify(probe.importCandidates)}`);

  const harnesses = new Set(probe.importCandidates.map((c) => c.harness));
  assert(5, harnesses.has("claude"), `expected a "claude" harness candidate, got ${JSON.stringify([...harnesses])}`);
  assert(5, harnesses.has("codex"), `expected a "codex" harness candidate, got ${JSON.stringify([...harnesses])}`);
  assert(5, harnesses.has("zcode"), `expected a "zcode" harness candidate, got ${JSON.stringify([...harnesses])}`);

  const names = probe.importCandidates.map((c) => c.name);
  assert(5, names.includes(CLAUDE_SERVER_NAME), `expected candidate "${CLAUDE_SERVER_NAME}", got ${JSON.stringify(names)}`);
  assert(5, names.includes(CODEX_SERVER_NAME), `expected candidate "${CODEX_SERVER_NAME}", got ${JSON.stringify(names)}`);
  assert(5, names.includes(ZCODE_SERVER_NAME), `expected candidate "${ZCODE_SERVER_NAME}", got ${JSON.stringify(names)}`);

  // Custody by execution (design §3): the whole probe JSON must never carry
  // either seeded secret VALUE — only key names ever cross to the renderer.
  const wholeProbeJson = JSON.stringify(probe);
  assert(5, !wholeProbeJson.includes(CLAUDE_SENTINEL_VALUE), `probe JSON leaked the claude sentinel VALUE: ${wholeProbeJson}`);
  assert(5, !wholeProbeJson.includes(CODEX_ENV_VALUE), `probe JSON leaked the codex env VALUE: ${wholeProbeJson}`);

  await saveScreenshot(ctx, "step5-mcp-import-dialog");

  pass(5, `import dialog: 3 candidates across claude/codex/zcode; neither secret VALUE present in probe JSON`);
}

// ── step 6: apply the claude candidate WITHOUT consent -> file gains it disabled, no env at all ──

async function step6ApplyClaudeNoConsent(ctx) {
  const applied = await apiAction(ctx, 6, "/settings/mcp/import/apply", { consent: false, names: [CLAUDE_SERVER_NAME] });
  assert(6, applied.ok === true, `settings/mcp/import/apply (claude, no consent) rejected: ${JSON.stringify(applied)}`);

  const after = readWorkspaceConfig(ctx);
  const claudeEntry = after.mcpServers[CLAUDE_SERVER_NAME];
  assert(6, claudeEntry !== undefined, `expected "${CLAUDE_SERVER_NAME}" to be written to the config file, got mcpServers=${JSON.stringify(Object.keys(after.mcpServers))}`);
  assert(6, claudeEntry.enabled === false, `imported entry must be forced enabled:false, got ${JSON.stringify(claudeEntry)}`);
  assert(6, claudeEntry.env === undefined, `env must be OMITTED entirely without consent, got ${JSON.stringify(claudeEntry)}`);

  const wholeFileText = JSON.stringify(after);
  assert(6, !wholeFileText.includes(CLAUDE_SENTINEL_VALUE), `on-disk config leaked the claude sentinel VALUE despite consent:false: ${wholeFileText}`);

  pass(6, `claude candidate imported disabled, env omitted (no consent) — sentinel VALUE never written to disk`);
}

// ── step 7: apply the codex candidate WITH consent -> file gains it disabled, env value present ──

async function step7ApplyCodexWithConsent(ctx) {
  const applied = await apiAction(ctx, 7, "/settings/mcp/import/apply", { consent: true, names: [CODEX_SERVER_NAME] });
  assert(7, applied.ok === true, `settings/mcp/import/apply (codex, consent) rejected: ${JSON.stringify(applied)}`);

  const after = readWorkspaceConfig(ctx);
  const codexEntry = after.mcpServers[CODEX_SERVER_NAME];
  assert(7, codexEntry !== undefined, `expected "${CODEX_SERVER_NAME}" to be written to the config file, got mcpServers=${JSON.stringify(Object.keys(after.mcpServers))}`);
  assert(7, codexEntry.enabled === false, `imported entry must STILL be forced enabled:false even with consent, got ${JSON.stringify(codexEntry)}`);
  assert(7, codexEntry.env?.[CODEX_ENV_KEY] === CODEX_ENV_VALUE, `expected env["${CODEX_ENV_KEY}"] === "${CODEX_ENV_VALUE}" with consent, got ${JSON.stringify(codexEntry)}`);

  // The claude entry from step 6 (and B/telemetry from step 4) must still be
  // intact — a second apply call is a distinct write, not a full-file replace.
  const claudeEntry = after.mcpServers[CLAUDE_SERVER_NAME];
  assert(7, claudeEntry?.enabled === false && claudeEntry.env === undefined, `step 6's claude entry must be undisturbed, got ${JSON.stringify(claudeEntry)}`);
  assert(7, deepEqualJson(after.telemetry, ctx.seededConfig.telemetry), `non-mcp "telemetry" key must STILL be preserved after two import applies, got ${JSON.stringify(after.telemetry)}`);

  pass(7, `codex candidate imported disabled WITH env value present (consent honored); prior writes (claude/B/telemetry) undisturbed`);
}

// ── teardown ──

function teardown(ctx, failedStep) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedStep);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedStep) {
  if (ctx.tabId && ctx.port && ctx.token) {
    try {
      if (ctx.child) {
        await api(ctx, "POST", "/quit", {});
      } else {
        await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
      }
    } catch {
      // best-effort — the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[mcp-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit — escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[mcp-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.workspace, ctx.importHome, ctx.profile]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[mcp-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[mcp-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[mcp-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed — ${verdict}`);
}

// ── orchestration ──

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[mcp-ui-smoke] received ${signal} — tearing down…`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[mcp-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    workspace: null,
    workspaceConfigPath: null,
    seededConfig: null,
    importHome: null,
    port: undefined,
    token: undefined,
    tabId: null,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    teardownPromise: null,
    lastProbe: null,
    screenshotDir: join(desktopRoot, "out", "mcp-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapFixtures(ctx);
    await step2LaunchAndCreateTab(ctx);
    await step3OpenPaneAndAssertRows(ctx);
    await step4ToggleAndAssertDisk(ctx);
    await step5OpenImportAndAssertCustody(ctx);
    await step6ApplyClaudeNoConsent(ctx);
    await step7ApplyCodexWithConsent(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[mcp-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[mcp-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
