/**
 * Live GUI smoke for the sidebar row cut (TASK.125): drives a REAL Electron dev
 * instance over the automation HTTP channel and checks the three rules the cut
 * is built on — the cut itself + its toggle, open rows never hidden, and an
 * active filter lifting the cut.
 *
 * Fully isolated by construction (`ANYCODE_USER_DATA_DIR` +
 * `ANYCODE_AUTOMATION_INFO` + `ANYCODE_DB_PATH`, see automation/README.md), so
 * it can run alongside a manual dev session without touching its profile,
 * its DB or its discovery file.
 *
 * Rows are seeded through the product's own path: `POST /tabs {kind:"new"}`
 * creates a session, `POST /tabs/:id/close` turns it into a resumable row.
 * Tabs are created and closed one at a time so the peak host count stays low.
 *
 * Coverage boundary worth stating: a fresh profile's sessions all carry the
 * "Untitled task" fallback (a title needs a turn, and this run has no live
 * provider), so step 6 witnesses the lifted cut by ROW COUNT and the absent
 * toggle — not by naming which row came back.
 *
 * Plain node >=22, ZERO npm deps — same posture as sidebar-ui-smoke.mjs.
 *
 * Usage: node apps/desktop/scripts/sidebar-rowcut-smoke.mjs [--keep]
 *   --keep   leave the temp dirs and the app running (debugging)
 *
 * PNG evidence lands in apps/desktop/out/rowcut-smoke/step-*.png.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const evidenceDir = join(desktopRoot, "out", "rowcut-smoke");

const KEEP = process.argv.includes("--keep");
const LAUNCH_TIMEOUT_MS = 180_000;

const temp = mkdtempSync(join(tmpdir(), "anycode-rowcut-"));
const userDataDir = join(temp, "user-data");
const dbPath = join(temp, "anycode.sqlite");
const infoPath = join(temp, "automation.json");
// Realpath'd below: on macOS `/var/folders/…` is a symlink to `/private/var/…`
// and main resolves workspaces, so the sidebar heading carries the resolved
// path — comparing against the unresolved one finds no group at all.
let wsA = join(temp, "project-alpha");
let wsB = join(temp, "project-beta");
// The app always boots one tab; give it a workspace of its own so it neither
// pollutes the two groups under test nor eats their MAX_TABS (8) budget.
const wsBoot = join(temp, "project-boot");
for (const dir of [userDataDir, wsA, wsB, wsBoot, evidenceDir]) {
  mkdirSync(dir, { recursive: true });
}
wsA = realpathSync(wsA);
wsB = realpathSync(wsB);

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
      ANYCODE_API_KEY: "rowcut-smoke",
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

/** Creates `total` tabs in `workspace`, closing all but the last `keepOpen` — the product path to a group of resumable rows. */
async function seedGroup(workspace, total, keepOpen) {
  const created = [];
  for (let i = 0; i < total; i += 1) {
    const result = await post("/tabs", { kind: "new", workspace });
    if (!result.ok) {
      throw new Error(`seed ${workspace} #${i} -> ${JSON.stringify(result)}`);
    }
    created.push(result.tabId);
    // Close eagerly so the peak host count stays near `keepOpen`.
    if (created.length > keepOpen) {
      await post(`/tabs/${created[created.length - 1 - keepOpen]}/close`, {});
    }
  }
  return created;
}

const groupFor = (groups, workspace) => groups.find((g) => g.workspace === workspace) ?? null;

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

  // ── seed: alpha = 1 open + 7 resumable (8 rows); beta = 6 open + 2 resumable (8 rows) ──
  const bootTab = (await api("/state")).tabs[0]?.tabId ?? null;
  await seedGroup(wsA, 8, 1);
  // Retire the boot tab once alpha holds one (main refuses closing the LAST
  // tab): 1 + 6 live tabs must fit under MAX_TABS with room for the transient
  // 8th that beta's seeding opens before closing it again.
  if (bootTab) {
    await post(`/tabs/${bootTab}/close`, {});
  }
  await seedGroup(wsB, 8, 6);
  await sleep(1500); // let the session index refetch settle

  const cut = await api("/sidebar/groups");
  const alpha = groupFor(cut, wsA);
  const beta = groupFor(cut, wsB);
  log("1 groups", alpha !== null && beta !== null, `alpha=${alpha?.rowTitles.length} beta=${beta?.rowTitles.length} rows drawn`);

  log(
    "2 cut",
    alpha?.rowTitles.length === 5 && alpha?.more?.label === "Show 3 more",
    `alpha draws ${alpha?.rowTitles.length} of 8, toggle=${JSON.stringify(alpha?.more)}`,
  );

  log(
    "3 open-rows-never-hidden",
    beta?.rowTitles.length === 6 && beta?.more?.label === "Show 2 more",
    `beta draws ${beta?.rowTitles.length} (6 live tabs push the cut past the limit), toggle=${JSON.stringify(beta?.more)}`,
  );
  console.log(`       evidence: ${await shot("step-1-cut")}`);

  // ── the toggle ──
  const more = await post("/sidebar/groups/more", { workspace: wsA });
  const expanded = groupFor(await api("/sidebar/groups"), wsA);
  log(
    "4 show-more",
    more.ok === true && expanded?.rowTitles.length === 8 && expanded?.more?.label === "Show less",
    `click -> ${expanded?.rowTitles.length} rows, toggle=${JSON.stringify(expanded?.more)}`,
  );
  console.log(`       evidence: ${await shot("step-2-expanded")}`);

  const back = await post("/sidebar/groups/more", { workspace: wsA });
  const recut = groupFor(await api("/sidebar/groups"), wsA);
  log(
    "5 show-less",
    back.ok === true && recut?.rowTitles.length === 5,
    `click again -> ${recut?.rowTitles.length} rows, toggle=${JSON.stringify(recut?.more)}`,
  );

  // ── the rule that matters most: a filter reaches a row the cut hides ──
  const hiddenTitle = expanded?.rowTitles[7] ?? "";
  await post("/sidebar/filter", { query: hiddenTitle });
  await sleep(300);
  const filtered = groupFor(await api("/sidebar/groups"), wsA);
  log(
    "6 filter-lifts-cut",
    filtered !== null && filtered.rowTitles.includes(hiddenTitle) && filtered.more === null,
    `query ${JSON.stringify(hiddenTitle)} -> rows=${JSON.stringify(filtered?.rowTitles)}, toggle=${JSON.stringify(filtered?.more)}`,
  );
  console.log(`       evidence: ${await shot("step-3-filtered")}`);

  await post("/sidebar/filter", { query: "" });
  await sleep(300);
  const cleared = groupFor(await api("/sidebar/groups"), wsA);
  log(
    "7 filter-cleared",
    cleared?.rowTitles.length === 5 && cleared?.more?.label === "Show 3 more",
    `cleared -> ${cleared?.rowTitles.length} rows, toggle=${JSON.stringify(cleared?.more)}`,
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
