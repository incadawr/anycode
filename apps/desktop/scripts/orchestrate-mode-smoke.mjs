/**
 * Live smoke for Taskana 4704 part B (Orchestrate mode UI) — drives a REAL
 * Electron dev instance over the automation HTTP channel, no model calls
 * (the turn is never started; only UI state and settings persistence are
 * asserted). Proves what the unit gate structurally cannot, because each
 * step is a statement about the REAL renderer DOM, the REAL wire, and the
 * REAL settings.json:
 *
 *   A. The ModeMenu popover lists the five permission modes PLUS an
 *      "Orchestrate" row (a divider-separated toggle, not mode #6), read off
 *      the rendered nodes.
 *   B. Clicking the REAL Orchestrate row with no roles configured opens the
 *      first-run RolePickerDialog — wait: the row toggles orchestrate
 *      directly; the DIALOG comes from /orchestrate (step D). Here B just
 *      proves the toggle flips the row to checked and the store's ack
 *      (`orchestrate_changed`) landed (aria-checked flips).
 *   C. The RolePickerDialog flow via `/orchestrate`: typing the slash
 *      command shows the row, submitting with no roles opens the dialog,
 *      clicking a preset + Save writes `roles` into the REAL settings.json
 *      and submits the stashed task as a user message.
 *   D. With roles present, `/orchestrate <task>` submits immediately (no
 *      dialog).
 *
 * Reuse: launch/teardown helpers are local adaptations of
 * settings-ui-smoke.mjs (per-run disposable profile; this smoke seeds a
 * THROWAWAY settings file via ANYCODE_SETTINGS_PATH so the roles write lands
 * in a temp file, never the owner's real settings).
 *
 * Usage: node apps/desktop/scripts/orchestrate-mode-smoke.mjs [--keep] [--port <n>]
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "evidence", "taskana-4704");
const DISCOVERY_PATH_DEFAULT = join(repoRoot, ".anycode", "automation.json");

const LAUNCH_TIMEOUT_MS = 180_000;
const POLL_MS = 400;

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { keep: false, port: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      flags.keep = true;
    } else if (arg === "--port") {
      i += 1;
      flags.port = argv[i];
    } else {
      console.warn(`[orchestrate-mode-smoke] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

// ── process/fs helpers (same as settings-ui-smoke.mjs) ──

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

function killTree(pid, signal) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // already gone
  }
}

// ── step bookkeeping ──

class SmokeFailure extends Error {}

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const line = `[step ${name}] ${status} ${detail ?? ""}`.trimEnd();
  if (status === "PASS") {
    console.log(line);
  } else {
    console.error(line);
  }
}

function assert(name, cond, detail) {
  if (!cond) {
    throw new SmokeFailure(`${name}: ${detail}`);
  }
}

// ── HTTP helpers ──

async function api(ctx, method, path, body) {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const resp = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, json };
}

async function apiOk(ctx, step, method, path, body) {
  const resp = await api(ctx, method, path, body);
  if (resp.status !== 200) {
    throw new SmokeFailure(`${step}: HTTP ${resp.status} from ${path}: ${JSON.stringify(resp.json).slice(0, 300)}`);
  }
  return resp.json;
}

// ── the smoke ──

async function main() {
  // Per-run disposable EVERYTHING, including the settings file and a TEMP
  // SECRETS VAULT — the roles write must land in a throwaway, never the
  // owner's real settings.json. Provider readiness (tab creation needs it)
  // is seeded by MIRRORING the owner's real ACTIVE connection + its vault
  // apiKey entry into the temp settings/vault (read from the real files,
  // never printed).
  const profile = mkdtempSync(join(tmpdir(), "anycode-orchestrate-mode-smoke-"));
  const settingsPath = join(profile, "settings.json");
  const secretsPath = join(profile, "secrets.json");
  const workspace = join(profile, "workspace");
  const evidenceSettingsPath = join(profile, "settings-after.json");
  execFileSync("mkdir", ["-p", workspace]);

  // Mirror the real active connection (id/providerId/model/baseUrl) + its
  // `provider.connection.<id>.apiKey` vault entry into the temp files. The
  // DEFAULT user locations are read deliberately — ambient env overrides
  // (a wrapper session's ANYCODE_* pointing at lab profiles) are ignored so
  // this smoke always seeds from the owner's real, working provider.
  const realSettingsPath = join(process.env.HOME ?? "", ".anycode", "settings.json");
  const realSecretsPath = join(process.env.HOME ?? "", ".anycode", "secrets.json");
  let activeId = null;
  try {
    const real = JSON.parse(readFileSync(realSettingsPath, "utf8"));
    const conns = real?.provider?.connections ?? [];
    activeId = real?.provider?.activeConnectionId ?? conns.find((c) => c?.id)?.id ?? null;
    const active = conns.find((c) => c?.id === activeId) ?? null;
    if (active === null) {
      throw new Error(`no provider connection found in ${realSettingsPath}`);
    }
    const seedSettings = {
      version: 2,
      provider: {
        activeConnectionId: active.id,
        connections: [
          {
            id: active.id,
            providerId: active.providerId,
            model: active.model,
            ...(active.baseUrl !== undefined ? { baseUrl: active.baseUrl } : {}),
          },
        ],
      },
      tools: {},
      permissions: { alwaysAllow: [{ toolName: "Read" }, { toolName: "Glob" }, { toolName: "Grep" }] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: true },
    };
    writeFileSync(settingsPath, JSON.stringify(seedSettings, null, 2) + "\n", "utf8");
    const vault = JSON.parse(readFileSync(realSecretsPath, "utf8"));
    const key = `provider.connection.${active.id}.apiKey`;
    const entry = vault?.entries?.[key];
    if (typeof entry !== "object" || entry === null || typeof entry.value !== "string" || entry.value.length === 0) {
      throw new Error(`vault entry ${key} missing in ${realSecretsPath}`);
    }
    // Copy the entry OBJECT verbatim (cipher:"safeStorage" ciphertext is
    // machine/app-bound, not vault-file-bound — same Electron app on the
    // same host decrypts it identically from the temp vault).
    writeFileSync(
      secretsPath,
      JSON.stringify({ version: vault?.version ?? 1, entries: { [key]: entry } }, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    console.error(`[orchestrate-mode-smoke] credential seed failed: ${err?.message ?? err}`);
    console.error("(tab creation needs a ready provider; this smoke mirrors the owner's active connection into a temp profile)");
    process.exit(1);
  }

  const ctx = {
    child: null,
    appPid: null,
    port: undefined,
    token: undefined,
  };

  const evidence = { steps: {}, settingsRoles: null, launchedAt: new Date().toISOString() };
  try {
    // Step 1: launch the dev app with automation on.
    const t0 = Date.now();
    const env = {
      ...process.env,
      ANYCODE_AUTOMATION: "1",
      ANYCODE_USER_DATA_DIR: join(profile, "user-data"),
      ANYCODE_DB_PATH: join(profile, "db.sqlite"),
      ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
      ANYCODE_SETTINGS_PATH: settingsPath,
      ANYCODE_SECRETS_PATH: secretsPath,
      // An env model override would mask the seeded connection's model
      // (same discipline as child-session-explicit-provider-smoke).
      ...(process.env.ANYCODE_MODEL !== undefined ? {} : {}),
    };
    delete env.ANYCODE_MODEL;
    delete env.ANYCODE_REASONING_EFFORT;
    delete env.ANYCODE_API_KEY;
    delete env.ANYCODE_BASE_URL;
    if (FLAGS.port !== undefined) {
      env.ANYCODE_AUTOMATION_PORT = String(FLAGS.port);
    }
    ctx.child = spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });

    const discoveryPath = env.ANYCODE_AUTOMATION_INFO;
    let info = null;
    while (Date.now() < t0 + LAUNCH_TIMEOUT_MS) {
      if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) {
        throw new SmokeFailure(`1: dev process exited early (code=${ctx.child.exitCode})`);
      }
      const candidate = readDiscoveryFile(discoveryPath);
      if (candidate !== null && candidate.startedAt > t0 && isPidAlive(candidate.pid)) {
        info = candidate;
        break;
      }
      await sleep(500);
    }
    if (info === null) {
      throw new SmokeFailure(`1: timed out waiting for ${discoveryPath}`);
    }
    ctx.port = info.port;
    ctx.token = info.token;
    ctx.appPid = info.pid;
    record("1-launch", "PASS", `pid=${info.pid} port=${info.port}`);

    // Step 2: create a tab on the throwaway workspace and wait ready.
    // Renderer-facade race discipline (child-session-explicit-provider-smoke):
    // a freshly created tab's renderer mounts asynchronously, so facade calls
    // 503 with facade_not_installed until then — wait via POST /wait, and
    // tolerate a transient 503 on select.
    const created = await apiOk(ctx, "2", "POST", "/tabs", { kind: "new", workspace });
    const tabId = created?.tabId ?? created?.tab?.tabId;
    assert("2-tab", typeof tabId === "string" && tabId.length > 0, `create tab returned ${JSON.stringify(created).slice(0, 200)}`);
    let waited = null;
    for (let i = 0; i < 60 && waited === null; i += 1) {
      try {
        const r = await api(ctx, "POST", "/wait", { tabId, until: { connection: "ready" }, timeoutMs: 60_000 });
        if (r.status === 200) {
          waited = r.json;
        } else if (r.status !== 503) {
          throw new SmokeFailure(`2: HTTP ${r.status} from /wait: ${JSON.stringify(r.json).slice(0, 200)}`);
        }
      } catch (err) {
        if (err instanceof SmokeFailure) {
          throw err;
        }
        // transport hiccup — retry
      }
      if (waited === null) {
        await sleep(700);
      }
    }
    assert("2-ready", waited?.matched === true, `tab never reached connection=ready: ${JSON.stringify(waited).slice(0, 200)}`);
    let selected = false;
    for (let i = 0; i < 30 && !selected; i += 1) {
      try {
        const r = await api(ctx, "POST", `/tabs/${encodeURIComponent(tabId)}/select`, {});
        selected = r.status === 200 && r.json?.ok === true;
      } catch {
        // retry
      }
      if (!selected) {
        await sleep(500);
      }
    }
    assert("2-select", selected, "tab select never succeeded (facade_not_installed race?)");
    record("2-tab", "PASS", `tabId=${tabId}`);

    // Step 3: ModeMenu lists Orchestrate after the five modes.
    await apiOk(ctx, "3", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-chip`, {});
    let menu = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(300);
      menu = await apiOk(ctx, "3", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu`, {});
      if (menu?.open) {
        break;
      }
    }
    assert("3-open", menu?.open === true, "mode menu popover did not open");
    const names = (menu?.rows ?? []).map((r) => r.name);
    const modes = ["plan", "build", "edit", "auto", "yolo"];
    for (const mode of modes) {
      assert("3-modes", names.includes(mode), `mode row ${mode} missing (rows: ${names.join(",")})`);
    }
    assert("3-orchestrate-row", names.includes("Orchestrate"), `Orchestrate row missing (rows: ${names.join(",")})`);
    assert("3-position", names.indexOf("Orchestrate") === 5, `Orchestrate must sit AFTER the five modes (rows: ${names.join(",")})`);
    const orchestrateRow = (menu?.rows ?? []).find((r) => r.name === "Orchestrate");
    assert("3-unchecked", orchestrateRow?.checked === false, "Orchestrate row must start unchecked");
    evidence.steps.modeMenuRows = names;
    record("3-mode-menu", "PASS", `rows=[${names.join(",")}]`);

    // Step 4: clicking the REAL Orchestrate row flips it to checked (the
    // wire ack lands in the store; the host is real). The session also moves
    // to plan — but the chip label read covers that indirectly; assert the
    // row state itself.
    const clicked = await apiOk(ctx, "4", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-row`, { name: "Orchestrate" });
    assert("4-click", clicked?.ok === true, `click-row returned ${JSON.stringify(clicked)}`);
    let checked = false;
    let chipLabel = "";
    for (let i = 0; i < 25 && !checked; i += 1) {
      await sleep(200);
      // Re-open the popover (the click committed it closed).
      await apiOk(ctx, "4", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-chip`, {});
      const st = await apiOk(ctx, "4", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu`, {});
      chipLabel = st?.chipLabel ?? "";
      const row = (st?.rows ?? []).find((r) => r.name === "Orchestrate");
      checked = row?.checked === true;
      if (!checked) {
        await apiOk(ctx, "4", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-chip`, {});
      }
    }
    assert("4-checked", checked, "Orchestrate row never became checked after the real click (orchestrate_changed ack missing?)");
    assert("4-plan", /plan/i.test(chipLabel), `chip label should read plan while orchestrate (got "${chipLabel}")`);
    evidence.steps.chipLabelWhileOrchestrate = chipLabel;
    record("4-toggle-on", "PASS", `chip="${chipLabel}"`);

    // Step 5: /orchestrate command row appears while typing the token.
    // (The slash menu only opens while the caret sits in the FIRST token —
    // slashQueryAt returns null once a space follows — so the real user flow
    // is: type "/orchestrate", Enter (row dispatch), then type the task.)
    // Turn orchestrate OFF first to reset to the first-run state.
    await apiOk(ctx, "5", "POST", `/tabs/${encodeURIComponent(tabId)}/orchestrate`, { enabled: false });
    await sleep(600);
    await apiOk(ctx, "5", "POST", `/tabs/${encodeURIComponent(tabId)}/slash-menu/type`, { text: "/orchestrate" });
    let slash = null;
    for (let i = 0; i < 20; i += 1) {
      slash = await apiOk(ctx, "5", "GET", `/tabs/${encodeURIComponent(tabId)}/slash-menu`);
      if (slash?.open && (slash?.items ?? []).some((it) => it.name === "Orchestrate")) {
        break;
      }
      await sleep(150);
    }
    assert("5-row", slash?.open === true && (slash?.items ?? []).some((it) => it.name === "Orchestrate"), `/orchestrate command row missing: ${JSON.stringify(slash)?.slice(0, 200)}`);
    evidence.steps.slashRowSeen = true;
    record("5-slash-row", "PASS", "Orchestrate command row rendered");

    // Step 6: press Enter -> first-run dialog opens (no roles in settings).
    await apiOk(ctx, "6", "POST", `/tabs/${encodeURIComponent(tabId)}/slash-menu/key`, { key: "Enter" });
    let picker = null;
    for (let i = 0; i < 25; i += 1) {
      picker = await apiOk(ctx, "6", "POST", `/tabs/${encodeURIComponent(tabId)}/role-picker/state`, {});
      if (picker?.mounted) {
        break;
      }
      await sleep(200);
    }
    assert("6-dialog", picker?.mounted === true, "RolePickerDialog did not open after /orchestrate submit with no roles configured");
    evidence.steps.dialogMounted = true;
    record("6-dialog-open", "PASS", `selectedPreset=${picker?.selectedPreset}`);

    // Step 7: click a preset (fall back through the three ids — the
    // applicable one depends on engine readiness) then Save; settings.json
    // must gain `roles`, the dialog closes, and the stashed task submits.
    const presetIds = ["claude-leads-codex-builds", "all-claude", "this-connection"];
    let picked = null;
    for (const presetId of presetIds) {
      const r = await apiOk(ctx, "7", "POST", `/tabs/${encodeURIComponent(tabId)}/role-picker/preset`, { presetId });
      if (r?.ok === true) {
        picked = presetId;
        break;
      }
    }
    assert("7-preset", picked !== null, "no preset chip could be clicked (all disabled/absent?)");
    await apiOk(ctx, "7", "POST", `/tabs/${encodeURIComponent(tabId)}/role-picker/save`, {});
    let rolesNow = null;
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      try {
        const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (doc?.roles !== undefined) {
          rolesNow = doc.roles;
          break;
        }
      } catch {
        // keep polling
      }
    }
    assert("7-roles-written", rolesNow !== null, "settings.json never gained a roles section after Save");
    assert("7-has-role", rolesNow && typeof rolesNow === "object" && Object.keys(rolesNow).length > 0, `roles section empty: ${JSON.stringify(rolesNow)}`);
    evidence.settingsRoles = rolesNow;
    evidence.steps.presetPicked = picked;
    record("7-roles-saved", "PASS", `preset=${picked} rolesKeys=${Object.keys(rolesNow).join(",")}`);

    // Step 8: the dialog closed, orchestrate turned ON by the row dispatch
    // (asserted via the mode-menu row re-probe), and a typed task then
    // submits as a normal user message (the /orchestrate flow's user path).
    let sawTask = false;
    let closed = false;
    let rechecked = false;
    for (let i = 0; i < 25 && !(closed && rechecked); i += 1) {
      const pk = await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/role-picker/state`, {});
      closed = pk?.mounted === false;
      // Open the popover and give React a beat to render before probing.
      await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-chip`, {});
      await sleep(400);
      const st = await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu`, {});
      const row = (st?.rows ?? []).find((r) => r.name === "Orchestrate");
      rechecked = row?.checked === true;
      if (!(closed && rechecked)) {
        // Close it again so the next iteration's click re-opens (toggle).
        if (st?.open === true) {
          await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/mode-menu/click-chip`, {});
        }
        await sleep(300);
      }
    }
    assert("8-dialog-closed", closed, "RolePickerDialog stayed mounted after Save");
    assert("8-orchestrate-on", rechecked, "Orchestrate row not checked after the /orchestrate dispatch + Save");
    // Type the task and submit through the composer's REAL send path.
    await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/slash-menu/type`, { text: "fix the readme" });
    await apiOk(ctx, "8", "POST", `/tabs/${encodeURIComponent(tabId)}/slash-menu/key`, { key: "Enter" });
    for (let i = 0; i < 30 && !sawTask; i += 1) {
      const st = await apiOk(ctx, "8", "GET", `/state/${encodeURIComponent(tabId)}`);
      const tabState = st?.snapshot?.states?.[tabId] ?? st?.states?.[tabId] ?? {};
      const blocks = tabState?.transcript ?? [];
      sawTask = blocks.some((b) => b?.kind === "user_text" && typeof b?.text === "string" && b.text.includes("fix the readme"));
      if (!sawTask) {
        await sleep(300);
      }
    }
    assert("8-task-submitted", sawTask, "the typed task never appeared in the transcript as a user message");
    evidence.steps.taskSubmitted = true;
    record("8-submit", "PASS", "dialog closed + orchestrate on + task submitted");

    record("9-done", "PASS", "all orchestrate-mode UI assertions passed");
  } catch (err) {
    const name = err instanceof SmokeFailure ? err.message.split(":")[0] : "unexpected";
    record(name, "FAIL", err?.message ?? String(err));
  } finally {
    // Evidence json (task145 discipline).
    try {
      if (existsSync(settingsPath)) {
        writeFileSync(evidenceSettingsPath, readFileSync(settingsPath, "utf8"), "utf8");
      }
      execFileSync("mkdir", ["-p", EVIDENCE_DIR]);
      writeFileSync(
        join(EVIDENCE_DIR, "orchestrate-mode-result.json"),
        JSON.stringify({ ...evidence, results }, null, 2) + "\n",
        "utf8",
      );
    } catch (writeErr) {
      console.warn(`[orchestrate-mode-smoke] evidence write failed: ${writeErr}`);
    }
    if (ctx.child !== null && !FLAGS.keep) {
      if (ctx.appPid !== null) {
        killTree(ctx.appPid, "SIGTERM");
      }
      try {
        killTree(-ctx.child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (!FLAGS.keep) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`[orchestrate-mode-smoke] ${results.length - failed.length}/${results.length} steps passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[orchestrate-mode-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
