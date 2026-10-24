/**
 * artifacts-wire (Taskana 4104 / TASK.110): proves the desktop wires the
 * artifact store that the CLI already has (cli/main.ts TASK.94 wiring) but the
 * desktop lacked — an oversized Bash result was truncated with no path back.
 *
 * What is pinned here and why:
 *
 *   (a) Barrel proof: `NodeArtifactStore` and `ARTIFACT_MAX_AGE_MS` are
 *       importable from `@anycode/core`'s ROOT (the desktop imports core only
 *       via the root barrel and registered subpaths — see package.json exports;
 *       pre-Taskana-4104 neither symbol was on it).
 *   (b) Harness threading: the HarnessOptions `artifacts` seam lands in
 *       AgentLoopConfig.artifacts as the SAME reference; omitted -> the config
 *       literal has no `artifacts` at all (spill degrades to truncation,
 *       byte-identical for every existing test).
 *   (c) Real store round-trip over the REAL root: a NodeArtifactStore built
 *       exactly as host boot builds it (artifactsRootFor(dbPath, home)) writes
 *       `<root>/<sessionId>/<toolCallId>` and removeSession removes the dir.
 *
 * There is deliberately NO e2e spill through the harness: the harness
 * `ports.exec` is a stub, so Bash cannot execute; the spill itself is owned and
 * covered by core's packages/core/src/dispatch/artifact-spill.test.ts — the
 * desktop owns only the wiring asserted here.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_MAX_AGE_MS, NodeArtifactStore } from "@anycode/core";
import { artifactsRootFor } from "../shared/artifacts-root.js";
import { createHarness, finishStep, textStep } from "./test-harness.js";

describe("artifacts-wire (Taskana 4104) — desktop wires the TASK.94 artifact store", () => {
  it("barrel proof: NodeArtifactStore and ARTIFACT_MAX_AGE_MS are on the @anycode/core root", () => {
    expect(typeof NodeArtifactStore).toBe("function");
    expect(ARTIFACT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("harness threading: omitted -> config.artifacts undefined; supplied -> the SAME reference", () => {
    const bare = createHarness({ steps: [textStep("hi"), finishStep()] });
    try {
      expect(bare.config.artifacts).toBeUndefined();
    } finally {
      bare.close();
    }

    const store = {
      writeToolResultArtifact: async () => ({ path: "/dev/null", bytes: 0 }),
      removeSession: async () => {},
      sweepExpired: async () => ({ removed: [] as string[] }),
    };
    const artifacts = { store, sessionId: "test-session" };
    const wired = createHarness({
      steps: [textStep("hi"), finishStep()],
      artifacts,
    });
    try {
      expect(wired.config.artifacts).toBe(artifacts);
    } finally {
      wired.close();
    }
  });

  it("real store round-trip over the real root (artifactsRootFor construction shape)", async () => {
    const home = mkdtempSync(join(tmpdir(), "anycode-artifacts-wire-"));
    try {
      const dbPath = join(home, "anycode.sqlite");
      const store = new NodeArtifactStore(artifactsRootFor(dbPath, home));
      const { path, bytes } = await store.writeToolResultArtifact({
        sessionId: "s1",
        toolCallId: "t1",
        toolName: "Bash",
        content: "x",
        contentType: "text/plain",
        retention: "session",
      });
      expect(path).toBe(join(artifactsRootFor(dbPath, home), "s1", "t1"));
      expect(bytes).toBe(1);
      expect(existsSync(path)).toBe(true);
      await store.removeSession("s1");
      expect(existsSync(join(artifactsRootFor(dbPath, home), "s1"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
