/**
 * lsp-wire e2e (slice 6.DP-1, design slice-6.DP-1-cut.md §1.5 / §6#1-#5): the
 * diagnostics-after-edit path exercised end-to-end over the REAL worker_threads
 * MessageChannel + REAL Session/AgentLoop + a REAL LspManager driving a REAL
 * child (`fake-lsp-server.cjs`) via NodeExecutionAdapter — the same shape as
 * git-wire.test.ts. Proves the desktop CONSUMPTION of the shipped 6.1 LSP core:
 *
 *  (#1) a Write on a matching `.ts` file surfaces the server's real diagnostics
 *       on the tool_result the model (and UI) sees; a clean file -> "none reported".
 *  (#2) the reap discipline leaves ZERO orphans — a live server is dead (ESRCH)
 *       after disposeAll, and a teardown-hostile (`--ignore-term`) server dies
 *       only via SIGKILL escalation (>= SIGKILL_GRACE_MS after SIGTERM).
 *  (#4) a plan-mode deny writes nothing AND spawns nothing (spawn lives strictly
 *       after a successful write); plus the metadata-identity lock.
 *  (#5) the SAME scripted turn is byte-identical WITHOUT `lsp` vs WITH `lsp` on a
 *       non-matching (`.md`) file — payload, permission shape, and registry list.
 *
 * NO fixed sleeps: poll-with-deadline only (isPidAlive-flake lesson). Every
 * LspManager spawned is disposed in afterEach so the suite leaves no orphans.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { LspManager, NodeExecutionAdapter, SIGKILL_GRACE_MS, diagnosticsEditTool, editTool } from "@anycode/core";
import type { LspServerSpec } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { createHarness, finishStep, toolStep } from "./test-harness.js";

// Fixture resolve is FROZEN (§1.5): core exports-map "." -> ./src/index.ts, so
// dirname(resolve("@anycode/core")) is packages/core/src. Fail loud (never skip)
// if it drifts.
const FIXTURE = join(
  dirname(createRequire(import.meta.url).resolve("@anycode/core")),
  "lsp/fixtures/fake-lsp-server.cjs",
);
if (!existsSync(FIXTURE)) {
  throw new Error(
    `lsp-wire.test: fixture not found at ${FIXTURE} — the frozen @anycode/core exports-map resolve (slice 6.DP-1 §1.5) drifted; fix the resolve, do not skip.`,
  );
}

// LSP_DIAGNOSTICS_TIMEOUT_MS and LSP_DISPOSE_DEADLINE_MS (core types/config.ts)
// are both 3_000ms and are NOT on the public barrel; mirrored here for the
// waitFor deadlines. The harness default (1s) is smaller than the diagnostics
// bound, so the tool_result waits below pass explicit larger timeouts.
const DIAG_TIMEOUT_MS = 3_000;
const DISPOSE_DEADLINE_MS = 3_000;
/** tool_result only arrives after spawn+init+publish (bounded by the diagnostics timeout): full bound + generous slack. */
const RESULT_WAIT_MS = DIAG_TIMEOUT_MS + 9_000;

const spec = (extra: string[] = []): LspServerSpec => ({
  name: "fake",
  command: process.execPath,
  args: [FIXTURE, ...extra],
  extensions: [".ts"],
});

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const toolResultOf =
  (toolCallId: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === toolCallId;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

describe("lsp-wire e2e — real LspManager + real fixture child over the real MessageChannel", () => {
  const managers: LspManager[] = [];

  function makeManager(extra: string[] = []): LspManager {
    const manager = new LspManager(new NodeExecutionAdapter(), [spec(extra)], process.cwd());
    managers.push(manager);
    return manager;
  }

  afterEach(async () => {
    // Never leave an orphan fixture child behind, even if an assertion threw.
    await Promise.all(managers.map((m) => m.disposeAll()));
    managers.length = 0;
  });

  // ── §6#1 ──────────────────────────────────────────────────────────────────
  it(
    "surfaces the real child's diagnostics on the tool_result for a DIAG-marked .ts Write (§6#1)",
    async () => {
      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("c1", "Write", { file_path: "/workspace/x.ts", content: "let a = 1\nDIAG:type mismatch\n" }), finishStep()],
        lsp: manager,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "write it" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

        const msg = await h.waitFor(toolResultOf("c1"), RESULT_WAIT_MS);
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        const outcome = msg.event.outcome;
        expect(outcome.status).toBe("success");
        // The model-visible text (JSON of the tool output) carries the real
        // diagnostic message published by the fixture child.
        expect(outcome.modelText).toContain("type mismatch");
        const output = outcome.result?.output as { diagnostics?: string } | undefined;
        expect(output?.diagnostics).toContain("error");
        expect(output?.diagnostics).toContain("type mismatch");

        // The server actually spawned and is live.
        const st = manager.status()[0]!;
        expect(st.state).toBe("ready");
        expect(st.pid).toBeGreaterThan(0);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  it(
    "attaches 'none reported' when the real child publishes an empty diagnostics set for a clean .ts Write (§6#1)",
    async () => {
      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("c1", "Write", { file_path: "/workspace/clean.ts", content: "const ok = 1\n" }), finishStep()],
        lsp: manager,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "write it" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

        const msg = await h.waitFor(toolResultOf("c1"), RESULT_WAIT_MS);
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        const output = msg.event.outcome.result?.output as { diagnostics?: string } | undefined;
        expect(output?.diagnostics).toBe("none reported");
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#2 ──────────────────────────────────────────────────────────────────
  it(
    "reaps the harness-threaded server to ESRCH after disposeAll — zero orphans (§6#2)",
    async () => {
      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("c1", "Write", { file_path: "/workspace/x.ts", content: "DIAG:boom\n" }), finishStep()],
        lsp: manager,
      });
      let pid: number;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "write it" });
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitFor(toolResultOf("c1"), RESULT_WAIT_MS);

        const st = manager.status()[0]!;
        expect(st.state).toBe("ready");
        pid = st.pid!;
        expect(pid).toBeGreaterThan(0);
        expect(isPidAlive(pid)).toBe(true);
      } finally {
        h.close();
      }

      const t0 = Date.now();
      await manager.disposeAll();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(DISPOSE_DEADLINE_MS + 1_500);
      expect(await waitPidDead(pid, 5_000)).toBe(true);
      expect(isPidAlive(pid)).toBe(false);
      expect(manager.status()[0]!.state).toBe("disposed");
    },
    30_000,
  );

  it(
    "a --ignore-term server dies only via SIGKILL escalation (>= SIGKILL_GRACE_MS after SIGTERM), never orphaned (§6#2)",
    async () => {
      // Kill discipline needs no wire: drive the manager straight to ready. The
      // fixture still replies to initialize + publishes; it only refuses the
      // shutdown/exit handshake AND ignores SIGTERM, forcing SIGKILL.
      const manager = makeManager(["--ignore-term"]);
      const outcome = await manager.diagnosticsAfterWrite("/proj/a.ts", "DIAG:x\n");
      expect(outcome.available).toBe(true);
      const pid = manager.status()[0]!.pid!;
      expect(pid).toBeGreaterThan(0);
      expect(isPidAlive(pid)).toBe(true);

      const t0 = Date.now();
      await manager.disposeAll();
      const elapsed = Date.now() - t0;
      // A polite server would settle in tens of ms; a teardown-hostile one cannot
      // die before the SIGTERM->SIGKILL grace elapses.
      expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS);
      expect(elapsed).toBeLessThan(DISPOSE_DEADLINE_MS + 1_500);
      expect(await waitPidDead(pid, 5_000)).toBe(true);
      expect(isPidAlive(pid)).toBe(false);
    },
    30_000,
  );

  // ── §6#4 ──────────────────────────────────────────────────────────────────
  it(
    "plan-mode deny writes nothing AND spawns nothing (spawn strictly after a successful write) (§6#4)",
    async () => {
      // Metadata-identity lock (L6): the wrapper reuses the inner tool's metadata
      // OBJECT by reference, so the permission path is byte-identical.
      expect(diagnosticsEditTool.metadata).toBe(editTool.metadata);

      const manager = makeManager();
      const h = createHarness({
        steps: [toolStep("c1", "Write", { file_path: "/workspace/x.ts", content: "DIAG:should never run\n" }), finishStep()],
        mode: "plan",
        lsp: manager,
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.send({ type: "user_message", requestId: "r1", text: "write it" });
        const msg = await h.waitFor(toolResultOf("c1"));
        if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
        expect(msg.event.outcome.status).toBe("denied");

        await h.flush();
        // The write never happened...
        expect(await h.toolFs.exists("/workspace/x.ts")).toBe(false);
        // ...so the wrapper handler never ran and no server was spawned.
        expect(manager.status().every((s) => s.state === "not_started")).toBe(true);
        expect(manager.status()[0]!.pid).toBeUndefined();
        // plan-mode ruling for a non-readOnly tool is a direct deny — the broker/UI
        // is never consulted.
        expect(h.received.some(isPermissionRequest)).toBe(false);
      } finally {
        h.close();
      }
    },
    30_000,
  );

  // ── §6#5 ──────────────────────────────────────────────────────────────────
  it(
    "byte-identical WITHOUT lsp vs WITH lsp on a non-matching file: payload, permission shape, registry list (§6#5)",
    async () => {
      const INPUT = { file_path: "/workspace/note.md", content: "just notes\n" };

      type Captured = {
        output: unknown;
        modelText: string;
        status: string;
        perm: { toolName: string; input: unknown; mode: string; metadata: unknown };
        toolNames: string[];
        serverStates: string[] | undefined;
      };

      async function runTurn(withLsp: boolean): Promise<Captured> {
        // extensions are [".ts"]; a .md write never matches, so the server is
        // never spawned even in the WITH-lsp world.
        const manager = withLsp ? makeManager() : undefined;
        const h = createHarness({
          steps: [toolStep("c1", "Write", INPUT), finishStep()],
          ...(manager ? { lsp: manager } : {}),
        });
        try {
          h.send({ type: "ui_ready" });
          await h.waitFor(isHostReady);

          h.send({ type: "user_message", requestId: "r1", text: "write notes" });
          const req = await h.waitFor(isPermissionRequest);
          h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

          const msg = await h.waitFor(toolResultOf("c1"), RESULT_WAIT_MS);
          if (msg.event.type !== "tool_result") throw new Error("expected tool_result");
          const outcome = msg.event.outcome;
          return {
            output: outcome.result?.output,
            modelText: outcome.modelText,
            status: outcome.status,
            // requestId is broker-generated (non-deterministic) — compare the shape only.
            perm: { toolName: req.toolName, input: req.input, mode: req.mode, metadata: req.metadata },
            toolNames: h.config.registry.list(),
            serverStates: manager?.status().map((s) => s.state),
          };
        } finally {
          h.close();
        }
      }

      const withoutLsp = await runTurn(false);
      const withLsp = await runTurn(true);

      // The tool_result payload is byte-identical: a non-matching extension yields
      // no_server, so NO diagnostics field is attached.
      expect(withLsp.output).toEqual(withoutLsp.output);
      expect(withLsp.modelText).toBe(withoutLsp.modelText);
      expect(withLsp.status).toBe(withoutLsp.status);
      // permission_request shape (incl. the shared metadata object) is identical.
      expect(withLsp.perm).toEqual(withoutLsp.perm);
      // The model-facing tool surface is identical (re-registration reuses names).
      expect(withLsp.toolNames).toEqual(withoutLsp.toolNames);
      // The WITH-lsp world never spawned a server for the .md write.
      expect(withLsp.serverStates).toEqual(["not_started"]);
    },
    30_000,
  );
});
