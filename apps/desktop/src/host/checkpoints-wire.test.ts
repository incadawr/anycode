/**
 * checkpoints-wire (slice P7.26/R1, design slice-P7.26-cut.md §3): proves the
 * desktop host wires the per-turn shadow-git checkpoint CAPTURE arc that the CLI
 * already has (cli/main.ts checkpointService) but the host lacked (6.DP-2 R7
 * gap — ports:{fs,exec,http,todos} with no `checkpoints`, so capture was dormant
 * and ZERO checkpoints were ever written on desktop). Three cases from §3:
 *
 *   (a) after a write-effect turn through the CONSTRUCTED loop, >=1 checkpoint
 *       ROW exists in the real sqlite `checkpoints` table with a label derived
 *       from the user input — the "real artifact" DoD: an actual SELECT of the
 *       row, not merely a green path.
 *   (b) with an execution port that has NO runBinary, the gate builds no service
 *       (null) and a turn is byte-identical to today: no checkpoint_created /
 *       checkpoint_failed event, no service handle, no git spawn.
 *   (c) resume-continuity: a FRESH service on the same session/workspace/store
 *       (cold in-memory state) seeds its parent chain from the prior checkpoint
 *       recorded in the REAL desktop store, so the next commit chains onto it
 *       (shadow-git.ts:173-178 parent-chain seeding).
 *
 * (a)/(c) exercise the REAL ShadowGitCheckpoints against a real
 * NodeExecutionAdapter, a real temp workspace, and a real SqlitePersistenceAdapter
 * — the same fixture shape core's own shadow-git.test.ts "real git integration"
 * block uses. The gate + wiring under test live in host/checkpoints.ts (buildable
 * in isolation because host/index.ts touches process.parentPort at module load
 * and so is not importable — the established host-test idiom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  SqlitePersistenceAdapter,
  ShadowGitCheckpoints,
} from "@anycode/core";
import type { ExecutionPort } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { buildCheckpointService } from "./checkpoints.js";
import { CompactionRecordLog } from "./compaction-records.js";
import { createHarness, finishStep, toolStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const toolResultOf =
  (toolCallId: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === toolCallId;

/** The real host wiring: checkpointsRoot mirrors cli/main.ts (dbPath dir sibling; ~/.anycode for :memory:). */
function checkpointsRootFor(dbPath: string): string {
  return dbPath === ":memory:" ? join(tmpdir(), ".anycode", "checkpoints") : join(dirname(dbPath), "checkpoints");
}

/** shadow-git.ts:111 gitDir key — per-workspace under the checkpoints root. */
function shadowGitDir(checkpointsRoot: string, workspace: string): string {
  return join(checkpointsRoot, createHash("sha256").update(workspace).digest("hex").slice(0, 16));
}

describe("checkpoints-wire (P7.26/R1) — host wires per-turn checkpoint capture", () => {
  const tmpDirs: string[] = [];
  const stores: SqlitePersistenceAdapter[] = [];

  function makeTmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeStore(dbPath: string): SqlitePersistenceAdapter {
    const store = new SqlitePersistenceAdapter(dbPath);
    stores.push(store);
    return store;
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

  // ── §3 case (a): real artifact — a checkpoint ROW after a write-effect turn ──
  it(
    "writes a checkpoint row to the real sqlite table after a write-effect turn (a)",
    async () => {
      const workspace = makeTmp("anycode-cpwire-ws-");
      const dbDir = makeTmp("anycode-cpwire-db-");
      const dbPath = join(dbDir, "anycode.sqlite");
      writeFileSync(join(workspace, "seed.txt"), "v1");

      const store = makeStore(dbPath);
      const sessionId = "sess-a";
      await store.createSession({ id: sessionId, workspace, model: "scripted-model", mode: "build" });

      const service = buildCheckpointService({
        exec: new NodeExecutionAdapter(),
        fs: new NodeFileSystemAdapter(),
        store,
        workspace,
        checkpointsRoot: checkpointsRootFor(dbPath),
        sessionId,
      });
      // The host gate builds a real service because NodeExecutionAdapter has runBinary.
      expect(service).not.toBeNull();

      const userInput = "add a greeting file";
      const h = createHarness({
        steps: [
          toolStep("w1", "Write", { file_path: join(workspace, "greeting.txt"), content: "hello" }),
          finishStep(),
          // Consumed by the post-rewind compaction below (a structural skip, so
          // the scripted step may go unused — no model call is made).
          finishStep(),
        ],
        checkpoints: service ?? undefined,
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: userInput });
        const req = await h.waitFor(isPermissionRequest);
        expect(req.toolName).toBe("Write");
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

        await h.waitFor(toolResultOf("w1"), 15_000);

        // REAL ARTIFACT: the checkpoint row is in the sqlite `checkpoints` table.
        const rows = await store.listCheckpoints(sessionId);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const auto = rows.find((r) => r.reason === "auto");
        expect(auto).toBeDefined();
        expect(auto!.label).toBe(userInput);
        expect(auto!.commitHash).toMatch(/^[0-9a-f]{40}$/);
        expect(auto!.sessionId).toBe(sessionId);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §3 case (b): no runBinary -> no service, turn byte-identical (dormant) ──
  it(
    "builds no service and stays dormant when the execution port has no runBinary (b)",
    async () => {
      const workspace = makeTmp("anycode-cpwire-wsb-");
      const dbDir = makeTmp("anycode-cpwire-dbb-");
      const dbPath = join(dbDir, "anycode.sqlite");
      const store = makeStore(dbPath);
      const sessionId = "sess-b";
      await store.createSession({ id: sessionId, workspace, model: "scripted-model", mode: "build" });

      // An execution port WITHOUT runBinary (the honest-disable gate input).
      const execNoBinary: ExecutionPort = {
        run: () => Promise.reject(new Error("run() not expected in this test")),
      };
      const service = buildCheckpointService({
        exec: execNoBinary,
        fs: new NodeFileSystemAdapter(),
        store,
        workspace,
        checkpointsRoot: checkpointsRootFor(dbPath),
        sessionId,
      });
      // Gate: no runBinary -> null -> the host spreads NO `checkpoints` into config.
      expect(service).toBeNull();

      // A write-effect turn through a loop with NO checkpoints arc is dormant:
      // no checkpoint_created / checkpoint_failed event, no rows written.
      const h = createHarness({
        steps: [toolStep("w1", "Write", { file_path: join(workspace, "b.txt"), content: "x" }), finishStep()],
        checkpoints: service ?? undefined,
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r1", text: "write a file" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("w1"), 15_000);
        await h.flush();

        const checkpointEvents = h.received.filter(
          (m) => m.type === "agent_event" && (m.event.type === "checkpoint_created" || m.event.type === "checkpoint_failed"),
        );
        expect(checkpointEvents).toHaveLength(0);
        const rows = await store.listCheckpoints(sessionId);
        expect(rows).toHaveLength(0);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §3 case (c): resume — a fresh service seeds its parent chain from the store ──
  it(
    "chains a fresh service's commit onto the prior checkpoint from the real store (c)",
    async () => {
      const workspace = makeTmp("anycode-cpwire-wsc-");
      const dbDir = makeTmp("anycode-cpwire-dbc-");
      const dbPath = join(dbDir, "anycode.sqlite");
      const checkpointsRoot = checkpointsRootFor(dbPath);
      writeFileSync(join(workspace, "seed.txt"), "v1");

      const store = makeStore(dbPath);
      const sessionId = "sess-c";
      await store.createSession({ id: sessionId, workspace, model: "m", mode: "build" });

      // Turn 1's service captures checkpoint-1.
      const service1 = buildCheckpointService({
        exec: new NodeExecutionAdapter(),
        fs: new NodeFileSystemAdapter(),
        store,
        workspace,
        checkpointsRoot,
        sessionId,
      });
      expect(service1).not.toBeNull();
      const cap1 = await service1!.capture({ userInput: "first turn", historySnapshot: [] });
      expect(cap1.kind).toBe("created");

      // Resume: a brand-new service instance (cold lastCommit) on the SAME
      // session/workspace/store — exactly what a fresh host boot constructs.
      const service2 = buildCheckpointService({
        exec: new NodeExecutionAdapter(),
        fs: new NodeFileSystemAdapter(),
        store,
        workspace,
        checkpointsRoot,
        sessionId,
      });
      writeFileSync(join(workspace, "seed.txt"), "v2");
      const cap2 = await service2!.capture({ userInput: "second turn", historySnapshot: [] });
      expect(cap2.kind).toBe("created");

      const rows = await store.listCheckpoints(sessionId);
      expect(rows).toHaveLength(2);
      const [newest, prior] = rows; // listCheckpoints is newest-first
      expect(newest!.commitHash).not.toBe(prior!.commitHash);

      // Parent-chain proof: checkpoint-2's commit names checkpoint-1's commit as
      // its parent, seeded from the store by the FRESH service (resume continuity).
      const gitDir = shadowGitDir(checkpointsRoot, workspace);
      const commitBody = execFileSync("git", ["cat-file", "-p", newest!.commitHash], {
        env: { ...process.env, GIT_DIR: gitDir },
        encoding: "utf-8",
      });
      expect(commitBody).toContain(`parent ${prior!.commitHash}`);
    },
    30_000,
  );
});

describe("checkpoints-wire — a rewind keeps the compaction rows that predate the checkpoint (GitHub #36 review 4)", () => {
  const tmpDirs: string[] = [];
  const stores: SqlitePersistenceAdapter[] = [];

  function makeTmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function makeStore(dbPath: string): SqlitePersistenceAdapter {
    const store = new SqlitePersistenceAdapter(dbPath);
    stores.push(store);
    return store;
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

  /**
   * The shape this pins is the one a timestamp cannot express: a FAILED manual
   * compaction changes NO history, so a checkpoint taken by the NEXT turn
   * restores a conversation whose newest item predates that row — while the
   * checkpoint itself was created afterwards and its snapshot already follows
   * the compaction. Judging by the newest restored item (the previous attempt)
   * deleted the row from the cache AND from storage, so it also vanished for
   * good. The boundary is the record SEQUENCE captured at the turn's start.
   */
  it(
    "keeps a failed manual compaction that happened between turns, and drops a compaction recorded after the checkpoint's snapshot",
    async () => {
      const workspace = makeTmp("anycode-cp36-ws-");
      const dbDir = makeTmp("anycode-cp36-db-");
      const dbPath = join(dbDir, "anycode.sqlite");
      writeFileSync(join(workspace, "seed.txt"), "v1");

      const store = makeStore(dbPath);
      const sessionId = "sess-36";
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
      const records = new CompactionRecordLog(store, sessionId);

      const h = createHarness({
        steps: [
          toolStep("w1", "Write", { file_path: join(workspace, "greeting.txt"), content: "hello" }),
          finishStep(),
          // Consumed by the post-rewind compaction below (a structural skip, so
          // the scripted step may go unused — no model call is made).
          finishStep(),
        ],
        checkpoints: service ?? undefined,
        checkpointsSeam: service ?? undefined,
        compactionRecords: records,
        // Two durable items said BEFORE the compaction: the checkpoint's
        // pre-turn snapshot restores exactly these, so its newest instant is
        // strictly older than the failed record — the exact shape a timestamp
        // rule misreads.
        bootHistory: [
          { id: "h1", createdAt: 1, message: { role: "user", content: "first" } },
          { id: "h2", createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "answered" }] } },
        ],
        cwd: workspace,
        mode: "build",
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        // 1. A manual compaction BETWEEN turns, on an empty conversation: it is
        //    not applied ("no prefix…") and changes no history — but it is a
        //    real recorded outcome, seq 1.
        h.send({ type: "compact_request" });
        const end = await h.waitFor(
          (m): m is Of<"agent_event"> => m.type === "agent_event" && m.event.type === "compaction_end",
        );
        expect((end.event as { ok: boolean }).ok).toBe(false);
        expect(records.list()).toHaveLength(1);
        const failed = records.list()[0]!;
        expect(failed.ok).toBe(false);

        // 2. The NEXT turn creates the automatic checkpoint — lazily, at its
        //    write-effect tool — and its boundary is the sequence sampled at the
        //    turn's start, i.e. AFTER that failed row exists.
        h.send({ type: "user_message", requestId: "r1", text: "write a file" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("w1"), 15_000);
        await h.waitFor(
          (m): m is Of<"agent_event"> => m.type === "agent_event" && m.event.type === "loop_end",
          15_000,
        );

        const checkpoints = await store.listCheckpoints(sessionId);
        const auto = checkpoints.find((row) => row.reason === "auto");
        expect(auto).toBeDefined();
        // The restored history is OLDER than the record: the newest-item rule
        // judged the failed row as "after the snapshot" and deleted it.
        const full = await store.getCheckpoint(auto!.id);
        const restored = JSON.parse(full!.historyJson) as { createdAt: number }[];
        const newestRestored = Math.max(0, ...restored.map((item) => item.createdAt));
        expect(newestRestored).toBe(2);
        expect(failed.createdAt).toBeGreaterThan(newestRestored);

        // 3. Rewind the conversation to it.
        h.send({ type: "rewind_request", requestId: "rw1", checkpointId: auto!.id, scope: "conversation" });
        const res = await h.waitFor(
          (m): m is Of<"rewind_result"> => m.type === "rewind_result",
          15_000,
        );
        expect(res.ok).toBe(true);
        expect(res.conversationRestored).toBe(true);

        // THE claim: the valid row survives — live...
        expect(records.list().map((entry) => entry.id)).toEqual([failed.id]);
        // ...and after a reopen (the durable side was never deleted).
        await records.flush();
        expect((await store.listCompactionRecords(sessionId)).map((entry) => entry.id)).toEqual([failed.id]);
        // The mechanism: the row got the first sequence, and the checkpoint
        // stored the boundary current at ITS turn start (which already covers
        // that row).
        expect(failed.seq).toBe(1);
        expect(auto!.compactionSeq).toBe(1);
        // ...and the row still rides the handshake the truncated transcript came with
        // (delivery over the port is asynchronous — wait for that frame).
        const rewindAt = h.received.indexOf(res);
        await h.waitUntil(
          () => h.received.slice(rewindAt).some((message) => message.type === "session_history"),
          15_000,
        );
        const handshake = h.received
          .filter((message): message is Of<"session_history"> => message.type === "session_history")
          .at(-1);
        expect(handshake?.compactions?.map((entry) => entry.id)).toEqual([failed.id]);

        // 4. The OTHER direction, with the same real checkpoint: a compaction
        //    recorded AFTER the snapshot (seq 2 > boundary 1) belongs to the
        //    conversation the rewind discards and must go — while the older row
        //    stays.
        h.send({ type: "compact_request" });
        await h.waitUntil(() => records.list().length === 2, 15_000);
        expect(records.list()[1]!.ok).toBe(false);
        const later = records.list()[1]!;
        expect(later.seq).toBe(2);

        h.send({ type: "rewind_request", requestId: "rw2", checkpointId: auto!.id, scope: "conversation" });
        const res2 = await h.waitFor(
          (m): m is Of<"rewind_result"> => m.type === "rewind_result" && m.requestId === "rw2",
          15_000,
        );
        expect(res2.ok).toBe(true);
        // Only the pre-checkpoint row survives; the newer one is gone live and
        // durable.
        await records.flush();
        expect((await store.listCompactionRecords(sessionId)).map((entry) => entry.id)).toEqual([failed.id]);
        expect(records.list().map((entry) => entry.id)).toEqual([failed.id]);
        expect([failed.seq, later.seq]).toEqual([1, 2]);
      } finally {
        h.close();
      }
    },
    30_000,
  );
});
