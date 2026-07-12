/**
 * Live GUI smoke for P7.20 F23 (design/slice-P7.20-cut.md §5 W4): drives a
 * REAL Electron dev instance end-to-end over the automation HTTP channel
 * (`main/automation/*`, see `automation/README.md`'s "Skills pane
 * probe/driver" routes) against a seeded project `.anycode/skills/*` catalog
 * (+ an unrelated `mcpServers` preservation sentinel in the project config)
 * and a seeded, ISOLATED `ANYCODE_SKILLS_IMPORT_HOME` fixture directory
 * standing in for `~/.claude/skills`, `~/.codex/skills`, `~/.zcode/skills`.
 * It exercises the full stack: the admin scan (valid + broken SKILL.md, the
 * amber problems strip), the lossless disable toggle (`setSkillEnabled`,
 * preserving the unrelated `mcpServers` key byte-for-byte), and the
 * default-enabled import wizard (scan -> conflict/conversion badges -> apply
 * -> convert+copy into the catalog with name-conflict suffixing, symlinks
 * never copied -- custody proven by execution, not by reading the source),
 * then a delete of one freshly-imported skill.
 *
 * Boot/attach/teardown scaffold + process/fs helpers lifted from
 * `mcp-ui-smoke.mjs` (same disposable-profile discipline) -- a NEW sibling,
 * not an edit. Creates its OWN tab against a seeded temp workspace (same
 * `POST /tabs {kind:"new"}` pattern); does NOT override
 * `ANYCODE_SETTINGS_PATH`/`ANYCODE_SECRETS_PATH`, so `providerReady` comes
 * from the real, already-configured provider on the machine running this
 * script (same as every other tab-creating smoke in this directory).
 *
 * Plain node >=22, ZERO npm deps (only node:child_process/fs/os/path/url +
 * the global `fetch`).
 *
 * Usage:   node apps/desktop/scripts/skills-ui-smoke.mjs [--attach] [--keep] [--port <n>]
 *
 *   --attach       Do not spawn a dev instance -- read the live discovery file
 *                   (~/.anycode/automation.json) of one already running.
 *                   Teardown then only closes the tab this script created; it
 *                   does NOT quit an app it did not launch, and it does NOT
 *                   override that instance's ANYCODE_SKILLS_IMPORT_HOME (the
 *                   import-scan steps then read the REAL machine's harness
 *                   catalogs -- only the toggle/row-shape/delete steps are
 *                   meaningful under --attach; import assertions may
 *                   legitimately differ).
 *   --keep         Do not delete the temp workspace / import-home / automation
 *                   profile dirs on exit (debugging).
 *   --port <n>     Forwarded as ANYCODE_AUTOMATION_PORT to the spawned dev
 *                   process (ignored with --attach).
 *
 * Each of the 7 frozen steps prints `[step N] PASS/FAIL <detail>`; the first
 * FAIL tears down and exits 1. PNG evidence (populated pane, open import
 * dialog) is written to `apps/desktop/out/skills-smoke/step-*.png`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const DISCOVERY_PATH = join(homedir(), ".anycode", "automation.json");
const TOTAL_STEPS = 7;
const LAUNCH_TIMEOUT_MS = 120_000;
const PANE_SETTLE_TIMEOUT_MS = 15_000;
const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 750;

// -- fixture identities (deterministic, collision-free with each other) --

const WORKSPACE_ALPHA_NAME = "alpha";
const WORKSPACE_BROKEN_NAME = "broken";
// Non-skills top-level key the project config.json is seeded with (design §5
// W4 point 3: proves the writer never touches keys outside `skills`, the
// shared-file invariant config-file.ts's header documents -- same posture as
// mcp-ui-smoke's TELEMETRY_MARKER, but here mcpServers is the sentinel since
// skills.disabled lives in the SAME shared config.json as mcpServers).
const SENTINEL_MCP_SERVER_NAME = "skills-ui-smoke-sentinel-mcp";

const IMPORTED_ONE_NAME = "imported-one";
const IMPORTED_ONE_OUTSIDE_LINK = "link-to-outside-secret";
const NESTED_META_NAME = "nested-meta";
const ZCODE_ALPHA_DESCRIPTION = "zcode alpha skill (name conflict fixture for the import wizard).";

// -- CLI flags --

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
      console.warn(`[skills-ui-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// -- small process/fs helpers (lifted from mcp-ui-smoke.mjs) --

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
    // already gone -- nothing to do.
  }
}

/** Cheap deep-equality for plain JSON values (all our fixtures are JSON-round-tripped, so key order is stable). */
function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// -- step bookkeeping --

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

// -- HTTP helpers against the automation channel (README.md routes) --

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
 * dynamic import races the page load) -- same readiness signal as every
 * other `*-ui-smoke.mjs` in this directory.
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

async function getSkillsPane(ctx, step) {
  return apiOk(ctx, step, "GET", "/settings/skills");
}

function findRow(probe, name) {
  return probe?.rows?.find((r) => r.name === name);
}

function findCandidate(probe, harness, name) {
  return probe?.importCandidates?.find((c) => c.harness === harness && c.name === name);
}

/** Best-effort PNG evidence via `GET /screenshot` -- never fails the step it's called from. */
async function saveScreenshot(ctx, name) {
  try {
    const resp = await api(ctx, "GET", "/screenshot");
    if (resp.status !== 200 || typeof resp.body?.png !== "string") {
      console.warn(`[skills-ui-smoke] screenshot "${name}" unavailable (HTTP ${resp.status})`);
      return;
    }
    mkdirSync(ctx.screenshotDir, { recursive: true });
    const filePath = join(ctx.screenshotDir, `${name}.png`);
    writeFileSync(filePath, Buffer.from(resp.body.png, "base64"));
    console.log(`           screenshot: ${filePath}`);
  } catch (err) {
    console.warn(`[skills-ui-smoke] screenshot "${name}" failed: ${err?.message ?? err}`);
  }
}

function readWorkspaceConfig(ctx) {
  return JSON.parse(readFileSync(ctx.workspaceConfigPath, "utf8"));
}

function skillMd({ name, description, extraFrontmatter = [], body }) {
  return [`---`, `name: ${name}`, `description: ${description}`, ...extraFrontmatter, `---`, body, ""].join("\n");
}

// -- step 1: bootstrap the temp workspace catalog + the isolated import-home fixtures --

function step1BootstrapFixtures(ctx) {
  const wsRoot = mkdtempSync(join(tmpdir(), "anycode-skills-smoke-ws-"));
  ctx.workspace = wsRoot;
  const anycodeDir = join(wsRoot, ".anycode");
  const workspaceSkillsDir = join(anycodeDir, "skills");
  ctx.workspaceSkillsDir = workspaceSkillsDir;
  mkdirSync(workspaceSkillsDir, { recursive: true });
  ctx.workspaceConfigPath = join(anycodeDir, "config.json");

  ctx.seededConfig = {
    mcpServers: {
      [SENTINEL_MCP_SERVER_NAME]: {
        command: "/nonexistent/dummy-mcp-binary",
        args: ["--dummy-flag"],
      },
    },
  };
  writeFileSync(ctx.workspaceConfigPath, JSON.stringify(ctx.seededConfig, null, 2));

  // Workspace catalog: one valid skill, one malformed (an indented line makes
  // the WHOLE file non-conforming to the strict frontmatter parser).
  const alphaDir = join(workspaceSkillsDir, WORKSPACE_ALPHA_NAME);
  mkdirSync(alphaDir, { recursive: true });
  writeFileSync(
    join(alphaDir, "SKILL.md"),
    skillMd({
      name: WORKSPACE_ALPHA_NAME,
      description: "Workspace alpha skill for the P7.20 skills-ui-smoke.",
      body: "Alpha skill body.",
    }),
  );

  const brokenDir = join(workspaceSkillsDir, WORKSPACE_BROKEN_NAME);
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(
    join(brokenDir, "SKILL.md"),
    [
      "---",
      `name: ${WORKSPACE_BROKEN_NAME}`,
      "description: Malformed skill for the amber problems strip.",
      "  this indented line makes the whole file non-conforming",
      "---",
      "Broken skill body.",
      "",
    ].join("\n"),
  );

  // Isolated import-home fixtures, standing in for ~/.claude, ~/.codex,
  // ~/.zcode (design §3: real-shape verified live on the owner's machine).
  const importHome = mkdtempSync(join(tmpdir(), "anycode-skills-smoke-home-"));
  ctx.importHome = importHome;

  // ~/.claude/skills/imported-one -- flat/compatible, WITH a support file AND
  // a symlink to an outside file (proves the copier never follows it, §4).
  const claudeSkillsDir = join(importHome, ".claude", "skills");
  const importedOneDir = join(claudeSkillsDir, IMPORTED_ONE_NAME);
  mkdirSync(join(importedOneDir, "references"), { recursive: true });
  writeFileSync(
    join(importedOneDir, "SKILL.md"),
    skillMd({
      name: IMPORTED_ONE_NAME,
      description: "Imported skill, compatible verbatim, with a support tree.",
      body: "Body content for imported-one.",
    }),
  );
  writeFileSync(join(importedOneDir, "references", "extra.md"), "Reference material that must be copied.\n");
  const outsideSecretPath = join(importHome, "outside-secret.txt");
  writeFileSync(outsideSecretPath, "this must NEVER be copied into our catalog\n");
  try {
    symlinkSync(outsideSecretPath, join(importedOneDir, IMPORTED_ONE_OUTSIDE_LINK));
  } catch (err) {
    console.warn(`[skills-ui-smoke] could not create the outside-symlink fixture (platform without symlink support?): ${err?.message ?? err}`);
  }

  // ~/.codex/skills/nested-meta -- real shape (D3): a nested `metadata:`
  // block that the strict parser rejects wholesale, needing the D3
  // normalizer.
  const codexSkillsDir = join(importHome, ".codex", "skills");
  const nestedMetaDir = join(codexSkillsDir, NESTED_META_NAME);
  mkdirSync(nestedMetaDir, { recursive: true });
  writeFileSync(
    join(nestedMetaDir, "SKILL.md"),
    skillMd({
      name: NESTED_META_NAME,
      description: "Needs conversion -- real codex shape with a nested metadata block.",
      extraFrontmatter: ["metadata:", "  version: 1", "  author: skills-ui-smoke"],
      body: "Body content for nested-meta.",
    }),
  );

  // ~/.zcode/skills/alpha -- flat/compatible, but a NAME CONFLICT with the
  // workspace's own "alpha" (design §5-W4 scenario point 4/5).
  const zcodeSkillsDir = join(importHome, ".zcode", "skills");
  const zcodeAlphaDir = join(zcodeSkillsDir, WORKSPACE_ALPHA_NAME);
  mkdirSync(zcodeAlphaDir, { recursive: true });
  writeFileSync(
    join(zcodeAlphaDir, "SKILL.md"),
    skillMd({ name: WORKSPACE_ALPHA_NAME, description: ZCODE_ALPHA_DESCRIPTION, body: "Body for zcode alpha." }),
  );

  pass(
    1,
    `workspace seeded at ${wsRoot} (alpha valid, broken malformed); import-home seeded at ${importHome} (claude/imported-one+support+symlink, codex/nested-meta nested-metadata, zcode/alpha name-conflict)`,
  );
}

// -- step 2: launch (or attach to) the dev app, create a tab against the seeded workspace --

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
    const profile = mkdtempSync(join(tmpdir(), "anycode-skills-smoke-profile-"));
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
      // dev/test-only override (automation/README.md "Skills pane
      // probe/driver" section) -- points the import scan's `home` at our
      // disposable fixture directory instead of the real machine's harness
      // catalogs. Production code path is unaffected (falls back to
      // os.homedir() when unset).
      ANYCODE_SKILLS_IMPORT_HOME: ctx.importHome,
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

// -- step 3: open Settings -> "skills" pane, assert alpha present / broken absent / one problem --

async function step3OpenPaneAndAssertRows(ctx) {
  const opened = await apiAction(ctx, 3, "/settings/open", {});
  assert(3, opened.ok === true, `settings/open rejected: ${JSON.stringify(opened)}`);

  const selected = await apiAction(ctx, 3, "/settings/pane", { paneId: "skills" });
  assert(3, selected.ok === true, `settings/pane("skills") rejected: ${JSON.stringify(selected)}`);

  // The admin scan (fs readdir + frontmatter parse) is async -- poll briefly
  // until the pane's first snapshot has landed, then assert its shape.
  const start = Date.now();
  let probe = null;
  for (;;) {
    probe = await getSkillsPane(ctx, 3);
    if (probe.rows.length > 0 || probe.problems > 0) {
      break;
    }
    if (Date.now() - start >= PANE_SETTLE_TIMEOUT_MS) {
      fail(3, `skills pane never reported any rows/problems within ${PANE_SETTLE_TIMEOUT_MS}ms -- last probe: ${JSON.stringify(probe)}`);
    }
    await sleep(200);
  }
  ctx.lastProbe = probe;

  const rowAlpha = findRow(probe, WORKSPACE_ALPHA_NAME);
  assert(3, rowAlpha !== undefined, `expected row "${WORKSPACE_ALPHA_NAME}" to be present, got rows=${JSON.stringify(probe.rows)}`);
  assert(3, rowAlpha.sourceKind === "project", `row "${WORKSPACE_ALPHA_NAME}" expected sourceKind "project", got ${JSON.stringify(rowAlpha)}`);
  assert(3, rowAlpha.enabled === true, `row "${WORKSPACE_ALPHA_NAME}" expected enabled:true, got ${JSON.stringify(rowAlpha)}`);
  assert(3, rowAlpha.hasToggle === true, `row "${WORKSPACE_ALPHA_NAME}" expected hasToggle:true, got ${JSON.stringify(rowAlpha)}`);

  const rowBroken = findRow(probe, WORKSPACE_BROKEN_NAME);
  assert(3, rowBroken === undefined, `expected NO row for the malformed "${WORKSPACE_BROKEN_NAME}" skill, got ${JSON.stringify(rowBroken)}`);

  assert(3, probe.problems === 1, `expected exactly 1 discovery problem (the malformed "${WORKSPACE_BROKEN_NAME}" file), got ${probe.problems}: ${JSON.stringify(probe)}`);

  await saveScreenshot(ctx, "step3-skills-pane-populated");

  pass(3, `row "${WORKSPACE_ALPHA_NAME}" present+enabled, row "${WORKSPACE_BROKEN_NAME}" absent, problems=1 -- admin scan proven`);
}

// -- step 4: disable alpha; assert the probe AND the on-disk file (lossless, mcpServers preserved) --

async function step4ToggleAndAssertDisk(ctx) {
  const before = readWorkspaceConfig(ctx);
  assert(4, before.skills === undefined, `precondition: on-disk config should have no "skills" key yet, got ${JSON.stringify(before.skills)}`);

  const toggled = await apiAction(ctx, 4, "/settings/skills/toggle", { name: WORKSPACE_ALPHA_NAME });
  assert(4, toggled.ok === true, `settings/skills/toggle rejected: ${JSON.stringify(toggled)}`);

  const probe = await getSkillsPane(ctx, 4);
  const rowAlpha = findRow(probe, WORKSPACE_ALPHA_NAME);
  assert(4, rowAlpha?.enabled === false, `probe expected row "${WORKSPACE_ALPHA_NAME}" enabled:false after toggle, got ${JSON.stringify(rowAlpha)}`);

  const after = readWorkspaceConfig(ctx);
  assert(4, Array.isArray(after.skills?.disabled) && after.skills.disabled.includes(WORKSPACE_ALPHA_NAME), `on-disk skills.disabled expected to include "${WORKSPACE_ALPHA_NAME}", got ${JSON.stringify(after.skills)}`);
  assert(
    4,
    deepEqualJson(after.mcpServers, ctx.seededConfig.mcpServers),
    `on-disk non-skills "mcpServers" key must be preserved byte-identically -- before=${JSON.stringify(ctx.seededConfig.mcpServers)} after=${JSON.stringify(after.mcpServers)}`,
  );

  pass(4, `"${WORKSPACE_ALPHA_NAME}" disabled (skills.disabled written); sentinel "mcpServers" key byte-preserved`);
}

// -- step 5: open the import dialog, assert badges, apply all 3 into the workspace scope --

async function step5ImportOpenAndApply(ctx) {
  const opened = await apiAction(ctx, 5, "/settings/skills/import/open", {});
  assert(5, opened.ok === true, `settings/skills/import/open rejected: ${JSON.stringify(opened)}`);

  const probe = await getSkillsPane(ctx, 5);
  assert(5, probe.importOpen === true, `expected importOpen:true, got ${JSON.stringify(probe.importOpen)}`);
  assert(5, probe.importCandidates.length === 3, `expected 3 import candidates, got ${probe.importCandidates.length}: ${JSON.stringify(probe.importCandidates)}`);

  const importedOne = findCandidate(probe, "claude", IMPORTED_ONE_NAME);
  assert(5, importedOne !== undefined, `expected a "claude"/"${IMPORTED_ONE_NAME}" candidate, got ${JSON.stringify(probe.importCandidates)}`);
  assert(5, importedOne.needsConversion === false && importedOne.alreadyPresent === false, `"${IMPORTED_ONE_NAME}" expected compatible-verbatim + not-already-present, got ${JSON.stringify(importedOne)}`);

  const nestedMeta = findCandidate(probe, "codex", NESTED_META_NAME);
  assert(5, nestedMeta !== undefined, `expected a "codex"/"${NESTED_META_NAME}" candidate, got ${JSON.stringify(probe.importCandidates)}`);
  assert(5, nestedMeta.needsConversion === true, `"${NESTED_META_NAME}" expected needsConversion:true (conversion badge), got ${JSON.stringify(nestedMeta)}`);

  const zcodeAlpha = findCandidate(probe, "zcode", WORKSPACE_ALPHA_NAME);
  assert(5, zcodeAlpha !== undefined, `expected a "zcode"/"${WORKSPACE_ALPHA_NAME}" candidate, got ${JSON.stringify(probe.importCandidates)}`);
  assert(5, zcodeAlpha.alreadyPresent === true, `"zcode"/"${WORKSPACE_ALPHA_NAME}" expected alreadyPresent:true (conflict badge), got ${JSON.stringify(zcodeAlpha)}`);

  await saveScreenshot(ctx, "step5-skills-import-dialog");

  const applied = await apiAction(ctx, 5, "/settings/skills/import/apply", {
    scope: "project",
    ids: [importedOne.id, nestedMeta.id, zcodeAlpha.id],
  });
  assert(5, applied.ok === true, `settings/skills/import/apply rejected: ${JSON.stringify(applied)}`);

  const afterProbe = await getSkillsPane(ctx, 5);
  const rowImportedOne = findRow(afterProbe, IMPORTED_ONE_NAME);
  assert(5, rowImportedOne?.enabled === true && rowImportedOne.sourceKind === "project", `expected an enabled project-scope row "${IMPORTED_ONE_NAME}" after apply, got ${JSON.stringify(rowImportedOne)}`);
  const rowNestedMeta = findRow(afterProbe, NESTED_META_NAME);
  assert(5, rowNestedMeta?.enabled === true && rowNestedMeta.sourceKind === "project", `expected an enabled project-scope row "${NESTED_META_NAME}" after apply (its written SKILL.md must re-parse), got ${JSON.stringify(rowNestedMeta)}`);
  const rowAlphaSuffixed = findRow(afterProbe, `${WORKSPACE_ALPHA_NAME}-2`);
  assert(5, rowAlphaSuffixed?.enabled === true && rowAlphaSuffixed.sourceKind === "project", `expected an enabled project-scope row "${WORKSPACE_ALPHA_NAME}-2" (conflict suffix) after apply, got ${JSON.stringify(rowAlphaSuffixed)}`);

  // Filesystem custody assertions (design §4 -- proven by execution).
  const importedOneDest = join(ctx.workspaceSkillsDir, IMPORTED_ONE_NAME);
  assert(5, existsSync(join(importedOneDest, "SKILL.md")), `expected ${importedOneDest}/SKILL.md to exist after apply`);
  assert(5, existsSync(join(importedOneDest, "references", "extra.md")), `expected the support file references/extra.md to be copied into ${importedOneDest}`);
  assert(5, !existsSync(join(importedOneDest, IMPORTED_ONE_OUTSIDE_LINK)), `the symlink "${IMPORTED_ONE_OUTSIDE_LINK}" must NEVER be copied into our catalog (custody by execution)`);

  const nestedMetaWritten = readFileSync(join(ctx.workspaceSkillsDir, NESTED_META_NAME, "SKILL.md"), "utf8");
  assert(5, nestedMetaWritten.includes(`name: ${NESTED_META_NAME}`), `expected the converted "${NESTED_META_NAME}" SKILL.md to carry a flat "name:" line, got:\n${nestedMetaWritten}`);
  assert(5, !nestedMetaWritten.includes("metadata:"), `expected the converted "${NESTED_META_NAME}" SKILL.md to have dropped the nested "metadata:" block, got:\n${nestedMetaWritten}`);

  const alphaSuffixedWritten = readFileSync(join(ctx.workspaceSkillsDir, `${WORKSPACE_ALPHA_NAME}-2`, "SKILL.md"), "utf8");
  assert(5, alphaSuffixedWritten.includes(`name: ${WORKSPACE_ALPHA_NAME}-2`), `expected the suffixed skill's frontmatter "name:" line to be rewritten to "${WORKSPACE_ALPHA_NAME}-2", got:\n${alphaSuffixedWritten}`);

  pass(5, `3 candidates scanned (conflict badge on zcode/alpha, conversion badge on codex/nested-meta); apply -> imported-one (support file copied, symlink NOT copied), nested-meta (re-parses), alpha-2 (suffixed, name rewritten) -- all enabled`);
}

// -- step 6: delete the freshly-imported "imported-one" -> dir + row gone --

async function step6Delete(ctx) {
  const importedOneDest = join(ctx.workspaceSkillsDir, IMPORTED_ONE_NAME);
  assert(6, existsSync(importedOneDest), `precondition: ${importedOneDest} should still exist before delete`);

  const deleted = await apiAction(ctx, 6, "/settings/skills/delete", { name: IMPORTED_ONE_NAME });
  assert(6, deleted.ok === true, `settings/skills/delete rejected: ${JSON.stringify(deleted)}`);

  assert(6, !existsSync(importedOneDest), `expected ${importedOneDest} to be removed from disk after delete`);

  const probe = await getSkillsPane(ctx, 6);
  assert(6, findRow(probe, IMPORTED_ONE_NAME) === undefined, `expected row "${IMPORTED_ONE_NAME}" to be gone from the probe after delete, got ${JSON.stringify(probe.rows)}`);

  pass(6, `"${IMPORTED_ONE_NAME}" deleted -- directory and row both gone`);
}

// -- step 7: PNG evidence of the populated pane + a fresh open import dialog --

async function step7Screenshots(ctx) {
  const probe = await getSkillsPane(ctx, 7);
  assert(7, probe.rows.length > 0, `expected the skills pane to still be mounted with rows for the final screenshot, got ${JSON.stringify(probe)}`);
  await saveScreenshot(ctx, "step7-skills-pane-final");

  const opened = await apiAction(ctx, 7, "/settings/skills/import/open", {});
  assert(7, opened.ok === true, `settings/skills/import/open (final) rejected: ${JSON.stringify(opened)}`);
  const importProbe = await getSkillsPane(ctx, 7);
  assert(7, importProbe.importOpen === true, `expected the import dialog to be open for the final screenshot, got ${JSON.stringify(importProbe.importOpen)}`);
  await saveScreenshot(ctx, "step7-skills-import-dialog-final");

  pass(7, "PNG evidence captured: populated pane + open import dialog");
}

// -- teardown --

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
      // best-effort -- the app/tab may already be gone.
    }
  }

  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      console.warn(`[skills-ui-smoke] app did not exit within ${APP_EXIT_GRACE_MS}ms of /quit -- escalating SIGTERM`);
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        console.warn(`[skills-ui-smoke] app still alive ${SIGTERM_GRACE_MS}ms after SIGTERM -- escalating SIGKILL`);
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }

  for (const dir of [ctx.workspace, ctx.importHome, ctx.profile]) {
    if (!dir || !existsSync(dir)) {
      continue;
    }
    if (FLAGS.keep) {
      console.log(`[skills-ui-smoke] --keep set, preserved: ${dir}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[skills-ui-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
    }
  }

  const verdict = failedStep === null ? "ALL GREEN" : `FAILED (stopped at step ${failedStep})`;
  console.log(`\n[skills-ui-smoke] ${passCount}/${TOTAL_STEPS} steps passed -- ${verdict}`);
}

// -- orchestration --

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[skills-ui-smoke] received ${signal} -- tearing down...`);
    teardown(ctx, `signal:${signal}`)
      .catch((err) => console.error(`[skills-ui-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    workspace: null,
    workspaceSkillsDir: null,
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
    screenshotDir: join(desktopRoot, "out", "skills-smoke"),
  };
  installSignalTeardown(ctx);

  let failedStep = null;
  try {
    step1BootstrapFixtures(ctx);
    await step2LaunchAndCreateTab(ctx);
    await step3OpenPaneAndAssertRows(ctx);
    await step4ToggleAndAssertDisk(ctx);
    await step5ImportOpenAndApply(ctx);
    await step6Delete(ctx);
    await step7Screenshots(ctx);
  } catch (err) {
    failedStep = err instanceof SmokeFailure ? err.step : "unknown";
    if (!(err instanceof SmokeFailure)) {
      console.error(`[skills-ui-smoke] unexpected error: ${err?.stack ?? err}`);
    }
  }

  await teardown(ctx, failedStep);
  process.exit(failedStep === null ? 0 : 1);
}

run().catch((err) => {
  console.error(`[skills-ui-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
