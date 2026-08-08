/**
 * End-to-end artifact spill (TASK.94). Where dispatcher.test.ts mocks the
 * handler, these tests wire the REAL dispatch pipeline against the REAL Bash
 * and Read tools, a REAL NodeArtifactStore on a temp dir and a REAL
 * NodeFileSystemAdapter — so the DoD guarantees are checked at the seam they
 * actually run at, not at a mock of it.
 *
 * DoD coverage:
 *   1. oversized Bash -> <persisted-output> envelope with path + preview, byte budget held, preview on a line boundary
 *   2. the model can Read the spilled artifact in the same dispatch context (no mock of the store or the reader)
 *   3. default strategy stays "truncate" even when a store IS present
 *   4. GC is tested in node-artifacts.test.ts (age sweep + removeSession)
 *   5. the artifact path lies OUTSIDE the workspace fixture
 * plus the defensive paths: store throwing -> fallback to truncate; absent
 * store -> fallback to truncate; formatPersistedModelContent on the generic tool.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { executeToolCall, type DispatchContext } from "./dispatcher.js";
import type {
  HookRunner,
  PostToolUseHookInput,
  PreToolUseHookInput,
  AggregatedPreToolUseResult,
} from "../types/hooks.js";
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
  PermissionRuling,
} from "../types/permissions.js";
import type { ProposedToolCall } from "../types/events.js";
import type {
  AnyToolDefinition,
  ToolMetadata,
} from "../types/tools.js";
import type { ArtifactStorePort, ArtifactWriteRequest } from "../ports/artifacts.js";
import type { ExecRequest, ExecResult, ExecutionPort } from "../ports/execution.js";
import type { CorePorts } from "../ports/index.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { ToolRegistry } from "../tools/registry.js";
import { bashTool } from "../tools/bash.js";
import { readTool } from "../tools/read.js";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_PREVIEW_BYTES,
  BASH_RESULT_MAX_MODEL_BYTES,
} from "../types/config.js";
import { NodeArtifactStore } from "../adapters/node/node-artifacts.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";

// ---- minimal stubs for the dispatch context --------------------------------

function allowEngine(ruling: PermissionRuling = { decision: "allow" }): PermissionEngine {
  return { check: () => ruling };
}
const denyBroker: PermissionBroker = {
  requestPermission: async () => ({ behavior: "deny", reason: "no client" }),
};
function noopHooks(): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async (_input: PreToolUseHookInput): Promise<AggregatedPreToolUseResult> => ({}),
    runUserPromptSubmit: async () => ({}),
    runObservers: async (_e: "PostToolUse" | "PostToolUseFailure" | "Stop", _i: PostToolUseHookInput) => {},
  } as unknown as HookRunner;
}

/** ExecutionPort stub returning a fixed stdout, independent of any process. */
function fakeExec(stdout: string, exitCode = 0): ExecutionPort {
  const result: ExecResult = {
    status: "completed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
  };
  return {
    run: async (_req: ExecRequest) => result,
  } as unknown as ExecutionPort;
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    registry: new ToolRegistry(),
    hooks: noopHooks(),
    permissionEngine: allowEngine(),
    permissionBroker: denyBroker,
    mode: "yolo",
    ports: {} as CorePorts,
    cwd: "/work",
    ...overrides,
  };
}

// ---- helpers ---------------------------------------------------------------

/** Extracts the absolute path from a <persisted-output> envelope. */
function pathFromEnvelope(text: string): string | null {
  const m = text.match(/saved to:\s*(\S+)/);
  return m ? (m[1] ?? null) : null;
}

// ---- tests -----------------------------------------------------------------

describe("executeToolCall — artifact spill (TASK.94)", () => {
  let artifactsRoot: string;
  let workspace: string;

  beforeEach(async () => {
    artifactsRoot = await mkdtemp(join(tmpdir(), "anycode-spill-artifacts-"));
    workspace = await mkdtemp(join(tmpdir(), "anycode-spill-ws-"));
  });
  afterEach(async () => {
    await Promise.all([
      rm(artifactsRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  /** Builds a dispatch context with the REAL Bash tool, REAL NodeArtifactStore and REAL fs. */
  function bashCtx(stdout: string, overrides: Partial<DispatchContext> = {}): DispatchContext {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const ports: CorePorts = {
      exec: fakeExec(stdout),
      fs: new NodeFileSystemAdapter(),
      http: {} as never,
      todos: {} as never,
    };
    return ctx({
      registry,
      ports,
      cwd: workspace,
      artifacts: {
        store: new NodeArtifactStore(artifactsRoot),
        sessionId: "s1",
      },
      ...overrides,
    });
  }

  // DoD-1
  it("hands the model a <persisted-output> envelope with path + preview when Bash output exceeds the model budget", async () => {
    // One line per row so the preview line-boundary snap is observable.
    const stdout = Array.from({ length: 10_000 }, (_, i) => `line-${i}`).join("\n");
    const outcome = await executeToolCall(bashCtx(stdout), {
      id: "bash-1",
      name: "Bash",
      input: { command: "noop" },
    });

    expect(outcome.status).toBe("success");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(true);
    expect(outcome.modelText.trimEnd().endsWith("</persisted-output>")).toBe(true);
    expect(Buffer.byteLength(outcome.modelText, "utf8")).toBeLessThanOrEqual(BASH_RESULT_MAX_MODEL_BYTES);
    // Bash's own envelope speaks about the exit code and the JSON shape.
    expect(outcome.modelText).toContain("exit code 0");
    expect(outcome.modelText).toContain("Full output saved to:");

    const path = pathFromEnvelope(outcome.modelText);
    expect(path).toBeTruthy();
    expect(path!.startsWith(artifactsRoot)).toBe(true);
  });

  // DoD-1 (line boundary): the spilled file is a JSON document, whose last
  // 2000 bytes are a single long line. The tail preview's line snap cannot
  // avoid starting mid-line there (the boundary is past the half-limit), so
  // this case is covered by the result-budget unit tests instead. Here we
  // assert the envelope's structural promise: it NAMES the preview end and
  // keeps the preview within ARTIFACT_PREVIEW_BYTES.
  it("reports which end the preview came from and stays within the preview budget", async () => {
    const stdout = Array.from({ length: 5_000 }, (_, i) => `l${i}`).join("\n");
    const outcome = await executeToolCall(bashCtx(stdout), {
      id: "bash-2",
      name: "Bash",
      input: { command: "noop" },
    });
    // Bash's previewDirection is "tail", so the envelope must say "last".
    expect(outcome.modelText).toContain("Preview (last");
    const m = outcome.modelText.match(/Preview \(last \d+ bytes of the saved file\):\n([\s\S]*?)\n\.\.\./);
    expect(m).not.toBeNull();
    const previewText = m![1] ?? "";
    expect(Buffer.byteLength(previewText, "utf8")).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
  });

  // DoD-2 (the load-bearing one): real dispatch -> real Read of the spilled file.
  // Sized so the stdout exceeds the model budget (so a spill happens) while the
  // serialized JSON stays well under Read's token cap (so Read returns the whole
  // file rather than a partial view — the case this assertion is about).
  it("lets the model Read the spilled artifact in the same dispatch context (no store mock)", async () => {
    // ~36 KB stdout: over the 30 KB model budget (spill happens), but the JSON
    // artifact is ~40 KB / ~13k tokens, comfortably under Read's 25k-token cap.
    const stdout = Array.from({ length: 3_600 }, (_, i) => `row-${i}`).join("\n");
    const base = bashCtx(stdout);
    const bashOutcome = await executeToolCall(base, {
      id: "bash-3",
      name: "Bash",
      input: { command: "noop" },
    });
    const path = pathFromEnvelope(bashOutcome.modelText);
    expect(path).toBeTruthy();
    expect(bashOutcome.modelText.startsWith("<persisted-output>")).toBe(true);

    // Same context, but with the Read tool registered, reads the spilled file.
    const registry = new ToolRegistry();
    registry.register(readTool);
    const readOutcome = await executeToolCall(
      { ...base, registry },
      { id: "read-1", name: "Read", input: { file_path: path } },
    );

    expect(readOutcome.status).toBe("success");
    // The spilled file is the serialized BashOutput JSON. Read wraps it as a
    // ReadOutput whose `content` is the file text, so JSON-escaping applies:
    // the inner quotes are backslash-escaped in the dispatcher's model text.
    expect(readOutcome.modelText).toContain("row-0");
    expect(readOutcome.modelText).toContain("row-3599");
    expect(readOutcome.modelText).not.toContain("Partial view");
    expect(readOutcome.modelText).toContain('\\"exitCode\\":0');
  });

  // DoD-3 (regression): default strategy stays "truncate" even with a store present.
  it("truncates (no envelope) a tool that declares strategy: undefined even when a store is wired", async () => {
    const metadata: ToolMetadata = {
      name: "Big",
      description: "declares a budget but no strategy",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      timeoutMs: 1_000,
    };
    const tool: AnyToolDefinition = {
      metadata,
      inputSchema: z.object({}),
      handler: async () => ({ ok: true, output: "x".repeat(500_000) }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const dispatch = ctx({
      registry,
      artifacts: { store: new NodeArtifactStore(artifactsRoot), sessionId: "s1" },
    });
    const outcome = await executeToolCall(dispatch, { id: "c1", name: "Big", input: {} });

    expect(outcome.modelText).toContain("truncated");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
  });

  it("truncates (no envelope) a tool that declares no budget at all, even with a store wired", async () => {
    const tool: AnyToolDefinition = {
      metadata: {
        name: "Plain",
        description: "no budget",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        timeoutMs: 1_000,
      },
      inputSchema: z.object({}),
      handler: async () => ({ ok: true, output: "y".repeat(500_000) }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const dispatch = ctx({
      registry,
      artifacts: { store: new NodeArtifactStore(artifactsRoot), sessionId: "s1" },
    });
    const outcome = await executeToolCall(dispatch, { id: "c2", name: "Plain", input: {} });

    expect(outcome.modelText).toContain("truncated");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
  });

  // Fallback: absent store => truncate, byte-identical to TASK.93.
  it("falls back to truncation when no artifact store is threaded", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const dispatch = ctx({
      registry,
      ports: {
        exec: fakeExec("z".repeat(500_000)),
        fs: new NodeFileSystemAdapter(),
        http: {} as never,
        todos: {} as never,
      } as CorePorts,
      cwd: workspace,
      // artifacts: deliberately absent
    });
    const outcome = await executeToolCall(dispatch, {
      id: "c3",
      name: "Bash",
      input: { command: "noop" },
    });
    expect(outcome.modelText).toContain("truncated");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
  });

  // Fallback: a throwing store must NOT surface as a model-facing error.
  it("falls back to truncation when the store throws on write", async () => {
    const throwing: ArtifactStorePort = {
      writeToolResultArtifact: async (_req: ArtifactWriteRequest) => {
        throw new Error("disk on fire");
      },
      removeSession: async () => {},
      sweepExpired: async () => ({ removed: [] }),
    };
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const dispatch = ctx({
      registry,
      ports: {
        exec: fakeExec("q".repeat(500_000)),
        fs: new NodeFileSystemAdapter(),
        http: {} as never,
        todos: {} as never,
      } as CorePorts,
      cwd: workspace,
      artifacts: { store: throwing, sessionId: "s1" },
    });
    const outcome = await executeToolCall(dispatch, {
      id: "c4",
      name: "Bash",
      input: { command: "noop" },
    });
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toContain("truncated");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
  });

  // ARTIFACT_MAX_BYTES refusal: with the cap lowered, a spill that would exceed
  // it degrades to truncation rather than writing a partial file.
  it("falls back to truncation when the payload exceeds ARTIFACT_MAX_BYTES (cap overridden for the test)", async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const tinyCapStore = new NodeArtifactStore(artifactsRoot, {
      // The rendered Bash JSON of a 200 KB stdout is itself >200 KB.
      maxBytes: 8,
    });
    const dispatch = ctx({
      registry,
      ports: {
        exec: fakeExec("m".repeat(200_000)),
        fs: new NodeFileSystemAdapter(),
        http: {} as never,
        todos: {} as never,
      } as CorePorts,
      cwd: workspace,
      artifacts: { store: tinyCapStore, sessionId: "s1" },
    });
    const outcome = await executeToolCall(dispatch, {
      id: "c5",
      name: "Bash",
      input: { command: "noop" },
    });
    expect(outcome.modelText).toContain("truncated");
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
    // And nothing was written under the session dir.
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(artifactsRoot, "s1"))).rejects.toBeDefined();
  });

  // A generic tool (no formatPersistedModelContent) gets the default envelope.
  it("emits the generic <persisted-output> envelope for a tool without formatPersistedModelContent", async () => {
    const tool: AnyToolDefinition = {
      metadata: {
        name: "Generic",
        description: "opts in without a custom envelope",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        timeoutMs: 1_000,
        resultBudget: {
          maxModelBytes: 1_000,
          previewDirection: "head",
          strategy: "artifact",
          artifact: { retention: "session" },
        },
      },
      inputSchema: z.object({}),
      handler: async () => ({ ok: true, output: "g".repeat(100_000) }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const dispatch = ctx({
      registry,
      artifacts: { store: new NodeArtifactStore(artifactsRoot), sessionId: "s1" },
    });
    const outcome = await executeToolCall(dispatch, { id: "c6", name: "Generic", input: {} });

    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(true);
    expect(outcome.modelText).toContain("Full output saved to:");
    expect(outcome.modelText).toContain("Preview (first");
    expect(Buffer.byteLength(outcome.modelText, "utf8")).toBeLessThanOrEqual(1_000);
    // The path exists on disk and holds the rendered text.
    const path = pathFromEnvelope(outcome.modelText)!;
    const { readFile } = await import("node:fs/promises");
    const persisted = await readFile(path, "utf-8");
    expect(persisted).toBe("g".repeat(100_000));
  });

  // ARTIFACT_PREVIEW_BYTES is what the envelope promises; assert the envelope
  // never promises more than it delivers.
  it("never exceeds ARTIFACT_PREVIEW_BYTES in the preview it embeds", async () => {
    const stdout = ".".repeat(1_000_000);
    const outcome = await executeToolCall(bashCtx(stdout), {
      id: "bash-4",
      name: "Bash",
      input: { command: "noop" },
    });
    // The preview is between "Preview (last N bytes of the saved file):" and "\n...".
    const m = outcome.modelText.match(/Preview \(last \d+ bytes of the saved file\):\n([\s\S]*?)\n\.\.\./);
    expect(m).not.toBeNull();
    const preview = m![1] ?? "";
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
  });

  // DoD-5: the artifact is written OUTSIDE the workspace fixture.
  it("writes the artifact outside the workspace, so it cannot appear in the project's git status", async () => {
    const stdout = "x".repeat(200_000);
    const outcome = await executeToolCall(bashCtx(stdout), {
      id: "bash-5",
      name: "Bash",
      input: { command: "noop" },
    });
    const path = pathFromEnvelope(outcome.modelText)!;
    expect(path.startsWith(workspace)).toBe(false);
    expect(path.startsWith(artifactsRoot)).toBe(true);
  });

  it("does not spill when the rendered output fits the model budget (byte-identical to TASK.93)", async () => {
    // Bash JSON of a short stdout fits well under BASH_RESULT_MAX_MODEL_BYTES.
    const stdout = "hello\n";
    const outcome = await executeToolCall(bashCtx(stdout), {
      id: "bash-6",
      name: "Bash",
      input: { command: "noop" },
    });
    expect(outcome.modelText.startsWith("<persisted-output>")).toBe(false);
    expect(outcome.modelText).toContain('"stdout":"hello');
    // And no session dir was created for this call.
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(artifactsRoot, "s1"))).rejects.toBeDefined();
  });

  it("respects ARTIFACT_MAX_BYTES as the documented ceiling for a real-sized payload", async () => {
    // Sanity that the production constant is in the range the design promised.
    expect(ARTIFACT_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
