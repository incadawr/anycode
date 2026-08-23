/**
 * Live smoke for TASK.145 (background/detached child sessions) — drives a REAL
 * Electron dev instance end-to-end over the automation HTTP channel and proves
 * the four things the unit gate structurally cannot, because every one of them
 * is a statement about a REAL turn boundary, a REAL second OS process, and the
 * REAL renderer prompt queue rather than about a function's return value:
 *
 *   A. `Agent(tier:"session", detach:true)` resolves at ADMIT, not at the
 *      child's terminal: the parent's turn reaches `idle` while the child's
 *      OS pid is still alive and still listed in main's `childRuns` ledger.
 *      A synchronous join makes this state unreachable by construction, so
 *      observing it once is the whole cut-1 proof.
 *   B. The child's terminal report arrives back as a NEW turn in the parent's
 *      transcript, carrying the verbatim anti-spoofing header and the
 *      `<task-notification>` block, and the model actually runs on it.
 *   C. Stop on the spawning turn does NOT kill a detached child (cut 3's
 *      reversal of cut 1's abort cascade), and the report still lands even
 *      though the cancelled turn left the renderer's prompt queue paused
 *      (cut 2's system-report pass-through). One probe, because the second
 *      invariant is only interesting in the state the first one creates.
 *   D. Closing the parent tab DOES cancel its live detached children — the
 *      registry's explicit cancel path, the counterpart to C: surviving a
 *      turn boundary must not mean surviving the session.
 *
 * REUSE: every generic process/fs/HTTP/dispatch helper is imported unmodified
 * from `child-session-explicit-provider-smoke.mjs` (the same seam
 * `child-session-race-smoke.mjs` uses), including `step1LaunchApp`, whose
 * settings v2 seed is the only one that round-trips the current schema.
 * Teardown/result-json are local so this script never overwrites another
 * slice's standing evidence — it writes `evidence/task145/detach-result.json`.
 *
 * Probes run independently, not fail-fast: A/B share one dispatch, C and D
 * each own their own, and all four share one app launch purely to amortize
 * its cost. One probe's FAIL never suppresses the others' verdicts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  api,
  apiOk,
  assert,
  getTranscriptBlocks,
  isPidAlive,
  killTree,
  saveScreenshot,
  sleep,
  step1DiscoverTab,
  step1LaunchApp,
  waitForExit,
  waitUntilTab,
} from "./child-session-explicit-provider-smoke.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const EVIDENCE_DIR = join(repoRoot, "working-docs", "evidence", "task145");

const APP_EXIT_GRACE_MS = 15_000;
const SIGTERM_GRACE_MS = 3_000;
const POLL_MS = 400;

/** Verbatim header from packages/core/src/cli/child-notification.ts — a paraphrase here would silently stop proving anything. */
const NOTIFICATION_HEADER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

/**
 * Child work long enough that the parent's own turn is guaranteed to finish
 * first — the entire point of probe A. `sleep` via Bash (always-allowed in
 * the seeded profile) is the only reliable way to make a live model burn wall
 * clock; asking it to "think for a while" is not a duration.
 */
function detachPrompt(childSleepSeconds, extraParentWork) {
  return (
    "Call the Agent tool right now, in this turn, with these exact parameter values: " +
    'tier: "session", detach: true, agent_type: "general-purpose", ' +
    "description: a short 3-5 word summary, and prompt: an instruction telling the subagent to run the " +
    `Bash command \`sleep ${childSleepSeconds}; echo CHILD_ALIVE\` and then reply with exactly the single word DONE. ` +
    "The `detach` parameter is a real boolean parameter of the Agent tool — you MUST pass it as true, and you MUST " +
    'pass tier as the literal string "session". Do not use tier "inline".' +
    (extraParentWork === undefined ? "" : ` ${extraParentWork}`)
  );
}

/** Long-running child work that holds NO tool call open — pure token generation. */
function detachPromptNoTools() {
  return (
    "Call the Agent tool right now, in this turn, with these exact parameter values: " +
    'tier: "session", detach: true, agent_type: "general-purpose", ' +
    "description: a short 3-5 word summary, and prompt: an instruction telling the subagent to write a detailed " +
    "1200-word essay about the history of the printing press, and to use NO tools at all while doing it. " +
    "The `detach` parameter is a real boolean parameter of the Agent tool — you MUST pass it as true, and you MUST " +
    'pass tier as the literal string "session". Do not use tier "inline".'
  );
}

const PARENT_KEEP_BUSY =
  "Immediately after the Agent tool call returns, call the Bash tool once with the command " +
  "`sleep 90; echo PARENT_STILL_BUSY` so that you stay busy in this same turn.";

// ── local helpers (kept product-code-free, same discipline as the race smoke) ──

async function pollUntil(predicate, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(intervalMs);
  }
}

/** Child ledger entries belonging to this tab's parent session, as main sees them. */
async function childRunsNow(ctx) {
  const resp = await api(ctx, "GET", "/state?tail=0");
  const runs = resp.body?.childRuns;
  return Array.isArray(runs) ? runs : [];
}

async function tabStateNow(ctx, tabId) {
  const resp = await api(ctx, "GET", "/state?tail=0");
  return resp.body?.snapshot?.states?.[tabId] ?? null;
}

/**
 * Sends a prompt and waits until main's ledger shows a child admitted BY THIS
 * dispatch, returning that entry. The pre-dispatch id snapshot matters: a
 * previous probe's child can still be live in the ledger, and returning it
 * here would make the probe measure the wrong process entirely.
 */
async function dispatchDetach(ctx, step, promptText, timeoutMs) {
  const before = new Set((await childRunsNow(ctx)).map((r) => r.childSessionId));
  const sent = await apiOk(ctx, step, "POST", `/tabs/${ctx.tabId}/prompt`, { text: promptText });
  assert(step, sent?.ok === true, `prompt send rejected: ${JSON.stringify(sent)}`);
  await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "running" }, 60_000);
  return pollUntil(async () => {
    const fresh = (await childRunsNow(ctx)).filter((r) => !before.has(r.childSessionId));
    // Wait for the pid too: an entry in state "starting" has none yet, and a
    // probe that needs to prove a process died cannot use a null pid.
    const withPid = fresh.find((r) => typeof r.pid === "number");
    return withPid ?? null;
  }, timeoutMs, 250);
}

function findAgentBlock(transcript) {
  return transcript.filter((b) => b.kind === "tool_call" && b.toolName === "Agent").at(-1) ?? null;
}

function transcriptHasNotification(transcript) {
  return transcript.some(
    (b) =>
      (typeof b.text === "string" && b.text.includes(NOTIFICATION_HEADER)) ||
      (typeof b.modelText === "string" && b.modelText.includes(NOTIFICATION_HEADER)),
  );
}

function notificationBlock(transcript) {
  return (
    transcript.find(
      (b) =>
        (typeof b.text === "string" && b.text.includes(NOTIFICATION_HEADER)) ||
        (typeof b.modelText === "string" && b.modelText.includes(NOTIFICATION_HEADER)),
    ) ?? null
  );
}

function probeResult(name, status, detail) {
  return { name, status, detail };
}

// ── probe A: detach resolves at admit, the parent turn ends with the child alive ──

async function probeA(ctx) {
  const step = "A";
  try {
    const entry = await dispatchDetach(ctx, step, detachPrompt(45), 120_000);
    if (entry === null) {
      ctx.skipped = true;
      return probeResult(
        "A",
        "SKIP",
        "the live model never produced an admitted detached child (no childRuns entry) — model nondeterminism, not a product failure",
      );
    }
    ctx.childEntry = entry;

    // The turn must reach idle ON ITS OWN while the child is still running.
    // A synchronous join cannot produce this pair of observations.
    const idleAt = await pollUntil(async () => {
      const state = await tabStateNow(ctx, ctx.tabId);
      return state?.turn?.status === "idle" ? Date.now() : null;
    }, 120_000);
    if (idleAt === null) {
      return probeResult("A", "FAIL", "parent turn never reached idle within 120s of admission — detach did not release the turn");
    }

    const runs = await childRunsNow(ctx);
    const stillListed = runs.find((r) => r.childSessionId === entry.childSessionId) ?? null;
    if (stillListed === null) {
      return probeResult(
        "A",
        "FAIL",
        `parent turn went idle but child ${entry.childSessionId} was already gone from the ledger — cannot distinguish detach from a fast synchronous join`,
      );
    }
    const pid = stillListed.pid;
    const alive = typeof pid === "number" && isPidAlive(pid);

    const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
    const block = findAgentBlock(transcript);
    const admitText = typeof block?.modelText === "string" ? block.modelText : "";
    const admitOk = admitText.includes("started in the background");

    await saveScreenshot(ctx, "A-parent-idle-child-alive");

    if (!alive) {
      return probeResult("A", "FAIL", `child pid ${pid} was not alive while the parent turn was idle`);
    }
    if (block?.status !== "success") {
      return probeResult("A", "FAIL", `Agent tool_call card is "${block?.status}", expected "success" at admit`);
    }
    if (!admitOk) {
      return probeResult("A", "FAIL", `Agent card result text is not the admit message: ${JSON.stringify(admitText.slice(0, 200))}`);
    }
    return probeResult("A", "PASS", `parent idle while child ${entry.childSessionId} (pid ${pid}) still running; card resolved at admit`);
  } catch (err) {
    return probeResult("A", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

// ── probe B: the terminal report comes back as a new turn ──

async function probeB(ctx) {
  const step = "B";
  if (ctx.childEntry === null) {
    return probeResult("B", "SKIP", "probe A never admitted a child — nothing to report on");
  }
  try {
    const seen = await pollUntil(async () => {
      const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
      return transcriptHasNotification(transcript) ? transcript : null;
    }, 240_000);
    if (seen === null) {
      await saveScreenshot(ctx, "B-no-report");
      return probeResult("B", "FAIL", "the detached child's report never appeared in the parent transcript within 240s");
    }

    const block = notificationBlock(seen);
    const text = (typeof block?.text === "string" ? block.text : block?.modelText) ?? "";
    const missing = [
      "<task-notification>",
      "<task-type>subagent_child</task-type>",
      `<agent-id>${ctx.childEntry.childSessionId}</agent-id>`,
      "<subagent-type>general-purpose</subagent-type>",
      "<status>",
    ].filter((needle) => !text.includes(needle));

    // The report is only useful if the model then RUNS on it — a block that
    // lands in the transcript without starting a turn is a dead letter.
    const ran = await pollUntil(async () => {
      const state = await tabStateNow(ctx, ctx.tabId);
      return state?.turn?.status === "running" ? true : null;
    }, 30_000);
    await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 180_000).catch(() => {});
    await saveScreenshot(ctx, "B-report-delivered");

    const drained = await pollUntil(async () => {
      const runs = await childRunsNow(ctx);
      return runs.length === 0 ? true : null;
    }, 30_000);

    if (missing.length > 0) {
      return probeResult("B", "FAIL", `report block is missing: ${missing.join(", ")}`);
    }
    if (ran === null) {
      return probeResult("B", "FAIL", "report landed in the transcript but never started a turn (dead letter)");
    }
    if (drained === null) {
      return probeResult("B", "FAIL", "child ledger entry survived its own terminal report");
    }
    return probeResult("B", "PASS", "report delivered with the verbatim header + full task-notification block, and the model ran on it");
  } catch (err) {
    return probeResult("B", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

// ── probe C: Stop spares the detached child; the report survives a paused queue ──

async function probeC(ctx) {
  const step = "C";
  try {
    const entry = await dispatchDetach(ctx, step, detachPrompt(35, PARENT_KEEP_BUSY), 120_000);
    if (entry === null) {
      return probeResult("C", "SKIP", "the live model never produced an admitted detached child on this dispatch");
    }
    const pid = entry.pid;

    // Stop while the spawning turn is still running — the exact cascade cut 3 removed.
    const stopped = await api(ctx, "POST", `/tabs/${ctx.tabId}/stop`, {});
    assert(step, stopped.status === 200, `stop -> HTTP ${stopped.status}`);
    await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 60_000).catch(() => {});

    await sleep(5_000);
    const runsAfterStop = await childRunsNow(ctx);
    const survived = runsAfterStop.some((r) => r.childSessionId === entry.childSessionId);
    const pidAlive = typeof pid === "number" && isPidAlive(pid);
    await saveScreenshot(ctx, "C-after-stop");

    if (!survived || !pidAlive) {
      return probeResult(
        "C",
        "FAIL",
        `Stop killed the detached child (ledger=${survived}, pidAlive=${pidAlive}) — the abort cascade is still armed`,
      );
    }

    // The cancelled turn leaves the renderer's prompt queue paused; a system
    // report must still get through, or an autonomous chain silently stalls.
    const before = (await getTranscriptBlocks(ctx, step, ctx.tabId)).transcript.length;
    const landed = await pollUntil(async () => {
      const { transcript } = await getTranscriptBlocks(ctx, step, ctx.tabId);
      const later = transcript.slice(before);
      return later.some(
        (b) =>
          (typeof b.text === "string" && b.text.includes(NOTIFICATION_HEADER)) ||
          (typeof b.modelText === "string" && b.modelText.includes(NOTIFICATION_HEADER)),
      )
        ? true
        : null;
    }, 240_000);
    await saveScreenshot(ctx, "C-report-after-paused-queue");
    await waitUntilTab(ctx, step, ctx.tabId, { turnStatus: "idle" }, 180_000).catch(() => {});

    if (landed === null) {
      return probeResult("C", "FAIL", "child survived Stop but its report never drained through the paused prompt queue");
    }
    return probeResult("C", "PASS", `child ${entry.childSessionId} (pid ${pid}) survived Stop and its report drained past the paused queue`);
  } catch (err) {
    return probeResult("C", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

// ── probe D: closing the parent tab cancels its live detached children ──

async function probeD(ctx) {
  const step = "D";
  try {
    const entry = await dispatchDetach(ctx, step, detachPrompt(FLAGS.dChildSleep), 120_000);
    if (entry === null) {
      return probeResult("D", "SKIP", "the live model never produced an admitted detached child on this dispatch");
    }
    const pid = entry.pid;
    if (typeof pid !== "number") {
      return probeResult("D", "SKIP", `admitted child has no pid yet (state=${entry.state}) — cannot prove the kill`);
    }

    // The app refuses to close the LAST visible tab (`reason:"last_tab"`);
    // child tabs are hidden and do not count. Without a second tab the close
    // silently no-ops with HTTP 200 + ok:false, and every "the child outlived
    // the close" verdict below would be measuring a close that never happened.
    const spare = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    assert(step, spare?.ok === true, `could not open a spare tab before closing the parent: ${JSON.stringify(spare)}`);

    const closed = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
    assert(step, closed.status === 200, `close -> HTTP ${closed.status}`);
    assert(step, closed.body?.ok === true, `close refused: ${JSON.stringify(closed.body)}`);

    const closedAt = Date.now();
    const dead = await pollUntil(async () => (isPidAlive(pid) ? null : true), FLAGS.dTimeout * 1_000);
    const elapsedMs = Date.now() - closedAt;
    const runsAfter = await childRunsNow(ctx);
    const ledgerClear = !runsAfter.some((r) => r.childSessionId === entry.childSessionId);

    if (dead === null) {
      return probeResult(
        "D",
        "FAIL",
        `orphan: child pid ${pid} still alive ${FLAGS.dTimeout}s after its parent tab was closed (child work was ${FLAGS.dChildSleep}s)`,
      );
    }
    if (!ledgerClear) {
      return probeResult("D", "FAIL", `child ${entry.childSessionId} still in the ledger after its parent tab was closed`);
    }
    return probeResult("D", "PASS", `closing the parent tab killed detached child pid ${pid} after ${elapsedMs}ms (child work was ${FLAGS.dChildSleep}s) and cleared the ledger`);
  } catch (err) {
    return probeResult("D", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

// ── probe E (diagnostic): what main actually does with a detached child when
// its parent tab closes. Probe D can only say "the pid outlived the close";
// this one watches the ledger, the tab list and the pid together, second by
// second, so the failure has a mechanism attached to it rather than a symptom.

async function probeE(ctx) {
  const step = "E";
  try {
    const entry = await dispatchDetach(ctx, step, detachPrompt(120), 120_000);
    if (entry === null) {
      return probeResult("E", "SKIP", "the live model never produced an admitted detached child on this dispatch");
    }
    const pid = entry.pid;
    const parentTabId = ctx.tabId;

    const before = await api(ctx, "GET", "/state?tail=0");
    console.log(
      `[probe E] before close: tabs=${before.body?.tabs?.length}, childRuns=${JSON.stringify(before.body?.childRuns)}, pidAlive=${isPidAlive(pid)}`,
    );

    const spare = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    console.log(`[probe E] spare tab: ${JSON.stringify(spare)}`);
    const closed = await api(ctx, "POST", `/tabs/${parentTabId}/close`, {});
    console.log(`[probe E] close -> HTTP ${closed.status} ${JSON.stringify(closed.body)}`);

    const trace = [];
    for (let i = 0; i < 20; i += 1) {
      await sleep(1_000);
      const st = await api(ctx, "GET", "/state?tail=0");
      const tabs = Array.isArray(st.body?.tabs) ? st.body.tabs.map((t) => t.tabId) : null;
      trace.push({
        t: i + 1,
        http: st.status,
        tabCount: tabs === null ? null : tabs.length,
        parentStillListed: tabs === null ? null : tabs.includes(parentTabId),
        childRuns: Array.isArray(st.body?.childRuns) ? st.body.childRuns.length : null,
        pidAlive: isPidAlive(pid),
      });
    }
    for (const row of trace) {
      console.log(`[probe E] t+${row.t}s http=${row.http} tabs=${row.tabCount} parentListed=${row.parentStillListed} childRuns=${row.childRuns} pidAlive=${row.pidAlive}`);
    }
    const stillAlive = isPidAlive(pid);
    return probeResult(
      "E",
      stillAlive ? "FAIL" : "PASS",
      `diagnostic trace above; child pid ${pid} ${stillAlive ? "STILL ALIVE" : "died"} 20s after the parent tab closed (child work was 120s)`,
    );
  } catch (err) {
    return probeResult("E", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

/** Probe F: probe E's observation with a child that holds no Bash open — the control for "blocked in a tool call". */
async function probeF(ctx) {
  const step = "F";
  try {
    const entry = await dispatchDetach(ctx, step, detachPromptNoTools(), 120_000);
    if (entry === null) {
      return probeResult("F", "SKIP", "the live model never produced an admitted detached child on this dispatch");
    }
    const pid = entry.pid;
    const spare = await apiOk(ctx, step, "POST", "/tabs", { kind: "new", workspace: ctx.tmpWorkspace });
    assert(step, spare?.ok === true, `could not open a spare tab: ${JSON.stringify(spare)}`);
    const closed = await api(ctx, "POST", `/tabs/${ctx.tabId}/close`, {});
    console.log(`[probe F] close -> HTTP ${closed.status} ${JSON.stringify(closed.body)}`);
    assert(step, closed.body?.ok === true, `close refused: ${JSON.stringify(closed.body)}`);
    const dead = await pollUntil(async () => (isPidAlive(pid) ? null : true), 20_000, 500);
    return probeResult(
      "F",
      dead === null ? "FAIL" : "PASS",
      `tool-free detached child pid ${pid} ${dead === null ? "STILL ALIVE" : "died"} within 20s of the parent tab closing`,
    );
  } catch (err) {
    return probeResult("F", "FAIL", `unexpected error: ${err?.message ?? err}`);
  }
}

// ── teardown / orchestration (local: never overwrites another slice's evidence) ──

const FLAGS = {
  keep: process.argv.includes("--keep"),
  /** `--only=A,D` runs just those probes (default: all four). */
  only: (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length),
  /** `--d-child-sleep=N` overrides probe D's child work length — the lever that separates "never dies" from "dies when its tool call ends". */
  dChildSleep: Number((process.argv.find((a) => a.startsWith("--d-child-sleep=")) ?? "").slice("--d-child-sleep=".length)) || 90,
  /** `--d-timeout=N` seconds probe D waits for the child pid to die. */
  dTimeout: Number((process.argv.find((a) => a.startsWith("--d-timeout=")) ?? "").slice("--d-timeout=".length)) || 45,
};

function teardown(ctx, failedProbes) {
  if (!ctx.teardownPromise) {
    ctx.teardownPromise = runTeardown(ctx, failedProbes);
  }
  return ctx.teardownPromise;
}

async function runTeardown(ctx, failedProbes) {
  if (ctx.port && ctx.token && ctx.child) {
    try {
      await api(ctx, "POST", "/quit", {});
    } catch {
      // best-effort — the app may already be gone.
    }
  }
  if (ctx.child) {
    const exited = await waitForExit(ctx.child, APP_EXIT_GRACE_MS);
    if (!exited) {
      killTree(ctx.child.pid, "SIGTERM");
      await sleep(SIGTERM_GRACE_MS);
      if (isPidAlive(ctx.child.pid)) {
        killTree(ctx.child.pid, "SIGKILL");
      }
    }
  }
  for (const dir of [ctx.tmpWorkspace, ctx.profile]) {
    if (typeof dir === "string" && existsSync(dir)) {
      if (FLAGS.keep) {
        console.log(`[task145-detach-smoke] --keep set, preserved: ${dir}`);
      } else {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[task145-detach-smoke] failed to remove ${dir}: ${err?.message ?? err}`);
        }
      }
    }
  }

  const results = ctx.results ?? [];
  const passCount = results.filter((r) => r.status === "PASS").length;
  const verdict = failedProbes.length === 0 ? "ALL GREEN (or documented SKIP)" : `FAILED: ${failedProbes.join(", ")}`;
  console.log(`\n[task145-detach-smoke] ${passCount}/${results.length} probes PASS — ${verdict}`);
  for (const r of results) {
    console.log(`  [probe ${r.name}] ${r.status} ${r.detail ?? ""}`.trimEnd());
  }

  try {
    ctx.mkdirEvidenceDir();
    const resultPath = join(ctx.evidenceDir, "detach-result.json");
    writeFileSync(resultPath, JSON.stringify({ verdict, results, at: new Date().toISOString() }, null, 2));
    console.log(`           result json: ${resultPath}`);
  } catch (err) {
    console.warn(`[task145-detach-smoke] failed to write detach-result.json: ${err?.message ?? err}`);
  }
}

function installSignalTeardown(ctx) {
  let handling = false;
  const onSignal = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`\n[task145-detach-smoke] received ${signal} — tearing down…`);
    teardown(ctx, [`signal:${signal}`])
      .catch((err) => console.error(`[task145-detach-smoke] teardown after ${signal} failed: ${err?.stack ?? err}`))
      .finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function run() {
  const ctx = {
    tmpWorkspace: null,
    port: undefined,
    token: undefined,
    tabId: null,
    childEntry: null,
    skipped: false,
    child: null,
    appPid: null,
    profile: null,
    profileUserDataDir: null,
    profileDbPath: null,
    profileAutomationInfo: null,
    settingsPath: undefined,
    secretsPath: undefined,
    teardownPromise: null,
    evidenceDir: EVIDENCE_DIR,
    results: [],
  };
  ctx.mkdirEvidenceDir = () => {
    try {
      execFileSync(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(ctx.evidenceDir)}, {recursive:true})`]);
    } catch {
      // fall through to the caller's own writeFileSync, whose ENOENT surfaces as a clear warning instead.
    }
  };
  installSignalTeardown(ctx);

  const failedProbes = [];
  try {
    await step1LaunchApp(ctx);
    await step1DiscoverTab(ctx);

    const selected = FLAGS.only === "" ? ["A", "B", "C", "D"] : FLAGS.only.split(",").map((n) => n.trim().toUpperCase());
    const byName = { A: probeA, B: probeB, C: probeC, D: probeD, E: probeE, F: probeF };
    for (const probe of selected.map((n) => byName[n]).filter(Boolean)) {
      const result = await probe(ctx);
      ctx.results.push(result);
      console.log(`[probe ${result.name}] ${result.status} — ${result.detail}`);
      if (result.status === "FAIL") {
        failedProbes.push(result.name);
      }
    }
  } catch (err) {
    console.error(`[task145-detach-smoke] unexpected error: ${err?.stack ?? err}`);
    failedProbes.push("launch");
  }

  await teardown(ctx, failedProbes);
  process.exit(failedProbes.length === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(`[task145-detach-smoke] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
