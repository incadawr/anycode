/**
 * checkpoints-rewind-wire (slice P7.26/R2, design slice-P7.26-R2-ratification.md
 * §2/§3/§4): the host-seam half of the timeline + /rewind wire surface. Proves the
 * Session route/guards/ordering + the two drift-flag obligations the R2 cut adds
 * on top of the R1 capture arc:
 *
 *  (1) checkpoint_list round-trip — seam present maps CheckpointMeta ->
 *      WireCheckpointMeta; seam absent replies `{checkpoints:[]}`.
 *  (2) busy-reject — a rewind during a running turn REPLIES `rewind_result{ok:false}`
 *      (not a silent drop like set_model; DoD-5).
 *  (3) disabled-seam — no checkpoints seam replies `{ok:false,"checkpoints unavailable"}`.
 *  (4) happy-path ordering — `rewind_result` is emitted BEFORE the truncated
 *      `session_history` on the port (§1 in-order delivery).
 *  (5) drift-flag-1 reconnect — after a conversation-restoring rewind, a `ui_ready`
 *      re-handshake re-sends the TRUNCATED session_history AND the replay ring
 *      carries no pre-rewind turn events (Outbound.clear()).
 *  (6) DoD-3 rewind->continue — a turn after a rewind writes a NEW checkpoint whose
 *      historyJson parses to the truncated length (agent-loop pre-turn snapshot).
 *  (7) DoD-4 no dangling tool_use — restored items (past a completed tool call) fed
 *      into a fresh ConversationHistory yield unansweredToolCallIds()===[].
 *
 * (1)-(4) use a hand-built fake `{list,rewind}` seam (no real git — deterministic,
 * fast). (5)-(7) drive the REAL ShadowGitCheckpoints against a real
 * NodeExecutionAdapter + real temp workspace + real SqlitePersistenceAdapter — the
 * same fixture shape as checkpoints-wire.test.ts (R1) and core's shadow-git.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConversationHistory,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  SqlitePersistenceAdapter,
} from "@anycode/core";
import type { CheckpointMeta, HistoryItem } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import type { SessionOptions } from "./session.js";
import { buildCheckpointService } from "./checkpoints.js";
import { createHarness, finishStep, toolStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const isCheckpointList = (m: HostToUiMessage): m is Of<"checkpoint_list"> => m.type === "checkpoint_list";
const isRewindResult = (m: HostToUiMessage): m is Of<"rewind_result"> => m.type === "rewind_result";
const toolResultOf =
  (toolCallId: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === toolCallId;

function countHostReady(received: readonly HostToUiMessage[]): number {
  return received.filter(isHostReady).length;
}
function countLoopEnds(received: readonly HostToUiMessage[]): number {
  return received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;
}

function meta(id: string, label: string, createdAt: number, reason: "auto" | "pre-rewind"): CheckpointMeta {
  return { id, sessionId: "test-session", commitHash: "0".repeat(40), createdAt, reason, label };
}

// ── (1)-(4): wire guards over a hand-built fake seam ───────────────────────────
describe("checkpoints-rewind-wire (P7.26/R2) — route + guards + ordering (fake seam)", () => {
  it("checkpoint_list round-trip: seam present maps metas; seam absent replies [] (1)", async () => {
    // Present: two metas -> mapped to WireCheckpointMeta (sessionId/commitHash dropped).
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [meta("cp-2", "second turn", 200, "auto"), meta("cp-1", "first turn", 100, "auto")],
      rewind: async () => ({ ok: false, reason: "unused" }),
    };
    const present = createHarness({ steps: [], checkpointsSeam: seam });
    try {
      present.send({ type: "ui_ready" });
      await present.waitFor(isHostReady);
      present.send({ type: "checkpoint_list_request" });
      const list = await present.waitFor(isCheckpointList);
      expect(list.checkpoints).toEqual([
        { id: "cp-2", label: "second turn", createdAt: 200, reason: "auto" },
        { id: "cp-1", label: "first turn", createdAt: 100, reason: "auto" },
      ]);
    } finally {
      present.close();
    }

    // Absent: no seam -> the reply is an empty list (fail-closed, not a crash).
    const absent = createHarness({ steps: [] });
    try {
      absent.send({ type: "ui_ready" });
      await absent.waitFor(isHostReady);
      absent.send({ type: "checkpoint_list_request" });
      const list = await absent.waitFor(isCheckpointList);
      expect(list.checkpoints).toEqual([]);
    } finally {
      absent.close();
    }
  });

  it("busy-reject: a rewind during a running turn REPLIES rewind_result{ok:false} (2)", async () => {
    let rewindCalled = false;
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [],
      rewind: async () => {
        rewindCalled = true;
        return { ok: false, reason: "should not run while busy" };
      },
    };
    // A Write in build mode parks on a permission_request -> the turn is running
    // (this.busy === true) with no way to complete until we answer it.
    const h = createHarness({
      steps: [toolStep("w1", "Write", { file_path: "/workspace/a.txt", content: "x" }), finishStep()],
      checkpointsSeam: seam,
      mode: "build",
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "write a file" });
      const req = await h.waitFor(isPermissionRequest); // now busy
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "both" });
      const res = await h.waitFor(isRewindResult);
      expect(res.requestId).toBe("rw1");
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("a turn is running");
      expect(res.conversationRestored).toBe(false);
      // The reject NEVER reached the seam (busy gate is strictly before rewind()).
      expect(rewindCalled).toBe(false);
      // Release the parked ask so teardown is clean.
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
    } finally {
      h.close();
    }
  });

  it("disabled-seam: no checkpoints seam replies {ok:false,'checkpoints unavailable'} (3)", async () => {
    const h = createHarness({ steps: [] }); // no checkpointsSeam
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "conversation" });
      const res = await h.waitFor(isRewindResult);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("checkpoints unavailable");
      expect(res.conversationRestored).toBe(false);
      expect(res.restoredPaths).toBeNull();
    } finally {
      h.close();
    }
  });

  it("happy-path ordering: rewind_result is emitted BEFORE the truncated session_history (4)", async () => {
    const restored: HistoryItem[] = [
      { id: "h1", createdAt: 1, message: { role: "user", content: "kept turn" } },
    ];
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [],
      rewind: async () => ({ ok: true, safetyCheckpointId: "safety-1", restoredPaths: 3, historyItems: restored }),
    };
    const h = createHarness({ steps: [], checkpointsSeam: seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "both" });
      const res = await h.waitFor(isRewindResult);
      expect(res.ok).toBe(true);
      expect(res.conversationRestored).toBe(true);
      expect(res.restoredPaths).toBe(3);
      expect(res.safetyCheckpointId).toBe("safety-1");
      // The truncated session_history rides AFTER on the same port.
      const sh = await h.waitFor((m): m is Of<"session_history"> => m.type === "session_history");
      expect(sh.items.map((i) => i.id)).toEqual(["h1"]);
      // Strict ordering on the received log: rewind_result index < session_history.
      const idxResult = h.received.findIndex(isRewindResult);
      const idxHistory = h.received.findIndex((m) => m.type === "session_history");
      expect(idxResult).toBeGreaterThanOrEqual(0);
      expect(idxHistory).toBeGreaterThan(idxResult);
    } finally {
      h.close();
    }
  });
});

// ── (5)-(7): real ShadowGitCheckpoints destructive units ───────────────────────
describe("checkpoints-rewind-wire (P7.26/R2) — real service: reconnect + destructive DoD", () => {
  const tmpDirs: string[] = [];
  const stores: SqlitePersistenceAdapter[] = [];

  function makeTmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }
  function checkpointsRootFor(dbPath: string): string {
    return dbPath === ":memory:" ? join(tmpdir(), ".anycode", "checkpoints") : join(dirname(dbPath), "checkpoints");
  }

  afterEach(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    stores.length = 0;
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  interface RealFixture {
    store: SqlitePersistenceAdapter;
    sessionId: string;
    service: NonNullable<ReturnType<typeof buildCheckpointService>>;
    workspace: string;
  }

  /** Builds a real ShadowGitCheckpoints over a real temp workspace + sqlite store. */
  async function bootReal(prefix: string): Promise<RealFixture> {
    const workspace = makeTmp(`${prefix}-ws-`);
    const dbDir = makeTmp(`${prefix}-db-`);
    const dbPath = join(dbDir, "anycode.sqlite");
    writeFileSync(join(workspace, "seed.txt"), "v1");
    const store = new SqlitePersistenceAdapter(dbPath);
    stores.push(store);
    const sessionId = `sess-${prefix}`;
    await store.createSession({ id: sessionId, workspace, model: "scripted-model", mode: "build" });
    const service = buildCheckpointService({
      exec: new NodeExecutionAdapter(),
      fs: new NodeFileSystemAdapter(),
      store,
      workspace,
      checkpointsRoot: checkpointsRootFor(dbPath),
      sessionId,
    });
    expect(service).not.toBeNull();
    return { store, sessionId, service: service!, workspace };
  }

  /** Runs one write-effect turn (Write tool) end-to-end: send -> allow -> tool_result. */
  async function writeTurn(
    h: ReturnType<typeof createHarness>,
    requestId: string,
    text: string,
    toolCallId: string,
    filePath: string,
    afterLoopEnds: number,
  ): Promise<void> {
    // A multi-turn harness accumulates stale (already-settled) permission_requests
    // in `received`; waitFor(isPermissionRequest) would match turn 1's again. Wait
    // for a NEW one by count, then answer the LATEST (this turn's) requestId.
    const before = h.received.filter(isPermissionRequest).length;
    h.send({ type: "user_message", requestId, text });
    await h.waitUntil(() => h.received.filter(isPermissionRequest).length > before, 15_000);
    const req = h.received.filter(isPermissionRequest).at(-1)!;
    h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
    // toolCallId is unique per turn, so this waitFor never matches a stale result.
    await h.waitFor(toolResultOf(toolCallId), 15_000);
    await h.waitUntil(() => countLoopEnds(h.received) >= afterLoopEnds, 15_000);
  }

  it(
    "drift-flag-1: a ui_ready re-handshake after a rewind re-sends truncated history + no pre-rewind replay (5)",
    async () => {
      const { store, sessionId, service, workspace } = await bootReal("rw5");
      const h = createHarness({
        steps: [
          toolStep("w1", "Write", { file_path: join(workspace, "a.txt"), content: "1" }),
          finishStep(),
          toolStep("w2", "Write", { file_path: join(workspace, "b.txt"), content: "2" }),
          finishStep(),
        ],
        checkpoints: service, // loop capturer
        checkpointsSeam: service, // Session rewind/list seam (same instance, as host boot)
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        await writeTurn(h, "r1", "turn one", "w1", join(workspace, "a.txt"), 1);
        await writeTurn(h, "r2", "turn two", "w2", join(workspace, "b.txt"), 2);

        // Newest-first: rows[0] is cp2 (captured BEFORE turn 2, snapshot = turn-1
        // completed history — non-empty, so the re-sent session_history is non-null).
        const rows = await store.listCheckpoints(sessionId);
        const cp2 = rows[0]!;
        expect(cp2.reason).toBe("auto");
        const cp2Record = await store.getCheckpoint(cp2.id);
        const restoredLen = (JSON.parse(cp2Record!.historyJson) as HistoryItem[]).length;
        expect(restoredLen).toBeGreaterThan(0);

        // Pre-rewind, the replay ring holds turn-1/turn-2 agent_events.
        const preRewindAgentEvents = h.received.filter((m) => m.type === "agent_event").length;
        expect(preRewindAgentEvents).toBeGreaterThan(0);

        // Rewind to cp2 (conversation scope).
        h.send({ type: "rewind_request", requestId: "rw1", checkpointId: cp2.id, scope: "conversation" });
        const res = await h.waitFor(isRewindResult, 15_000);
        expect(res.ok).toBe(true);
        expect(res.conversationRestored).toBe(true);

        // Reconnect: a fresh ui_ready re-handshake. Track by host_ready count (the
        // harness waitFor would match the FIRST/old host_ready otherwise).
        const beforeReconnect = h.received.length;
        h.send({ type: "ui_ready" });
        await h.waitUntil(() => countHostReady(h.received) >= 2, 5_000);
        await h.flush();
        const after = h.received.slice(beforeReconnect);

        // The re-handshake re-sends the TRUNCATED session_history...
        const sh = after.find((m) => m.type === "session_history") as Of<"session_history"> | undefined;
        expect(sh).toBeDefined();
        expect(sh!.items).toHaveLength(restoredLen);
        // ...and the replay ring carries NO pre-rewind turn events (Outbound.clear()).
        expect(after.some((m) => m.type === "agent_event")).toBe(false);
      } finally {
        h.close();
      }
    },
    45_000,
  );

  it(
    "DoD-3: a turn after a rewind writes a NEW checkpoint whose historyJson is the truncated length (6)",
    async () => {
      const { store, sessionId, service, workspace } = await bootReal("rw6");
      const h = createHarness({
        steps: [
          toolStep("w1", "Write", { file_path: join(workspace, "a.txt"), content: "1" }),
          finishStep(),
          toolStep("w2", "Write", { file_path: join(workspace, "b.txt"), content: "2" }),
          finishStep(),
          toolStep("w3", "Write", { file_path: join(workspace, "c.txt"), content: "3" }),
          finishStep(),
        ],
        checkpoints: service,
        checkpointsSeam: service,
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        await writeTurn(h, "r1", "turn one", "w1", join(workspace, "a.txt"), 1);
        await writeTurn(h, "r2", "turn two", "w2", join(workspace, "b.txt"), 2);

        const autosBefore = (await store.listCheckpoints(sessionId)).filter((r) => r.reason === "auto");
        const cp2 = autosBefore[0]!; // newest auto = pre-turn-2 snapshot
        const truncatedLen = (JSON.parse((await store.getCheckpoint(cp2.id))!.historyJson) as HistoryItem[]).length;
        // Full history after turn 2 is strictly longer than the rewind target.
        const fullLen = truncatedLen * 2; // two identical-shape turns

        // Rewind the conversation to cp2, then continue with turn 3.
        h.send({ type: "rewind_request", requestId: "rw1", checkpointId: cp2.id, scope: "conversation" });
        const res = await h.waitFor(isRewindResult, 15_000);
        expect(res.ok).toBe(true);
        await writeTurn(h, "r3", "turn three", "w3", join(workspace, "c.txt"), 3);

        // The turn-3 checkpoint's pre-turn snapshot == the TRUNCATED history, not
        // the pre-rewind full history (agent-loop.ts pre-turn snapshot semantics).
        const autosAfter = (await store.listCheckpoints(sessionId)).filter((r) => r.reason === "auto");
        const cp3 = autosAfter[0]!; // newest auto = turn-3 snapshot
        expect(cp3.id).not.toBe(cp2.id);
        const cp3Len = (JSON.parse((await store.getCheckpoint(cp3.id))!.historyJson) as HistoryItem[]).length;
        expect(cp3Len).toBe(truncatedLen);
        expect(cp3Len).toBeLessThan(fullLen);
      } finally {
        h.close();
      }
    },
    45_000,
  );

  it(
    "DoD-4: restored items past a completed tool call yield unansweredToolCallIds()===[] (7)",
    async () => {
      const { store, sessionId, service, workspace } = await bootReal("rw7");
      const h = createHarness({
        steps: [
          // Turn 1 runs a tool call (Write) that COMPLETES within the turn.
          toolStep("w1", "Write", { file_path: join(workspace, "a.txt"), content: "1" }),
          finishStep(),
          // Turn 2 exists only so cp2's pre-turn snapshot captures turn-1's
          // completed tool-call+result pair.
          toolStep("w2", "Write", { file_path: join(workspace, "b.txt"), content: "2" }),
          finishStep(),
        ],
        checkpoints: service,
        checkpointsSeam: service,
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        await writeTurn(h, "r1", "run a tool", "w1", join(workspace, "a.txt"), 1);
        await writeTurn(h, "r2", "run again", "w2", join(workspace, "b.txt"), 2);

        const cp2 = (await store.listCheckpoints(sessionId)).filter((r) => r.reason === "auto")[0]!;
        // Rewind to cp2 over the wire (past turn-1's completed tool call).
        h.send({ type: "rewind_request", requestId: "rw1", checkpointId: cp2.id, scope: "conversation" });
        const res = await h.waitFor(isRewindResult, 15_000);
        expect(res.ok).toBe(true);
        expect(res.conversationRestored).toBe(true);

        // The restored snapshot fed into a ConversationHistory has NO dangling
        // tool_use (every checkpoint is a completed-turn boundary).
        const restored = JSON.parse((await store.getCheckpoint(cp2.id))!.historyJson) as HistoryItem[];
        // Non-vacuous: the snapshot really does contain a completed tool call.
        const hasToolCall = restored.some(
          (i) => i.message.role === "assistant" && i.message.content.some((p) => p.type === "tool_call"),
        );
        expect(hasToolCall).toBe(true);
        const history = new ConversationHistory({ initial: restored });
        expect(history.unansweredToolCallIds()).toEqual([]);
      } finally {
        h.close();
      }
    },
    45_000,
  );
});
