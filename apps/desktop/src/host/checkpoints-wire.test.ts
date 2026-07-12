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
        steps: [toolStep("w1", "Write", { file_path: join(workspace, "greeting.txt"), content: "hello" }), finishStep()],
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
