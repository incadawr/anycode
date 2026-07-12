/**
 * tasks-wire e2e (slice 6.DP-2, design slice-6.DP-2-cut.md §1.6 / §6#1-#9): the
 * background-tasks host-parity path exercised end-to-end over the REAL
 * worker_threads MessageChannel + REAL Session/AgentLoop/zod + a REAL
 * InProcessTaskManager(new NodeExecutionAdapter()) driving REAL `sh` children —
 * the same shape as lsp-wire.test.ts. Proves the desktop CONSUMPTION of the
 * shipped 5.5 bg-tasks core:
 *
 *  (#1) a `run_in_background:true` Bash surfaces {taskId, status:"running"} on the
 *       tool_result the model sees IMMEDIATELY, and the command REALLY runs (a
 *       marker file appears). permission_request shape == sync Bash (toolName
 *       "Bash", input.command present).
 *  (#2) a completed task's notice is injected into the NEXT accepted turn's model
 *       input exactly once (`Background task update:` + `task-1 ... completed,
 *       exit 0`), drained so the following turn is byte-identical (no block).
 *  (#3) BashKill reaps a real child to ESRCH; a TERM-ignoring task dies only via
 *       SIGKILL escalation (>= SIGKILL_GRACE_MS) and disposeAll stays bounded.
 *  (#4) a build-mode deny spawns NOTHING (gate is strictly before start); a
 *       plan-mode readOnly BashOutput is allowed WITHOUT a permission_request.
 *  (#5) a bg task OUTLIVES a cancel_turn (its controller is the manager's own,
 *       never linked to the turn), then dies on an explicit kill.
 *  (#9) BashOutput returns the appended-since-last-read increment; a repeat read
 *       is empty; an unknown id is an honest error.
 *
 * NO fixed sleeps: poll-with-deadline on pids / marker files only (isPidAlive-
 * flake lesson). Every InProcessTaskManager is disposed in afterEach so the
 * suite leaves no orphans (a post-suite `pgrep -f 314159` is empty).
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessTaskManager, NodeExecutionAdapter, SIGKILL_GRACE_MS } from "@anycode/core";
import type { ModelRequest } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { ScriptedModelPort, createHarness, finishStep, textStep, toolStep } from "./test-harness.js";

// BACKGROUND_DISPOSE_DEADLINE_MS (core types/config.ts) is 3_000ms and is NOT on
// the public barrel; mirrored here for the disposeAll bound assertion (same
// convention as lsp-wire's LSP_DISPOSE_DEADLINE_MS).
const DISPOSE_DEADLINE_MS = 3_000;

// A distinctive sleep duration embedded in every long-lived bg command so a
// post-suite `pgrep -f 314159` proves the suite left ZERO orphans (both the
// exec'd `sleep 314159` leaves it in argv and the trap-sh keeps it in a comment).
const SLEEP = "sleep 314159";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const toolResultOf =
  (toolCallId: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === toolCallId;

function countLoopEnds(received: readonly HostToUiMessage[]): number {
  return received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;
}

function countPermReqs(received: readonly HostToUiMessage[]): number {
  return received.filter(isPermissionRequest).length;
}

/** The content of the last role:"user" message — what the model actually got as this turn's prompt. */
function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i]!;
    if (m.role === "user") return m.content;
  }
  return "";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPidDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleepMs(25);
  }
  return !isPidAlive(pid);
}

/** Reads the pid a bg command wrote via `echo $$ > pidfile` (bounded). */
async function waitPidFile(path: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf-8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await sleepMs(25);
  }
  throw new Error(`pidfile ${path} not written within ${timeoutMs}ms`);
}

describe("tasks-wire e2e — real InProcessTaskManager + real sh children over the real MessageChannel", () => {
  const managers: InProcessTaskManager[] = [];
  const tmpDirs: string[] = [];

  function makeManager(): InProcessTaskManager {
    const manager = new InProcessTaskManager(new NodeExecutionAdapter());
    managers.push(manager);
    return manager;
  }

  function makeTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "anycode-taskwire-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    // Never leave an orphan child behind, even if an assertion threw.
    await Promise.all(managers.map((m) => m.disposeAll()));
    managers.length = 0;
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  // ── §6#1 ──────────────────────────────────────────────────────────────────
  it(
    "returns {taskId, status:running} immediately AND the command really runs (§6#1)",
    async () => {
      const tmp = makeTmp();
      const marker = join(tmp, "marker");
      const manager = makeManager();
      const command = `echo hi > ${marker}`;
      const h = createHarness({
        steps: [toolStep("c1", "Bash", { command, run_in_background: true }), finishStep()],
        tasks: manager,
        cwd: tmp,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "run it in the background" });
        const req = await h.waitFor(isPermissionRequest);
        // permission_request shape is exactly the sync Bash's: name "Bash", command present.
        expect(req.toolName).toBe("Bash");
        expect((req.input as { command?: unknown }).command).toBe(command);
        expect((req.input as { run_in_background?: unknown }).run_in_background).toBe(true);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

        const msg = await h.waitFor(toolResultOf("c1"), 8_000);
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        const outcome = msg.event.outcome;
        expect(outcome.status).toBe("success");
        const output = outcome.result?.output as { taskId?: string; status?: string; command?: string } | undefined;
        expect(output?.taskId).toBe("task-1");
        expect(output?.status).toBe("running");
        expect(output?.command).toBe(command);
        // The task exists in the registry immediately.
        expect(manager.get("task-1")).toBeDefined();

        // The command REALLY executed: poll the marker file it writes.
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && !existsSync(marker)) {
          await sleepMs(25);
        }
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf-8")).toContain("hi");
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#2 ──────────────────────────────────────────────────────────────────
  it(
    "injects a completion notice into the next accepted turn exactly once; drained turn is byte-identical (§6#2)",
    async () => {
      const tmp = makeTmp();
      const manager = makeManager();
      const h = createHarness({
        steps: [
          toolStep("c1", "Bash", { command: "true", run_in_background: true }),
          finishStep(), // turn 1 ends after the tool_result
          textStep("ok"), // turn 2 (a plain reply) — the notice rides its user input
          textStep("ok2"), // turn 3 — nothing left to drain
        ],
        tasks: manager,
        cwd: tmp,
      });
      const scripted = h.config.modelPort as ScriptedModelPort;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        // Turn 1: start the (instant) bg task.
        h.send({ type: "user_message", requestId: "r1", text: "start it" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("c1"), 8_000);
        await h.waitUntil(() => countLoopEnds(h.received) >= 1, 8_000);

        // Poll the manager until task-1 is terminal (a notice is now queued).
        const termDeadline = Date.now() + 8_000;
        while (Date.now() < termDeadline && manager.get("task-1")?.status === "running") {
          await sleepMs(25);
        }
        expect(manager.get("task-1")?.status).toBe("completed");

        // Turn 2: the drained notice is appended to THIS turn's user input.
        const idxBeforeT2 = scripted.requests.length;
        h.send({ type: "user_message", requestId: "r2", text: "second" });
        await h.waitUntil(() => countLoopEnds(h.received) >= 2, 8_000);
        const t2 = scripted.requests[scripted.requests.length - 1]!;
        const t2Text = lastUserText(t2);
        // Exactly one reminder block, with the frozen notice format (duration is
        // the only non-deterministic part — pinned by start/end, not exact bytes).
        expect((t2Text.match(/<system-reminder>/g) ?? []).length).toBe(1);
        expect(t2Text.startsWith("second\n<system-reminder>\nBackground task update:\ntask-1 (`true`): completed, exit 0, ")).toBe(true);
        expect(t2Text.endsWith("</system-reminder>")).toBe(true);
        expect(idxBeforeT2).toBeLessThan(scripted.requests.length);

        // Turn 3: drain emptied the queue — the user input passes through untouched
        // (A/B byte-identity: identical to a harness with no tasks / no notices).
        h.send({ type: "user_message", requestId: "r3", text: "third" });
        await h.waitUntil(() => countLoopEnds(h.received) >= 3, 8_000);
        const t3 = scripted.requests[scripted.requests.length - 1]!;
        expect(lastUserText(t3)).toBe("third");
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#3 (wire kill -> ESRCH) ───────────────────────────────────────────────
  it(
    "BashKill over the wire reaps a real child to ESRCH — zero orphans (§6#3)",
    async () => {
      const tmp = makeTmp();
      const pidfile = join(tmp, "pid");
      const manager = makeManager();
      const command = `echo $$ > ${pidfile}; exec ${SLEEP}`;
      const h = createHarness({
        steps: [
          toolStep("c1", "Bash", { command, run_in_background: true }),
          finishStep(),
          toolStep("k1", "BashKill", { task_id: "task-1" }), // readOnly -> no permission_request
          finishStep(),
        ],
        tasks: manager,
        cwd: tmp,
      });
      let pid: number;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "start a long task" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("c1"), 8_000);
        await h.waitUntil(() => countLoopEnds(h.received) >= 1, 8_000);

        pid = await waitPidFile(pidfile);
        expect(isPidAlive(pid)).toBe(true);
        expect(manager.get("task-1")?.status).toBe("running");

        // Turn 2: BashKill is readOnly (needsApproval:false) -> allowed with no ask.
        h.send({ type: "user_message", requestId: "r2", text: "kill it" });
        const killMsg = await h.waitFor(toolResultOf("k1"), 8_000);
        if (killMsg.event.type !== "tool_result") throw new Error("expected tool_result");
        expect(killMsg.event.outcome.status).toBe("success");
        const killOut = killMsg.event.outcome.result?.output as { killed?: boolean } | undefined;
        expect(killOut?.killed).toBe(true);
        // No permission_request was ever needed for the readOnly kill tool.
        expect(countPermReqs(h.received)).toBe(1); // only the bg Bash start asked

        expect(await waitPidDead(pid)).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
        // The reaped task transitions to "killed".
        const statusDeadline = Date.now() + 5_000;
        while (Date.now() < statusDeadline && manager.get("task-1")?.status === "running") {
          await sleepMs(25);
        }
        expect(manager.get("task-1")?.status).toBe("killed");
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#3 (SIGKILL escalation + bounded disposeAll) ──────────────────────────
  it(
    "a TERM-ignoring task dies only via SIGKILL escalation and disposeAll stays bounded (§6#3)",
    async () => {
      // Kill discipline needs no wire: drive the manager directly (deterministic
      // timing), mirroring lsp-wire's --ignore-term test. The sh traps SIGTERM and
      // never exits, forcing killProcessTree to escalate to SIGKILL after the grace.
      const tmp = makeTmp();
      const pidfile = join(tmp, "pid");
      const manager = makeManager();
      const started = manager.start({
        command: `trap '' TERM; echo $$ > ${pidfile}; while :; do sleep 0.3; done # 314159`,
        cwd: tmp,
      });
      expect(started.ok).toBe(true);

      const pid = await waitPidFile(pidfile);
      expect(isPidAlive(pid)).toBe(true);

      const t0 = Date.now();
      await manager.disposeAll();
      const elapsed = Date.now() - t0;
      // A polite task would settle in tens of ms; a TERM-ignoring one cannot die
      // before the SIGTERM->SIGKILL grace elapses...
      expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS);
      // ...and disposeAll is bounded — it never hangs shutdown.
      expect(elapsed).toBeLessThan(DISPOSE_DEADLINE_MS + 1_500);
      // The process-group leader is gone (ESRCH).
      expect(await waitPidDead(pid)).toBe(true);
      expect(isPidAlive(pid)).toBe(false);
    },
    30_000,
  );

  // ── §6#4 (build deny -> zero spawns) ────────────────────────────────────────
  it(
    "a build-mode deny spawns NOTHING — the gate is strictly before start (§6#4)",
    async () => {
      const tmp = makeTmp();
      const marker = join(tmp, "marker");
      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("c1", "Bash", { command: `echo ran > ${marker}`, run_in_background: true }), finishStep()],
        tasks: manager,
        cwd: tmp,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "run it" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });

        const msg = await h.waitFor(toolResultOf("c1"), 8_000);
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        expect(msg.event.outcome.status).toBe("denied");

        await h.flush();
        // No task was ever started (gate is BEFORE manager.start)...
        expect(manager.list()).toEqual([]);
        // ...so the command never ran.
        expect(existsSync(marker)).toBe(false);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#4 (plan-mode readOnly allow without ask) ─────────────────────────────
  it(
    "a plan-mode readOnly BashOutput is allowed WITHOUT a permission_request (§6#4)",
    async () => {
      const tmp = makeTmp();
      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("o1", "BashOutput", { task_id: "task-1" }), finishStep()],
        mode: "plan",
        tasks: manager,
        cwd: tmp,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "poll it" });
        const msg = await h.waitFor(toolResultOf("o1"), 8_000);
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        // The tool RAN (honest unknown-id error) — proving it was allowed, not denied.
        expect(msg.event.outcome.status).toBe("error");
        expect(msg.event.outcome.modelText).toContain("no background task");

        await h.flush();
        // A readOnly tool never reaches the broker/UI, even in plan mode.
        expect(h.received.some(isPermissionRequest)).toBe(false);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#5 ──────────────────────────────────────────────────────────────────
  it(
    "a bg task outlives cancel_turn (its controller is the manager's own), then dies on kill (§6#5)",
    async () => {
      const tmp = makeTmp();
      const pidfile = join(tmp, "pid");
      const manager = makeManager();
      const h = createHarness({
        steps: [
          toolStep("c1", "Bash", { command: `echo $$ > ${pidfile}; exec ${SLEEP}`, run_in_background: true }),
          // A second (sync) Bash parks on the broker, keeping the STARTING turn
          // in-flight so cancel_turn hits it while task-1 is running. It is never
          // allowed (we cancel), so its handler — which would touch the stubbed
          // ports.exec — never runs.
          toolStep("c2", "Bash", { command: "echo second" }),
          finishStep(),
        ],
        tasks: manager,
        cwd: tmp,
      });
      let pid: number;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "start then park" });
        await h.waitUntil(() => countPermReqs(h.received) >= 1, 8_000);
        const first = h.received.filter(isPermissionRequest)[0]!;
        h.send({ type: "permission_response", requestId: first.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("c1"), 8_000);

        pid = await waitPidFile(pidfile);
        expect(isPidAlive(pid)).toBe(true);
        expect(manager.get("task-1")?.status).toBe("running");

        // The sync Bash (c2) now parks -> the turn is still active.
        await h.waitUntil(() => countPermReqs(h.received) >= 2, 8_000);

        // Abort the in-flight turn.
        h.send({ type: "cancel_turn" });
        await h.waitUntil(() => countLoopEnds(h.received) >= 1, 8_000);

        // SURVIVAL: the bg task outlived the aborted turn.
        expect(isPidAlive(pid)).toBe(true);
        expect(manager.get("task-1")?.status).toBe("running");

        // DEATH: an explicit kill still reaps it.
        expect(manager.kill("task-1")).toBe(true);
        expect(await waitPidDead(pid)).toBe(true);
        expect(isPidAlive(pid)).toBe(false);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#9 ──────────────────────────────────────────────────────────────────
  it(
    "BashOutput returns the since-last-read increment; a repeat is empty; unknown id is an honest error (§6#9)",
    async () => {
      const tmp = makeTmp();
      const manager = makeManager();
      const h = createHarness({
        steps: [
          // Prints a marker then stays alive (running) so no notice is queued and
          // the second read genuinely sees no new output.
          toolStep("c1", "Bash", { command: `echo MARKER314; exec ${SLEEP}`, run_in_background: true }),
          finishStep(),
          toolStep("o1", "BashOutput", { task_id: "task-1" }),
          finishStep(),
          toolStep("o2", "BashOutput", { task_id: "task-1" }),
          finishStep(),
          toolStep("o3", "BashOutput", { task_id: "task-999" }),
          finishStep(),
        ],
        tasks: manager,
        cwd: tmp,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        // Turn 1: start.
        h.send({ type: "user_message", requestId: "r1", text: "start printer" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("c1"), 8_000);
        await h.waitUntil(() => countLoopEnds(h.received) >= 1, 8_000);

        // Poll until the marker has been captured into the buffer.
        const outDeadline = Date.now() + 8_000;
        while (Date.now() < outDeadline && (manager.get("task-1")?.outputBytes ?? 0) < "MARKER314\n".length) {
          await sleepMs(25);
        }
        expect(manager.get("task-1")?.status).toBe("running");

        // Turn 2: first BashOutput read -> the appended increment.
        h.send({ type: "user_message", requestId: "r2", text: "read output" });
        const first = await h.waitFor(toolResultOf("o1"), 8_000);
        if (first.event.type !== "tool_result") throw new Error("expected tool_result");
        expect(first.event.outcome.status).toBe("success");
        const firstOut = first.event.outcome.result?.output as { newOutput?: string; status?: string } | undefined;
        expect(firstOut?.newOutput).toContain("MARKER314");
        expect(firstOut?.status).toBe("running");
        await h.waitUntil(() => countLoopEnds(h.received) >= 2, 8_000);

        // Turn 3: second read -> cursor advanced, nothing new.
        h.send({ type: "user_message", requestId: "r3", text: "read again" });
        const second = await h.waitFor(toolResultOf("o2"), 8_000);
        if (second.event.type !== "tool_result") throw new Error("expected tool_result");
        const secondOut = second.event.outcome.result?.output as { newOutput?: string } | undefined;
        expect(secondOut?.newOutput).toBe("");
        await h.waitUntil(() => countLoopEnds(h.received) >= 3, 8_000);

        // Turn 4: unknown id -> honest error.
        h.send({ type: "user_message", requestId: "r4", text: "read a typo" });
        const missing = await h.waitFor(toolResultOf("o3"), 8_000);
        if (missing.event.type !== "tool_result") throw new Error("expected tool_result");
        expect(missing.event.outcome.status).toBe("error");
        expect(missing.event.outcome.modelText).toContain('no background task with id "task-999"');
      } finally {
        h.close();
      }
    },
    30_000,
  );
});
