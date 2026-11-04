/**
 * Live GUI smoke for the sidebar's per-project session pages: drives a REAL
 * Electron dev instance over the automation HTTP channel and checks that the
 * default (capped) view keeps every project's folder fed — a busy project can
 * no longer crowd another project's folder out of the list.
 *
 * Fully isolated by construction (`ANYCODE_USER_DATA_DIR` +
 * `ANYCODE_AUTOMATION_INFO` + `ANYCODE_DB_PATH`, see automation/README.md), so
 * it can run alongside a manual dev session without touching its profile,
 * its DB or its discovery file.
 *
 * Rows are seeded through the product's own path: `POST /tabs {kind:"new"}`
 * creates a session, `POST /tabs/:id/close` turns it into a resumable row.
 * Tabs are created and closed one at a time so the peak live-tab count stays
 * at the boot tab plus one.
 *
 * Coverage boundary worth stating: a fresh profile's sessions all carry the
 * "Untitled task" fallback (a title needs a turn, and this run has no live
 * provider), so every step witnesses the pages by ROW COUNT — not by naming
 * which row came back.
 *
 * Plain node >=22, ZERO npm deps — same posture as sidebar-rowcut-smoke.mjs.
 *
 * Usage: node apps/desktop/scripts/sidebar-project-pages-smoke.mjs [--keep]
 *   --keep   leave the temp dirs and the app running (debugging)
 *
 * PNG evidence lands in apps/desktop/out/project-pages-smoke/step-*.png.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "out", "project-pages-smoke");

const KEEP = process.argv.includes("--keep");
const LAUNCH_TIMEOUT_MS = 180_000;

const temp = mkdtempSync(join(tmpdir(), "anycode-project-pages-"));
const userDataDir = join(temp, "user-data");
const dbPath = join(temp, "anycode.sqlite");
const infoPath = join(temp, "automation.json");
// Realpath'd below: on macOS `/var/folders/…` is a symlink to `/private/var/…`
// and main resolves workspaces, so the sidebar heading carries the resolved
// path — comparing against the unresolved one finds no group at all.
let wsBusy = join(temp, "project-busy");
let wsQuiet = join(temp, "project-quiet");
// The app always boots one tab; its workspace shows up as a third group and
// that is fine — the assertions only name the two groups under test.
const wsBoot = join(temp, "project-boot");
for (const dir of [userDataDir, wsBusy, wsQuiet, wsBoot, evidenceDir]) {
  mkdirSync(dir, { recursive: true });
}
wsBusy = realpathSync(wsBusy);
wsQuiet = realpathSync(wsQuiet);

let child = null;
let base = null;
let token = null;
let failed = false;

function log(step, ok, detail) {
  if (!ok) {
    failed = true;
  }
  console.log(`[${step}] ${ok ? "PASS" : "FAIL"} ${detail}`);
}

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return body;
}

const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launch() {
  child = spawn("node", ["node_modules/.bin/../electron-vite/bin/electron-vite.js", "dev"], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ANYCODE_AUTOMATION: "1",
      ANYCODE_USER_DATA_DIR: userDataDir,
      ANYCODE_AUTOMATION_INFO: infoPath,
      ANYCODE_DB_PATH: dbPath,
      ANYCODE_WORKSPACE: wsBoot,
      // A deliberately dead base URL: this smoke never runs a turn, it only
      // needs tabs/sessions to exist, and nothing may leave the machine.
      ANYCODE_API_KEY: "project-pages-smoke",
      ANYCODE_MODEL: "smoke-model",
      ANYCODE_BASE_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const keep = (chunk) => {
    tail.push(chunk.toString());
    if (tail.length > 40) tail.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) {
      const info = JSON.parse(readFileSync(infoPath, "utf8"));
      base = `http://127.0.0.1:${info.port}`;
      token = info.token;
      try {
        const health = await api("/health");
        return health;
      } catch {
        /* server still coming up */
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`dev exited early (${child.exitCode})\n${tail.join("")}`);
    }
    await sleep(500);
  }
  throw new Error(`no discovery file within ${LAUNCH_TIMEOUT_MS} ms\n${tail.join("")}`);
}

/**
 * The HTTP server answers before the renderer has installed
 * `window.__anycodeAutomation`, so every facade-backed route 503s
 * (`facade_not_installed`) for the first seconds. Wait for the facade itself,
 * not merely for `/health`.
 */
async function waitForFacade() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await api("/sidebar/groups");
      return true;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("facade never installed");
}

/**
 * Creates `total` tabs in `workspace`, closing each one when the NEXT tab has
 * been created — the product path to resumable rows. The one-create lag gives
 * every host its bind window: a tab closed before the handshake leaves NO
 * session row at all (the close-without-bind churn rule), so an immediate
 * close would seed nothing.
 */
async function seedGroup(workspace, total) {
  let prev = null;
  for (let i = 0; i < total; i += 1) {
    const result = await post("/tabs", { kind: "new", workspace });
    if (!result.ok) {
      throw new Error(`seed ${workspace} #${i} -> ${JSON.stringify(result)}`);
    }
    if (prev !== null) {
      await post(`/tabs/${prev}/close`, {});
    }
    prev = result.tabId;
  }
  if (prev !== null) {
    await sleep(2000); // the last host gets its bind window too
    await post(`/tabs/${prev}/close`, {});
  }
}

const groupFor = (groups, workspace) => groups.find((g) => g.workspace === workspace) ?? null;

/** Polls until `probe` returns true (the session index settles asynchronously). */
async function settle(probe, what, deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await api("/sidebar/groups");
    if (probe(last)) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`never settled: ${what} (last: ${JSON.stringify(last?.map((g) => [g.workspace, g.rowTitles.length]))})`);
}

async function shot(name) {
  const { png } = await api("/screenshot");
  const file = join(evidenceDir, `${name}.png`);
  writeFileSync(file, Buffer.from(png, "base64"));
  return file;
}

async function main() {
  const health = await launch();
  log("boot", health.ok === true, `dev up, pid ${health.pid}, version ${health.version}`);
  await waitForFacade();

  // ── seed the DoD scenario: the quiet project's 3 rows FIRST (so they are the
  // oldest in the profile), then 60 fresh rows in the busy one. Sessions list
  // newest-first, so a GLOBAL page cap would fill up with busy rows and leave
  // the quiet folder empty — only a per-project cap keeps both folders fed. ──
  await seedGroup(wsQuiet, 3);
  await seedGroup(wsBusy, 60);
  const settled = await settle(
    (groups) => {
      const busy = groupFor(groups, wsBusy);
      const quiet = groupFor(groups, wsQuiet);
      return busy !== null && busy.rowTitles.length === 5 && busy.more?.label === "Show 45 more" && quiet !== null;
    },
    "default view with both folders fed",
  );

  const busy = groupFor(settled, wsBusy);
  const quiet = groupFor(settled, wsQuiet);
  log(
    "1 both-folders-visible",
    busy !== null && quiet !== null && busy.rowTitles.length === 5 && quiet.rowTitles.length === 3,
    `busy draws ${busy?.rowTitles.length} rows, quiet draws ${quiet?.rowTitles.length} rows`,
  );
  log(
    "2 per-group-cut",
    busy?.more?.label === "Show 45 more" && quiet?.more === null,
    `busy toggle=${JSON.stringify(busy?.more)}, quiet toggle=${JSON.stringify(quiet?.more)}`,
  );
  console.log(`       evidence: ${await shot("step-1-default")}`);

  // ── expanding the busy group shows the per-project page (50 rows, not 60) ──
  await post("/sidebar/groups/more", { workspace: wsBusy });
  const expanded = groupFor(await settle((groups) => groupFor(groups, wsBusy)?.rowTitles.length === 50, "busy expansion"), wsBusy);
  log(
    "3 busy-page-bound",
    expanded?.rowTitles.length === 50 && expanded?.more?.label === "Show less",
    `expanded -> ${expanded?.rowTitles.length} rows (60 exist — the page holds the most recent 50), toggle=${JSON.stringify(expanded?.more)}`,
  );
  console.log(`       evidence: ${await shot("step-2-expanded")}`);

  await post("/sidebar/groups/more", { workspace: wsBusy });
  await settle((groups) => groupFor(groups, wsBusy)?.rowTitles.length === 5, "busy recut");

  // ── a search query reaches rows beyond the page: the full list loads, the cut lifts ──
  await post("/sidebar/filter", { query: "Untitled" });
  const filtered = await settle(
    (groups) => groupFor(groups, wsBusy)?.rowTitles.length === 60 && groupFor(groups, wsQuiet)?.rowTitles.length === 3,
    "filtered full list",
  );
  log(
    "4 search-reaches-full-list",
    groupFor(filtered, wsBusy)?.rowTitles.length === 60 && groupFor(filtered, wsQuiet)?.rowTitles.length === 3,
    `query "Untitled" -> busy=${groupFor(filtered, wsBusy)?.rowTitles.length} quiet=${groupFor(filtered, wsQuiet)?.rowTitles.length} rows drawn`,
  );
  console.log(`       evidence: ${await shot("step-3-filtered")}`);

  await post("/sidebar/filter", { query: "" });
  const cleared = await settle(
    (groups) => groupFor(groups, wsBusy)?.rowTitles.length === 5 && groupFor(groups, wsQuiet)?.rowTitles.length === 3,
    "cleared default view",
  );
  log(
    "5 filter-cleared",
    groupFor(cleared, wsBusy)?.rowTitles.length === 5 && groupFor(cleared, wsQuiet)?.rowTitles.length === 3,
    `cleared -> busy=${groupFor(cleared, wsBusy)?.rowTitles.length} quiet=${groupFor(cleared, wsQuiet)?.rowTitles.length} rows drawn`,
  );
}

try {
  await main();
} catch (err) {
  failed = true;
  console.log(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (!KEEP) {
    try {
      if (base && token) {
        await post("/quit", {});
      }
    } catch {
      /* already gone */
    }
    await sleep(2000);
    child?.kill("SIGTERM");
    // Electron keeps writing its profile while it shuts down, so a single rm
    // races it (ENOTEMPTY on user-data). Retry, and never let cleanup decide
    // the run's verdict.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(temp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
  } else {
    console.log(`[keep] temp profile: ${temp}`);
  }
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}
