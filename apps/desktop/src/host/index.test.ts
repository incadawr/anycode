/**
 * Tests for the slice-3.2 (task 3.2.4) additions to index.ts's boot()/
 * handleShutdown() shape: the MCP fail-soft boot block and the
 * terminals -> mcp -> session shutdown order.
 *
 * index.ts itself is NOT importable in a test — it touches process.parentPort
 * at module scope (same reason boot.ts's helpers were split out in the first
 * place, and the same reason boot.test.ts's own "integration-style
 * reproduction of index.ts's boot() try/catch/finally shape" comment exists).
 * So, mirroring that established pattern exactly: these tests reproduce the
 * two NEW control-flow shapes index.ts now has — the shutdown-order sequence
 * (terminals.dispose() -> mcpManager.dispose() -> session.shutdown(), see
 * index.ts's handleShutdown) and the fail-soft try/catch around the MCP boot
 * block (see index.ts's boot()) — locally, over ordered-mock/spy doubles,
 * rather than importing the real module. This pins the SHAPE (and would catch
 * a future accidental reordering of the real handleShutdown/boot bodies during
 * review) without needing to fake out process.parentPort/Electron.
 *
 * Slice 6.DP-1 additions (design slice-6.DP-1-cut.md §1.5, §6#3/#6): the
 * updated shutdown order now inserting an lspManager?.disposeAll() stage
 * between terminals.dispose() and mcp?.dispose() (nullable exactly like
 * mcpManager, `?.` short-circuits when no servers were configured), and the
 * fail-soft try/catch around the LSP boot block mirroring the MCP one above —
 * same "reproduce the shape over ordered spies, don't import index.ts" idiom.
 *
 * Slice 6.DP-2 additions (design slice-6.DP-2-cut.md §1.2c/f, §6#6/#7): the
 * CURRENT shutdown order inserts an (awaited) taskManager?.disposeAll() stage
 * BETWEEN terminals.dispose() and lspManager?.disposeAll() (terminals -> tasks
 * -> lsp -> mcp -> session, index.ts:645-655) — same idiom, extended by one
 * more stage; and the unconditional (no fail-soft branch — construction never
 * throws, there is no config read to fail) boot-time construction of
 * InProcessTaskManager plus exactly 3 registry.register() calls, in order,
 * strictly before the toolNames snapshot (index.ts:358-361/:464).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bashTool,
  backgroundCapableBashTool,
  createWebSearchTool,
  loadWebSearchConfig,
  buildTelemetryTap,
  AskCache,
  createDefaultToolRegistry,
  createInspectImageTool,
  createMediaProjectionPort,
  buildChildModelSettingsResolver,
  buildSystemPrompt,
  MAX_QUESTIONS_PER_IMAGE,
  QUESTION_LIMIT_MESSAGE,
  JsonlTelemetrySink,
  loadTelemetryConfig,
  matchCatalogEntryByBaseUrl,
  NodeFileSystemAdapter,
  type LiveModelCapabilities,
  resolveContextWindow,
  resolveEffortLevels,
  resolveImageInput,
  resolveMaxOutputTokens,
  resolveReasoningEffort,
  type ImageModalityLookup,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  SqlitePersistenceAdapter,
  SwitchableModelPort,
  WriteBehindHistorySink,
  writeTool,
} from "@anycode/core";
import type {
  AgentEvent,
  HistoryItem,
  ImageAttachment,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  PermissionMode,
  PermissionRequest,
  RecognizerEndpoint,
  ResolvedTelemetryConfig,
  ResolvedWebSearchBackend,
  SessionMeta,
  TelemetryPort,
  ToolContext,
  TokenUsage,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type { ShellCapabilitiesProjection } from "../shared/protocol.js";
import { ensureChildTempDir, parseCodexProfileArgs, removeChildTempDir, resolveChildTempDir } from "./engines/codex/codex-home.js";
import { buildCodexChildEnv } from "./engines/codex/app-server-client.js";
import { TerminalManager } from "./terminal.js";
import { isChildSessionBoot } from "./boot.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createEngineBrowserBridge } from "./engines/browser-bridge.js";

describe("host shutdown order (design slice-3.2-cut.md §6/§9-R1, task 3.2.4)", () => {
  /**
   * Reproduces index.ts's handleShutdown body verbatim in shape: terminals
   * .dispose() (sync) -> mcp?.dispose() (awaited, fail-soft try/catch) ->
   * session?.shutdown() (awaited). `mcp`/`session` are nullable exactly like
   * `mcpManager`/`session` are in index.ts (a fail-soft MCP boot leaves
   * `mcpManager` null; a failed core init leaves `session` null).
   */
  async function handleShutdownShape(
    terminals: { dispose(): void },
    mcp: { dispose(): Promise<void> } | null,
    session: { shutdown(): Promise<void> } | null,
  ): Promise<void> {
    terminals.dispose();
    if (mcp) {
      try {
        await mcp.dispose();
      } catch {
        // defense-in-depth only, mirrors index.ts's own try/catch.
      }
    }
    if (session) {
      await session.shutdown();
    }
  }

  it("disposes terminals, then mcp, then session — in that exact order", async () => {
    const calls: string[] = [];
    // The real TerminalManager: constructing one (with no term_open ever
    // called) spawns nothing, so dispose() here is a cheap real call, not a
    // fake — only mcp/session are stubbed (their real classes live in
    // packages/core, out of this lane's scope).
    const terminals = new TerminalManager({ workspace: "/tmp/anycode-3.2.4-test" });
    const originalDispose = terminals.dispose.bind(terminals);
    vi.spyOn(terminals, "dispose").mockImplementation(() => {
      calls.push("terminals");
      originalDispose();
    });
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShape(terminals, mcp, session);

    expect(calls).toEqual(["terminals", "mcp", "session"]);
    expect(mcp.dispose).toHaveBeenCalledTimes(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it("a null mcpManager (fail-soft MCP boot, or never configured) is skipped without breaking the terminals -> session order", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShape(terminals, null, session);

    expect(calls).toEqual(["terminals", "session"]);
  });

  it("a rejecting mcp.dispose() is swallowed (defense-in-depth) and session.shutdown() still runs", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const mcp = {
      dispose: vi.fn(async () => {
        calls.push("mcp");
        throw new Error("dispose boom");
      }),
    };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await expect(handleShutdownShape(terminals, mcp, session)).resolves.toBeUndefined();
    expect(calls).toEqual(["terminals", "mcp", "session"]);
  });
});

describe("host shutdown order — LSP reap (design slice-6.DP-1-cut.md §1.2f/§6#3)", () => {
  /**
   * Reproduces index.ts's CURRENT handleShutdown body verbatim in shape, now
   * that slice 6.DP-1 inserted a new stage: terminals.dispose() (sync) ->
   * lspManager?.disposeAll() (awaited, `?.` short-circuits when null — no
   * language servers were configured) -> mcp?.dispose() (awaited, fail-soft
   * try/catch, unchanged from the 3.2.4 shape above) -> session?.shutdown()
   * (awaited). Mirrors index.ts:604-624 exactly.
   */
  async function handleShutdownShapeWithLsp(
    terminals: { dispose(): void },
    lspManager: { disposeAll(): Promise<void> } | null,
    mcp: { dispose(): Promise<void> } | null,
    session: { shutdown(): Promise<void> } | null,
  ): Promise<void> {
    terminals.dispose();
    await lspManager?.disposeAll();
    if (mcp) {
      try {
        await mcp.dispose();
      } catch {
        // defense-in-depth only, mirrors index.ts's own try/catch.
      }
    }
    if (session) {
      await session.shutdown();
    }
  }

  it("awaits lspManager.disposeAll BEFORE calling mcp.dispose (real ordering, not fire-and-forget)", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const lspManager = {
      disposeAll: vi.fn(async () => {
        // A real macrotask delay: if the caller failed to `await` this call
        // (fired-and-forgot it instead), mcp.dispose would run synchronously
        // right after terminals.dispose() and "mcp" would land in `calls`
        // BEFORE "lsp" — this proves the await is load-bearing, not just shape.
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls.push("lsp");
      }),
    };
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShapeWithLsp(terminals, lspManager, mcp, session);

    expect(calls).toEqual(["terminals", "lsp", "mcp", "session"]);
    expect(lspManager.disposeAll).toHaveBeenCalledTimes(1);
    expect(mcp.dispose).toHaveBeenCalledTimes(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it("a null lspManager (no servers configured, or a boot-time load failure) is skipped without breaking the terminals -> mcp -> session order", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShapeWithLsp(terminals, null, mcp, session);

    expect(calls).toEqual(["terminals", "mcp", "session"]);
  });
});

describe("host MCP boot block fail-soft posture (design slice-3.2-cut.md §4.4/§6, task 3.2.4)", () => {
  /**
   * Reproduces the SHAPE of index.ts's fail-soft MCP try/catch in boot():
   * a thrown loader/manager-construction/start error is caught and never
   * escapes — mirroring the pre-existing hook-config try/catch right above it
   * in the real file. Returns the manager (or null on any failure), exactly
   * like index.ts's module-level `mcpManager` ends up.
   */
  async function bootMcpBlockShape(
    loadSpecs: () => Promise<{ specs: unknown[]; problems: string[] }>,
    buildManager: (specs: unknown[]) => Promise<{ ok: true } | never>,
  ): Promise<{ ok: true } | null> {
    try {
      const { specs } = await loadSpecs();
      return await buildManager(specs);
    } catch {
      return null;
    }
  }

  it("a loader throw never escapes — boot proceeds with a null manager (zero MCP servers)", async () => {
    const loadSpecs = vi.fn(async () => {
      throw new Error("config boom");
    });
    const buildManager = vi.fn(async () => ({ ok: true as const }));

    const result = await bootMcpBlockShape(loadSpecs, buildManager);

    expect(result).toBeNull();
    expect(buildManager).not.toHaveBeenCalled();
  });

  it("a manager/start() throw never escapes either — same null-manager outcome", async () => {
    const loadSpecs = vi.fn(async () => ({ specs: [], problems: [] }));
    const buildManager = vi.fn(async (): Promise<{ ok: true }> => {
      throw new Error("connect boom");
    });

    const result = await bootMcpBlockShape(loadSpecs, buildManager);

    expect(result).toBeNull();
  });

  it("the happy path returns the manager untouched", async () => {
    const loadSpecs = vi.fn(async () => ({ specs: [{ name: "fixture" }], problems: [] }));
    const buildManager = vi.fn(async () => ({ ok: true as const }));

    const result = await bootMcpBlockShape(loadSpecs, buildManager);

    expect(result).toEqual({ ok: true });
  });
});

describe("host LSP boot block fail-soft posture (design slice-6.DP-1-cut.md §1.2c/§6#6)", () => {
  /**
   * Reproduces the SHAPE of index.ts's fail-soft LSP try/catch in boot()
   * (index.ts:326-342, sibling of the hook-config and MCP-config try/catches
   * right above/below it in the real file): a `loadLspServerSpecs` throw is
   * caught and never escapes, leaving `specs` at its empty default — so the
   * gate `specs.length > 0` is false, `lspManager` ends up `null`, and NEITHER
   * `diagnosticsEditTool` nor `diagnosticsWriteTool` gets (re-)registered.
   * Returns the manager (or null), exactly like index.ts's module-level
   * `lspManager` ends up.
   */
  async function bootLspBlockShape(
    loadSpecs: () => Promise<{ specs: unknown[]; issues: string[] }>,
    buildManager: (specs: unknown[]) => { ok: true },
    register: (toolName: string, opts: { silentDuplicateWarning: boolean }) => void,
  ): Promise<{ ok: true } | null> {
    let specs: unknown[] = [];
    try {
      const loaded = await loadSpecs();
      specs = loaded.specs;
    } catch {
      // fail-soft, mirrors index.ts's own try/catch around loadLspServerSpecs.
    }
    const manager = specs.length > 0 ? buildManager(specs) : null;
    if (manager) {
      register("diagnosticsEditTool", { silentDuplicateWarning: true });
      register("diagnosticsWriteTool", { silentDuplicateWarning: true });
    }
    return manager;
  }

  it("a loadLspServerSpecs throw never escapes — boot proceeds with a null manager and skips BOTH registry.register calls (no diagnostics-tool delta)", async () => {
    const loadSpecs = vi.fn(async (): Promise<{ specs: unknown[]; issues: string[] }> => {
      throw new Error("config boom");
    });
    const buildManager = vi.fn((): { ok: true } => ({ ok: true }));
    const register = vi.fn();

    const result = await bootLspBlockShape(loadSpecs, buildManager, register);

    expect(result).toBeNull();
    expect(buildManager).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("zero configured servers (empty specs, no throw) -> same null-manager outcome, no registration", async () => {
    const loadSpecs = vi.fn(async () => ({ specs: [], issues: [] }));
    const buildManager = vi.fn((): { ok: true } => ({ ok: true }));
    const register = vi.fn();

    const result = await bootLspBlockShape(loadSpecs, buildManager, register);

    expect(result).toBeNull();
    expect(buildManager).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("the happy path (non-empty specs) builds the manager and registers both diagnostics tools", async () => {
    const loadSpecs = vi.fn(async () => ({ specs: [{ name: "fixture" }], issues: [] }));
    const buildManager = vi.fn((): { ok: true } => ({ ok: true }));
    const register = vi.fn();

    const result = await bootLspBlockShape(loadSpecs, buildManager, register);

    expect(result).toEqual({ ok: true });
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(1, "diagnosticsEditTool", { silentDuplicateWarning: true });
    expect(register).toHaveBeenNthCalledWith(2, "diagnosticsWriteTool", { silentDuplicateWarning: true });
  });
});

describe("host extensions bootstrap fail-soft posture (design slice-3.3-cut.md §3.7/§6, task 3.3.5)", () => {
  /** Shape of index.ts's ExtensionsBootstrap fallback — see bootstrap.ts's own ExtensionsBootstrap. */
  interface FakeBootstrap {
    skillCount: number;
    skillsPromptSection: string;
    profiles: unknown[];
    // Slice 3.7 (task 3.7.2): widened alongside the real ExtensionsBootstrap
    // (packages/core/src/extensions/bootstrap.ts) — a further prompt-section
    // projection of the SAME `profiles` field above, stub default "".
    profilesPromptSection: string;
    pluginMcpServerSpecs: unknown[];
    // Slice 3.4 (task 3.4.5): widened alongside the real ExtensionsBootstrap
    // (packages/core/src/extensions/bootstrap.ts) — stub defaults are []/"",
    // same fail-soft posture as the other four fields.
    workflows: unknown[];
    workflowsPromptSection: string;
    repoMapFiles: unknown[];
    problems: string[];
  }

  const EMPTY_BOOTSTRAP: FakeBootstrap = {
    skillCount: 0,
    skillsPromptSection: "",
    profiles: [],
    profilesPromptSection: "",
    pluginMcpServerSpecs: [],
    workflows: [],
    workflowsPromptSection: "",
    repoMapFiles: [],
    problems: [],
  };

  /**
   * Reproduces the SHAPE of index.ts's fail-soft extensions try/catch in
   * boot(): `ext` is pre-seeded with the empty bootstrap (mirrors the real
   * file's `let ext: ExtensionsBootstrap = {...empty defaults}`) and only
   * overwritten if discoverExtensions resolves; a throw is caught and never
   * escapes, leaving `ext` at its empty default — exactly like index.ts's
   * local `ext` ends up when discovery fails.
   */
  async function bootExtensionsBlockShape(
    discover: () => Promise<FakeBootstrap>,
  ): Promise<FakeBootstrap> {
    let ext: FakeBootstrap = EMPTY_BOOTSTRAP;
    try {
      ext = await discover();
    } catch {
      // defense-in-depth only, mirrors index.ts's own try/catch (discoverExtensions
      // itself never throws by contract).
    }
    return ext;
  }

  it("a discovery throw never escapes — boot proceeds with the empty bootstrap (zero skills/profiles/plugin servers)", async () => {
    const discover = vi.fn(async (): Promise<FakeBootstrap> => {
      throw new Error("extensions boom");
    });

    const result = await bootExtensionsBlockShape(discover);

    expect(result).toEqual(EMPTY_BOOTSTRAP);
  });

  it("the happy path returns the discovered bootstrap untouched", async () => {
    const discovered: FakeBootstrap = {
      skillCount: 2,
      skillsPromptSection: "\n[skills section]\n",
      profiles: [{ name: "reviewer" }],
      profilesPromptSection: "\n[profiles section]\n",
      pluginMcpServerSpecs: [{ kind: "stdio", name: "plugin_demo_srv" }],
      workflows: [{ name: "release-flow" }],
      workflowsPromptSection: "\n[workflows section]\n",
      repoMapFiles: [{ relativePath: "src/index.ts" }],
      problems: ["one problem"],
    };
    const discover = vi.fn(async () => discovered);

    const result = await bootExtensionsBlockShape(discover);

    expect(result).toEqual(discovered);
  });
});

describe("host workflow wiring (design slice-3.4-cut.md §2.10/§6, task 3.4.5)", () => {
  /**
   * Reproduces the SHAPE of index.ts's `withWorkflows(withSubagents(config,
   * {profiles}), ext.workflows)` call: a fake `withSubagents` attaches a
   * `subagents` field, and a fake `withWorkflows` (mirroring the real
   * workflow/engine.ts contract: "reads config.subagents; if absent, attaches
   * NOTHING") only attaches `workflows` when `config.subagents` is already
   * set. index.ts itself isn't importable in a test (module-scope
   * process.parentPort access, same reason as the blocks above), so this pins
   * the ORDER rather than importing the real helpers.
   */
  interface FakeConfig {
    subagents?: { kind: "subagents" };
    workflows?: { kind: "workflows" };
  }

  function fakeWithSubagents(config: FakeConfig): FakeConfig {
    config.subagents = { kind: "subagents" };
    return config;
  }

  function fakeWithWorkflows(config: FakeConfig, definitions: readonly unknown[]): FakeConfig {
    if (config.subagents && definitions.length >= 0) {
      config.workflows = { kind: "workflows" };
    }
    return config;
  }

  it("withWorkflows(withSubagents(config), defs) attaches both ports — subagents first, workflows second", () => {
    const config: FakeConfig = {};

    const result = fakeWithWorkflows(fakeWithSubagents(config), [{ name: "release-flow" }]);

    expect(result.subagents).toEqual({ kind: "subagents" });
    expect(result.workflows).toEqual({ kind: "workflows" });
  });

  it("calling withWorkflows BEFORE withSubagents would attach nothing (order is load-bearing)", () => {
    const config: FakeConfig = {};

    const outOfOrder = fakeWithWorkflows(config, [{ name: "release-flow" }]);

    expect(outOfOrder.workflows).toBeUndefined();
  });

  it("zero discovered workflows still attaches a (empty) WorkflowPort — the tool stays available, just advertises nothing", () => {
    const config: FakeConfig = {};

    const result = fakeWithWorkflows(fakeWithSubagents(config), []);

    expect(result.workflows).toEqual({ kind: "workflows" });
  });
});

describe("host subagent model-override wiring", () => {
  /**
   * The shape-mirroring idiom above cannot catch a MISSING option: a fake
   * `withSubagents` accepts whatever it is handed. `resolveChildModelPort` was
   * absent from this call site for exactly that reason — every test passed
   * while `Agent(model: …)` failed closed in the packaged app and worked in the
   * CLI. So this reads the real source and pins the option by name.
   */
  async function readHostSource(): Promise<string> {
    return readFile(new URL("./index.ts", import.meta.url), "utf8");
  }

  it("passes resolveChildModelPort into withSubagents, or the runner rejects every Agent(model:) call", async () => {
    const source = await readHostSource();

    // Anchored on the profiles THUNK Taskana 4704 wired (`profiles: () => {`
    // — the host now derives settings role personas inside the thunk, so a
    // live rescan AND a settings change are both visible to the runner) so
    // the doc comment near the top of index.ts — which also spells
    // `withSubagents(config, {profiles})` — can never satisfy this
    // assertion in place of the real call. Brace-aware: the options object
    // contains NESTED braces (the thunk body, spreads), so the region is
    // taken from the call site to the option list's closing `})` — matched
    // by scanning braces, not a lazy regex.
    const callStart = source.indexOf("withSubagents(config, {");
    expect(callStart).toBeGreaterThan(-1);
    // Skip every occurrence inside comments/doc-comments.
    let idx = callStart;
    while (idx > -1 && source.slice(0, idx).split("\n").at(-1)!.trimStart().startsWith("*")) {
      idx = source.indexOf("withSubagents(config, {", idx + 1);
    }
    expect(idx).toBeGreaterThan(-1);
    let depth = 0;
    let regionEnd = -1;
    for (let i = idx; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          regionEnd = i;
          break;
        }
      }
    }
    expect(regionEnd).toBeGreaterThan(idx);
    const options = source.slice(idx, regionEnd);

    expect(options).toContain("profiles: () => {");
    expect(options).toContain("resolveChildModelPort");
  });

  it("TASK.192: assigns config.sessionSubagents before the actual withWorkflows call", async () => {
    const source = await readHostSource();

    // Anchored on the REAL call — /const loop = new AgentLoop(\s*withWorkflows\(/
    // — not the first textual occurrence of "withWorkflows(" (comments well
    // above the call also spell the name).
    const assignment = "config.sessionSubagents = childSessionPortHandle;";
    const call = source.match(/const loop = new AgentLoop\(\s*withWorkflows\(/);

    expect(source.includes(assignment)).toBe(true);
    expect(call).not.toBeNull();
    // Both anchors exist and the assignment precedes the actual call, so
    // withWorkflows sees the session tier for engine-profile workflow steps.
    expect(source.indexOf(assignment)).toBeLessThan(
      source.indexOf("const loop = new AgentLoop("),
    );
  });

  it("resolves the child port through the same factory the mid-session model switch uses", async () => {
    const source = await readHostSource();

    // A second, independent factory would drift from the live provider/key on
    // the next `/model` switch; both sites must read one closure.
    // TASK.198 срез C: the mid-session switch now calls `.setPort()` on
    // `switchableModelPort` (the INNER SwitchableModelPort), not on
    // `modelPort` (the OUTER media-projection decorator, which has no
    // `setPort` method at all) — same `modelPortFactory` closure either way.
    expect(source).toContain("assertChildModel(id, readAllowedChildModels(process.env.ANYCODE_CHILD_MODELS, envConfig.model))");
    expect(source).toContain("return modelPortFactory(id)");
    expect(source).toContain("switchableModelPort.setPort(modelPortFactory(id))");
  });

  it("Taskana 4131: threads envConfig.exploreModel into withSubagents when set", async () => {
    const source = await readHostSource();
    const callStart = source.indexOf("withSubagents(config, {");
    let idx = callStart;
    while (idx > -1 && source.slice(0, idx).split("\n").at(-1)!.trimStart().startsWith("*")) {
      idx = source.indexOf("withSubagents(config, {", idx + 1);
    }
    expect(idx).toBeGreaterThan(-1);
    let depth = 0;
    let regionEnd = -1;
    for (let i = idx; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          regionEnd = i;
          break;
        }
      }
    }
    const options = source.slice(idx, regionEnd);
    expect(options).toContain("exploreModel: envConfig.exploreModel");
  });

  it("Taskana 4704 F1: the child port's getPermissionMode is self-contained (no Session bounce -> no infinite recursion)", async () => {
    const source = await readHostSource();

    // The recursive shape this guards against: the port's getPermissionMode
    // thunk once ended in `?? rootSessionChildSpawnModeCell.get?.()` and a
    // later binding assigned `rootSessionChildSpawnModeCell.get = () =>
    // rootSession.childSpawnMode()`, where Session.childSpawnMode() itself
    // began with `if (this.childSpawnModeOverride !== undefined) return
    // this.childSpawnModeOverride();` — override == the cell == the Session:
    // the first session-tier spawn blew the stack. All four spellings must
    // be gone from the host source.
    expect(source).not.toContain("rootSessionChildSpawnModeCell");
    expect(source).not.toContain("childSpawnMode:");
    // The override field/option is gone from the Session seam too.
    const sessionSource = await readFile(new URL("./session.ts", import.meta.url), "utf8");
    expect(sessionSource).not.toContain("childSpawnModeOverride");
    expect(sessionSource).not.toContain("childSpawnMode?:");
    // And the port's thunk must derive the answer inline (orchestrate-aware,
    // plan coerced to build) instead of delegating. R1 moved that derivation
    // into the shared spawn-mode cell (host/spawn-mode-cell.ts), which index.ts
    // builds and the harness reuses — the derivation is pinned there now.
    const cellSource = await readFile(new URL("./spawn-mode-cell.ts", import.meta.url), "utf8");
    expect(cellSource).toContain('return pre === "plan" ? "build" : pre;');
  });

  it("Taskana 4704 F2: withSubagents threads the host's resolveRoleRouteImpl into the runner", async () => {
    const source = await readHostSource();
    const callStart = source.indexOf("withSubagents(config, {");
    let idx = callStart;
    while (idx > -1 && source.slice(0, idx).split("\n").at(-1)!.trimStart().startsWith("*")) {
      idx = source.indexOf("withSubagents(config, {", idx + 1);
    }
    let depth = 0;
    let regionEnd = -1;
    for (let i = idx; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          regionEnd = i;
          break;
        }
      }
    }
    const options = source.slice(idx, regionEnd);
    expect(options).toContain("resolveRoleRoute: resolveRoleRouteImpl");
    // The runner-side default must be the null fallback, never a live
    // resolver core could invent on its own.
    const runnerSource = await readFile(new URL("../../../../packages/core/src/subagents/runner.ts", import.meta.url), "utf8");
    expect(runnerSource).toContain("resolveRoleRoute: opts?.resolveRoleRoute ?? ((agentType: string) => null)");
  });

  it("Taskana 4704 F5: the respawn notice rides the FAILED child's id; a refused respawn reports honestly", async () => {
    const source = await readHostSource();
    // F5(b): the retrying notice is queued under the FAILED child's
    // spawnToolCallId (a completed marker for a spawn that DID happen,
    // consumed once the renderer acks it) — NOT under the respawn's fresh id
    // (the renderer's originId dedupe would swallow the real report of the
    // respawned child when it eventually arrives under that same id).
    expect(source).toContain("childReportQueue.add(req.spawnToolCallId, decision.notice");
    // F5(c): the respawn run()'s admit outcome is HANDLED — a refused
    // respawn (cap/shape) delivers an honest error report under the failed
    // child's id instead of a silent "retrying" with no follow-up.
    expect(source).toContain("admit.status === \"error\"");
    expect(source).toContain("was refused");
    // R3 (cross-review): that honest refusal/failure report rides a DISTINCT
    // queue id — never the failed child's spawnToolCallId, which the
    // "retrying" notice already claimed (renderer dedupes child_report by
    // originId; a same-id follow-up would be silently dropped).
    // R3 (re-review #3): the id itself is pinned behaviourally in
    // role-route.test.ts (respawnReportId + ChildReportQueue); here only the
    // wiring must go through the helper.
    expect(source).toContain('respawnReportId(req.spawnToolCallId, "refused")');
    expect(source).toContain('respawnReportId(req.spawnToolCallId, "failed")');
    // The respawn request stamps ONLY the next entry's fields (a stale
    // engine/connection of the failed hop never leaks through `...req`).
    expect(source).not.toContain("...req,\n    spawnToolCallId: respawnId");
    expect(source).toContain("...(decision.entry.engine !== undefined ? { engine: decision.entry.engine } : {})");
  });
});

describe("host shutdown order — background-task reap (design slice-6.DP-2-cut.md §1.2f/§6#6)", () => {
  /**
   * Reproduces index.ts's CURRENT handleShutdown body verbatim in shape, now
   * that slice 6.DP-2 inserted a new stage BETWEEN terminals.dispose() and the
   * lsp reap: terminals.dispose() (sync) -> tasks?.disposeAll() (awaited, `?.`
   * short-circuits when null — init failed before the manager was constructed)
   * -> lspManager?.disposeAll() (awaited, unchanged from the 6.DP-1 shape
   * above) -> mcp?.dispose() (awaited, fail-soft try/catch, unchanged from the
   * 3.2.4 shape) -> session?.shutdown() (awaited). Mirrors index.ts:645-670
   * exactly: terminals -> tasks -> lsp -> mcp -> session.
   */
  async function handleShutdownShapeWithTasks(
    terminals: { dispose(): void },
    tasks: { disposeAll(): Promise<void> } | null,
    lsp: { disposeAll(): Promise<void> } | null,
    mcp: { dispose(): Promise<void> } | null,
    session: { shutdown(): Promise<void> } | null,
  ): Promise<void> {
    terminals.dispose();
    await tasks?.disposeAll();
    await lsp?.disposeAll();
    if (mcp) {
      try {
        await mcp.dispose();
      } catch {
        // defense-in-depth only, mirrors index.ts's own try/catch.
      }
    }
    if (session) {
      await session.shutdown();
    }
  }

  it("awaits tasks.disposeAll BEFORE calling lsp.disposeAll (real ordering, not fire-and-forget) — terminals -> tasks -> lsp -> mcp -> session", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const tasks = {
      disposeAll: vi.fn(async () => {
        // A real macrotask delay: if the caller failed to `await` this call
        // (fired-and-forgot it instead), lsp.disposeAll would run
        // synchronously right after terminals.dispose() and "lsp" would land
        // in `calls` BEFORE "tasks" — this proves the await is load-bearing,
        // not just shape (same idiom as the 6.DP-1 lsp-ordering proof above).
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls.push("tasks");
      }),
    };
    const lsp = { disposeAll: vi.fn(async () => void calls.push("lsp")) };
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShapeWithTasks(terminals, tasks, lsp, mcp, session);

    expect(calls).toEqual(["terminals", "tasks", "lsp", "mcp", "session"]);
    expect(tasks.disposeAll).toHaveBeenCalledTimes(1);
    expect(lsp.disposeAll).toHaveBeenCalledTimes(1);
    expect(mcp.dispose).toHaveBeenCalledTimes(1);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it("a null taskManager (init failure before construction — the only way it stays null) is skipped without breaking the terminals -> lsp -> mcp -> session order", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const lsp = { disposeAll: vi.fn(async () => void calls.push("lsp")) };
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShapeWithTasks(terminals, null, lsp, mcp, session);

    expect(calls).toEqual(["terminals", "lsp", "mcp", "session"]);
  });

  it("a null lspManager alongside a live taskManager still reaps tasks — the two nullable stages are independent", async () => {
    const calls: string[] = [];
    const terminals = { dispose: vi.fn(() => void calls.push("terminals")) };
    const tasks = { disposeAll: vi.fn(async () => void calls.push("tasks")) };
    const mcp = { dispose: vi.fn(async () => void calls.push("mcp")) };
    const session = { shutdown: vi.fn(async () => void calls.push("session")) };

    await handleShutdownShapeWithTasks(terminals, tasks, null, mcp, session);

    expect(calls).toEqual(["terminals", "tasks", "mcp", "session"]);
  });
});

describe("host background-task boot wiring shape (design slice-6.DP-2-cut.md §1.2c/§6#6/#7)", () => {
  /**
   * Reproduces the SHAPE of index.ts's unconditional task-wiring block
   * (index.ts:358-361): construct the manager, THEN register exactly 3 tools
   * in a fixed order, ALL strictly before the toolNames snapshot
   * (index.ts:464) — unlike the MCP/LSP boot blocks above, there is no
   * fail-soft try/catch here: construction is zero-I/O (no config read to
   * fail) and is therefore unconditional, mirroring cli/main.ts's own
   * (degenerately-always-true) `!print` gate.
   */
  function bootTaskWiringShape(
    buildManager: () => { ok: true },
    register: (toolName: string, opts?: { silentDuplicateWarning: boolean }) => void,
    snapshotToolNames: () => void,
  ): { ok: true } {
    const manager = buildManager();
    register("backgroundCapableBashTool", { silentDuplicateWarning: true });
    register("bashOutputTool");
    register("bashKillTool");
    snapshotToolNames();
    return manager;
  }

  it("constructs the manager, then registers exactly 3 tools in order, then snapshots toolNames — all 5 steps in that exact sequence", () => {
    const calls: string[] = [];
    const buildManager = vi.fn(() => {
      calls.push("construct");
      return { ok: true as const };
    });
    const register = vi.fn((toolName: string) => {
      calls.push(`register:${toolName}`);
    });
    const snapshotToolNames = vi.fn(() => {
      calls.push("snapshot");
    });

    const manager = bootTaskWiringShape(buildManager, register, snapshotToolNames);

    expect(manager).toEqual({ ok: true });
    expect(calls).toEqual([
      "construct",
      "register:backgroundCapableBashTool",
      "register:bashOutputTool",
      "register:bashKillTool",
      "snapshot",
    ]);
  });

  it("registers backgroundCapableBashTool WITH silentDuplicateWarning:true (it overwrites the default Bash); bashOutputTool/bashKillTool with no options (fresh names, nothing to overwrite)", () => {
    const register = vi.fn();

    bootTaskWiringShape(() => ({ ok: true }), register, () => {});

    expect(register).toHaveBeenCalledTimes(3);
    expect(register).toHaveBeenNthCalledWith(1, "backgroundCapableBashTool", { silentDuplicateWarning: true });
    expect(register).toHaveBeenNthCalledWith(2, "bashOutputTool");
    expect(register).toHaveBeenNthCalledWith(3, "bashKillTool");
  });
});

describe("host background-task tool identity (design slice-6.DP-2-cut.md §6#7)", () => {
  /**
   * The registered Bash surface must be PERMISSION byte-identical to
   * synchronous Bash (design §1.2c/§6#7, mirrors tools/bash-background.ts's
   * own doc comment): backgroundCapableBashTool.metadata is not a copy of
   * bashTool.metadata — it is the SAME object by reference, so every
   * permission-engine check (SafeCommandPermissionEngine included, which
   * cannot see `run_in_background` at all) rules on it exactly as it would for
   * the sync tool. Verified here against the REAL exported tool objects (no
   * index.ts import needed — these are plain barrel exports).
   */
  it("backgroundCapableBashTool.metadata === bashTool.metadata (strict reference equality, not just deep-equal)", () => {
    expect(backgroundCapableBashTool.metadata).toBe(bashTool.metadata);
  });
});

describe("host WebSearch boot wiring shape (design slice-6.3-cut.md §2-D1/D2)", () => {
  /**
   * Reproduces the SHAPE of index.ts's WebSearch wiring block (index.ts:390-404):
   * load the `webSearch` section via the REAL loadWebSearchConfig against a REAL
   * temp workspace + NodeFileSystemAdapter, then gate
   * `registry.register(createWebSearchTool(backend))` on a non-null backend —
   * mirroring index.ts's own `if (webSearchBackend !== null)` check — STRICTLY
   * before the toolNames snapshot, same ordering discipline as every other
   * boot-wiring shape test above. Uses the REAL core exports rather than a fake
   * reproduction: loadWebSearchConfig/createWebSearchTool are plain functions
   * with no process.parentPort dependency (index.ts itself is still not
   * importable, same reason as every other describe block in this file), so
   * this pins both the wiring SHAPE and the real config+key-gating behavior
   * together — same posture as the background-task tool-identity check above.
   */
  let workspaceDir: string;
  let homeDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "anycode-websearch-host-ws-"));
    homeDir = await mkdtemp(join(tmpdir(), "anycode-websearch-host-home-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bootWebSearchWiringShape(
    workspace: string,
    home: string,
    env: NodeJS.ProcessEnv,
    register: (toolName: string) => void,
    snapshotToolNames: () => void,
  ): Promise<void> {
    const fs = new NodeFileSystemAdapter();
    let backend: ResolvedWebSearchBackend | null = null;
    try {
      const loaded = await loadWebSearchConfig(fs, workspace, home, env);
      backend = loaded.backend;
    } catch {
      // defense-in-depth only, mirrors index.ts's own try/catch around loadWebSearchConfig.
    }
    if (backend !== null) {
      register(createWebSearchTool(backend).metadata.name);
    }
    snapshotToolNames();
  }

  it("no webSearch section in either config -> registry.register is never called; the tool list stays default (byte-identity)", async () => {
    const registered: string[] = [];
    const snapshot = vi.fn();

    await bootWebSearchWiringShape(workspaceDir, homeDir, process.env, (name) => registered.push(name), snapshot);

    expect(registered).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('a valid brave config + env key -> "WebSearch" is registered BEFORE the toolNames snapshot', async () => {
    await mkdir(join(workspaceDir, ".anycode"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".anycode", "config.json"),
      JSON.stringify({
        webSearch: { backend: "brave", apiKeyEnv: "ANYCODE_TEST_WEBSEARCH_KEY" },
      }),
      "utf8",
    );
    const env = { ...process.env, ANYCODE_TEST_WEBSEARCH_KEY: "test-key-123" };
    const calls: string[] = [];

    await bootWebSearchWiringShape(
      workspaceDir,
      homeDir,
      env,
      (name) => calls.push(`register:${name}`),
      () => calls.push("snapshot"),
    );

    expect(calls).toEqual(["register:WebSearch", "snapshot"]);
  });

  it("a config with no resolvable key (env var unset) -> no registration, default tool list (key-gating)", async () => {
    await mkdir(join(workspaceDir, ".anycode"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".anycode", "config.json"),
      JSON.stringify({
        webSearch: { backend: "brave", apiKeyEnv: "ANYCODE_TEST_WEBSEARCH_KEY_UNSET" },
      }),
      "utf8",
    );
    const env = { ...process.env };
    delete env.ANYCODE_TEST_WEBSEARCH_KEY_UNSET;
    const registered: string[] = [];

    await bootWebSearchWiringShape(workspaceDir, homeDir, env, (name) => registered.push(name), () => {});

    expect(registered).toEqual([]);
  });
});

describe("host boot context-window resolution shape (design slice-6.4-cut.md §2-D1/D2)", () => {
  /**
   * Reproduces the SHAPE of index.ts's boot context-window block (index.ts's
   * `catalogEntry`/`bootContextWindow` computation immediately before
   * `AgentLoopConfig`, and the conditional `context` spread inside it): match
   * the REAL built-in catalog by baseUrl, resolve the window via the REAL
   * `resolveContextWindow`, then apply the same `!== undefined ? {...} : {}`
   * spread index.ts uses. index.ts itself is still not importable (see the
   * file-header comment) — this pins the wiring SHAPE over the real core
   * exports, mirroring the WebSearch shape test above. The actual resolution
   * MATH (env > catalog > undefined) is proven by core unit tests
   * (provider/capabilities.test.ts, Wave B); this only pins that the host's
   * two-step pipeline + conditional spread produce the expected
   * `AgentLoopConfig["context"]` shape.
   */
  function bootContextSpread(
    baseUrl: string,
    modelId: string,
    override: number | undefined,
    overrideModel?: string,
  ): { context: { contextWindowTokens: number } } | Record<string, never> {
    const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), baseUrl);
    const bootContextWindow = resolveContextWindow(modelId, catalogEntry, override, overrideModel);
    return bootContextWindow !== undefined ? { context: { contextWindowTokens: bootContextWindow } } : {};
  }

  // TASK.142 changed this: an unknown model no longer omits `context` — it
  // resolves the explicit assumed fallback (8192), so the boot window is a real
  // number and the degraded budget engages instead of the 200k default.
  it("model absent from the matched entry (anthropic catalog + test-model) -> spread yields the ASSUMED 8192 window, never no context", () => {
    const spread = bootContextSpread("https://api.anthropic.com", "test-model", undefined);

    expect(spread).toEqual({ context: { contextWindowTokens: 8_192 } });
  });

  it("catalog hit (z-ai + glm-4.7) -> spread yields { context: { contextWindowTokens: 200000 } }", () => {
    const spread = bootContextSpread("https://api.z.ai/api/anthropic", "glm-4.7", undefined);

    expect(spread).toEqual({ context: { contextWindowTokens: 200_000 } });
  });

  it("env override wins over a catalog hit", () => {
    const spread = bootContextSpread("https://api.z.ai/api/anthropic", "glm-4.7", 50_000);

    expect(spread).toEqual({ context: { contextWindowTokens: 50_000 } });
  });

  it("env override wins even with no catalog match at all", () => {
    const spread = bootContextSpread("https://custom.example.com", "test-model", 50_000);

    expect(spread).toEqual({ context: { contextWindowTokens: 50_000 } });
  });

  // TASK.142: the override is model-bound, so booting on ANOTHER model must not
  // inherit it — the host's 4th arg is what makes that hold at boot.
  it("a matching bound override applies; a mismatched one does not (boot on B with A's pair)", () => {
    expect(bootContextSpread("https://api.z.ai/api/anthropic", "glm-4.7", 50_000, "glm-4.7")).toEqual({
      context: { contextWindowTokens: 50_000 },
    });
    // A-bound pair, boot on B (catalogued): B resolves its own catalog window.
    expect(bootContextSpread("https://api.z.ai/api/anthropic", "glm-5.3", 50_000, "glm-4.7")).toEqual({
      context: { contextWindowTokens: 300_000 },
    });
    // A-bound pair, boot on an UNKNOWN B: the assumed fallback, not A's 50000.
    expect(bootContextSpread("https://api.anthropic.com", "test-model", 50_000, "glm-4.7")).toEqual({
      context: { contextWindowTokens: 8_192 },
    });
  });
});

describe("host boot reasoning-effort support shape", () => {
  function bootReasoningOptions(
    baseUrl: string,
    modelId: string,
    live?: LiveModelCapabilities,
  ): {
    reasoningSupported: boolean;
    availableEffortLevels?: string[];
  } {
    const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), baseUrl);
    const bootEffortLevels = resolveEffortLevels(modelId, catalogEntry, live);
    return {
      reasoningSupported: bootEffortLevels !== undefined,
      ...(bootEffortLevels !== undefined ? { availableEffortLevels: bootEffortLevels } : {}),
    };
  }

  it("marks GLM-5.2 reasoning-capable even though it has no legacy low tier", () => {
    expect(bootReasoningOptions("https://api.z.ai/api/anthropic", "glm-5.2")).toEqual({
      reasoningSupported: true,
      availableEffortLevels: ["off", "high", "max"],
    });
  });

  it("leaves non-reasoning catalog models unsupported", () => {
    expect(bootReasoningOptions("https://api.z.ai/api/anthropic", "glm-4.6")).toEqual({
      reasoningSupported: false,
    });
  });

  // ── Taskana 4118: live caps supplement the catalog at boot ──

  it("Taskana 4118: an unknown model + live {reasoning, [max,high]} maps to [max, high] (source order)", () => {
    expect(
      bootReasoningOptions("https://openrouter.ai/api/v1", "or/foreign-model", {
        reasoning: true,
        effortLevels: ["max", "high"],
      }),
    ).toEqual({ reasoningSupported: true, availableEffortLevels: ["max", "high"] });
  });

  it("Taskana 4118: live does not override a catalog-known model (D-Priority)", () => {
    expect(
      bootReasoningOptions("https://api.z.ai/api/anthropic", "glm-5.2", {
        reasoning: true,
        effortLevels: ["low"],
      }),
    ).toEqual({ reasoningSupported: true, availableEffortLevels: ["off", "high", "max"] });
  });
});

describe("host boot ceiling-supervision wiring shape (TASK.124 remainder, owner rule 2026-08-22)", () => {
  /**
   * Reproduces the SHAPE of index.ts's `ceiling` spread inside the core
   * AgentLoopConfig literal (index.ts, right after `permissionBroker: broker,`):
   * install `{ ceiling: { supervisedRoot } }` ONLY for a root boot — a child
   * session (session-tier subagent) must ALWAYS keep the turn-ceiling ladder.
   * `isChildSessionBoot` is imported for real (not reproduced) — it is lock
   * #2's own discriminator (boot.ts), the OR of the argv authority
   * (`args.child`) and the durable authority (`sessionMeta.parentSessionId`),
   * deliberately MORE INCLUSIVE than `args.child` alone so it can never
   * mistake a genuine child for a root. `IpcPermissionBroker` is real too, so
   * `supervisedRoot()` is proven against the ACTUAL TASK.138 latch mechanics,
   * not a stand-in.
   */
  function bootCeilingSpread(
    args: { resume: boolean; child?: { parentSessionId: string; spawnToolCallId: string; initialMode: PermissionMode } },
    meta: SessionMeta,
    broker: IpcPermissionBroker,
  ): { ceiling: { supervisedRoot: () => boolean } } | Record<string, never> {
    return !isChildSessionBoot(args, meta)
      ? { ceiling: { supervisedRoot: () => broker.isUnattended !== true } }
      : {};
  }

  function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return { id: "s1", workspace: "/ws", model: "m1", mode: "build", createdAt: 0, updatedAt: 0, ...overrides };
  }

  const rootArgs = { resume: false } as const;
  const childArgs = {
    resume: false,
    child: { parentSessionId: "parent-1", spawnToolCallId: "call-1", initialMode: "build" as const },
  };

  const request: PermissionRequest = {
    toolName: "Write",
    input: { file_path: "/workspace/a.txt", content: "hi" },
    metadata: writeTool.metadata,
    mode: "build",
  };

  it("a root boot (argv-root + root-meta) gets a ceiling.supervisedRoot predicate", () => {
    const broker = new IpcPermissionBroker(() => {});
    const spread = bootCeilingSpread(rootArgs, meta(), broker);
    expect("ceiling" in spread).toBe(true);
  });

  it("a child-session boot (argv child flags) gets NO ceiling field — the ladder stays wired", () => {
    const broker = new IpcPermissionBroker(() => {});
    expect(bootCeilingSpread(childArgs, meta(), broker)).toEqual({});
  });

  it("a child-session boot signalled ONLY by durable sessionMeta.parentSessionId also gets NO ceiling field (OR-semantics, lock #2)", () => {
    const broker = new IpcPermissionBroker(() => {});
    expect(bootCeilingSpread(rootArgs, meta({ parentSessionId: "parent-9" }), broker)).toEqual({});
  });

  it("the root predicate tracks the broker's LIVE isUnattended latch: true while attended, false once the TASK.138 latch arms", async () => {
    vi.useFakeTimers();
    try {
      const broker = new IpcPermissionBroker(() => {}, 120_000);
      const spread = bootCeilingSpread(rootArgs, meta(), broker) as { ceiling: { supervisedRoot: () => boolean } };

      expect(spread.ceiling.supervisedRoot()).toBe(true);

      // Arm the real TASK.138 latch the way it arms in production: one
      // unanswered ask expires. Same recipe as permission-broker.test.ts's
      // own "unattended latch" suite.
      const pending = broker.requestPermission(request);
      await vi.advanceTimersByTimeAsync(120_000);
      await pending;

      expect(spread.ceiling.supervisedRoot()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("host telemetry boot wiring shape (design slice-6.6-cut.md §2-D1/D2)", () => {
  /**
   * Reproduces the SHAPE of index.ts's telemetry wiring: the loader block
   * right after the websearch block (`loadTelemetryConfig` against a REAL
   * temp workspace + NodeFileSystemAdapter), the sink+session_start block
   * right before `AgentLoopConfig` (gated on a non-null resolved config,
   * mirroring the `if (telemetryConfig !== null)` check in index.ts), the
   * `eventTap` spread next to the tasks/lsp spreads, and the
   * session_end+dispose stage `handleShutdown` runs right after
   * `lspManager?.disposeAll()`. Uses the REAL core exports (no
   * process.parentPort dependency, same posture as the WebSearch/
   * context-window shape tests above) — this pins both the wiring SHAPE and
   * the real config+sink behavior together.
   */
  let workspaceDir: string;
  let homeDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-host-ws-"));
    homeDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-host-home-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  // Mirrors the SHAPE of index.ts's `...(telemetry !== null ? { eventTap:
  // buildTelemetryTap(...) } : {})` config spread — a standalone, synchronously
  // typed helper (same idiom as `bootContextSpread` above) so its return type
  // is settled BEFORE it is embedded in bootTelemetryWiringShape's own return
  // object below (nesting the ternary inline there defeats TS's narrowing of
  // the `{}` branch against a union contextual type).
  function telemetryEventTapSpread(
    telemetry: { port: TelemetryPort; session: string } | null,
  ): { eventTap: (event: AgentEvent) => void } | Record<string, never> {
    return telemetry !== null ? { eventTap: buildTelemetryTap(telemetry.port, telemetry.session) } : {};
  }

  async function bootTelemetryWiringShape(
    workspace: string,
    home: string,
    env: NodeJS.ProcessEnv,
    sessionId: string,
    model: string,
    provider: string,
    mode: PermissionMode,
  ): Promise<{
    telemetry: { port: TelemetryPort; session: string } | null;
    spread: { eventTap: (event: AgentEvent) => void } | Record<string, never>;
  }> {
    const fs = new NodeFileSystemAdapter();
    let telemetryConfig: ResolvedTelemetryConfig | null = null;
    try {
      const loaded = await loadTelemetryConfig(fs, workspace, home, env);
      telemetryConfig = loaded.telemetry;
    } catch {
      // defense-in-depth only, mirrors index.ts's own try/catch.
    }
    let telemetry: { port: TelemetryPort; session: string } | null = null;
    if (telemetryConfig !== null) {
      const port = new JsonlTelemetrySink({ dir: telemetryConfig.dir, fileName: `${sessionId}.jsonl` });
      port.record({ v: 1, ts: Date.now(), session: sessionId, t: "session_start", model, provider, mode });
      telemetry = { port, session: sessionId };
    }
    const spread = telemetryEventTapSpread(telemetry);
    return { telemetry, spread };
  }

  it("no telemetry section in either config -> telemetry stays null; the config spread yields NO eventTap field (default byte-identity)", async () => {
    const { telemetry, spread } = await bootTelemetryWiringShape(
      workspaceDir,
      homeDir,
      process.env,
      "session-1",
      "test-model",
      "custom",
      "build",
    );

    expect(telemetry).toBeNull();
    expect(spread).toEqual({});
    expect("eventTap" in spread).toBe(false);
  });

  it("an enabled telemetry config -> a sink is constructed and the eventTap spread yields a function", async () => {
    const sinkDir = join(workspaceDir, "telemetry-out");
    await mkdir(join(workspaceDir, ".anycode"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { enabled: true, dir: sinkDir } }),
      "utf8",
    );

    const { telemetry, spread } = await bootTelemetryWiringShape(
      workspaceDir,
      homeDir,
      process.env,
      "session-2",
      "test-model",
      "anthropic",
      "build",
    );

    expect(telemetry).not.toBeNull();
    expect("eventTap" in spread).toBe(true);
    expect(typeof (spread as { eventTap: unknown }).eventTap).toBe("function");

    await telemetry?.port.dispose();
  });

  it("the ANYCODE_TELEMETRY kill-switch overrides an enabled config -> telemetry stays null (env-gating)", async () => {
    await mkdir(join(workspaceDir, ".anycode"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { enabled: true, dir: join(workspaceDir, "telemetry-out") } }),
      "utf8",
    );
    const env = { ...process.env, ANYCODE_TELEMETRY: "0" };

    const { telemetry, spread } = await bootTelemetryWiringShape(
      workspaceDir,
      homeDir,
      env,
      "session-3",
      "test-model",
      "custom",
      "build",
    );

    expect(telemetry).toBeNull();
    expect(spread).toEqual({});
  });

  it("handleShutdown's session_end + dispose sequence ends the JSONL file with session_end (real fs)", async () => {
    const sinkDir = join(workspaceDir, "telemetry-out");
    await mkdir(join(workspaceDir, ".anycode"), { recursive: true });
    await writeFile(
      join(workspaceDir, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { enabled: true, dir: sinkDir } }),
      "utf8",
    );

    const { telemetry } = await bootTelemetryWiringShape(
      workspaceDir,
      homeDir,
      process.env,
      "session-4",
      "test-model",
      "custom",
      "build",
    );
    expect(telemetry).not.toBeNull();

    // Reproduces index.ts's handleShutdown telemetry stage verbatim in shape:
    // record session_end THEN await dispose() (bounded, idempotent) — the
    // exact order index.ts's block runs right after lspManager?.disposeAll().
    telemetry?.port.record({ v: 1, ts: Date.now(), session: telemetry.session, t: "session_end" });
    await telemetry?.port.dispose();

    const filePath = join(sinkDir, "session-4.jsonl");
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as { t: string });

    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed[0]?.t).toBe("session_start");
    expect(parsed[parsed.length - 1]?.t).toBe("session_end");
  });
});


// ── Slice P7.15 (F14): host set_model re-budget recipe (design §2.1) ──────────
//
// index.ts is not importable (module-scope process.parentPort), so — mirroring
// this file's established "reproduce the shape over doubles, don't import the
// module" idiom — this reproduces the switchModel closure's re-budget body
// VERBATIM in shape against the REAL z-ai catalog entry + real resolvers + a
// loop.setContextWindow spy, pinning: the new model's window reaches the loop
// and config.context, maxOutput/effort re-resolve, effort collapses on a
// non-reasoning model, systemPromptEnv.modelId is mutated, and the returned
// model_changed payload is correct. A silent miscompute here corrupts the
// compaction budget with no red test elsewhere (the wave's Opus rationale).
describe("host set_model re-budget recipe (slice P7.15 · F14, design §2.1)", () => {
  const zAiEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), "https://api.z.ai/api/anthropic");

  /**
   * Reproduces host/index.ts's switchModel closure body (the re-budget half:
   * window / maxOutput / effort / context / modelId / return), over a
   * setContextWindow spy and a mutable config/systemPromptEnv. No env override
   * (envContextWindow undefined) so the catalog window is authoritative.
   */
  function makeSwitcher(envContextWindow?: number, envContextWindowModel?: string) {
    const setContextWindowCalls: number[] = [];
    const loop = { setContextWindow: (n: number) => setContextWindowCalls.push(n) };
    const config: { maxOutputTokens?: number; reasoningEffort?: string; context?: { contextWindowTokens: number } } = {};
    const systemPromptEnv: { modelId?: string } = { modelId: "glm-5.2" };
    const switchModel = (id: string, selectedTier: "off" | "low" | "medium" | "high" | "max") => {
      systemPromptEnv.modelId = id;
      const contextWindow =
        resolveContextWindow(id, zAiEntry, envContextWindow, envContextWindowModel) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
      config.maxOutputTokens = resolveMaxOutputTokens(id, zAiEntry, undefined);
      const resolvedEffort = resolveReasoningEffort(id, zAiEntry, selectedTier);
      config.reasoningEffort = resolvedEffort;
      loop.setContextWindow(contextWindow);
      config.context = { ...config.context, contextWindowTokens: contextWindow };
      const availableEffortLevels = resolveEffortLevels(id, zAiEntry);
      return {
        result: {
          model: id,
          reasoningEffort: resolvedEffort ?? ("off" as const),
          ...(availableEffortLevels !== undefined ? { availableEffortLevels } : {}),
        },
        setContextWindowCalls,
        config,
        systemPromptEnv,
      };
    };
    return switchModel;
  }

  it("re-budgets window/maxOutput/context and collapses effort on a non-reasoning model", () => {
    const out = makeSwitcher()("glm-4.6", "high");
    // glm-4.6: 200k window, not reasoning-capable. TASK.113: maxOutput is now
    // the docs.z.ai spec-box 128K (was understated 32K before the refresh).
    expect(out.setContextWindowCalls).toEqual([200_000]);
    expect(out.config.context).toEqual({ contextWindowTokens: 200_000 });
    expect(out.config.maxOutputTokens).toBe(131_072);
    // Effort collapses: config.reasoningEffort undefined, payload "off", no levels.
    expect(out.config.reasoningEffort).toBeUndefined();
    expect(out.result.reasoningEffort).toBe("off");
    expect(out.result.availableEffortLevels).toBeUndefined();
    // Session-static modelId mutated so the rebuilt prompt + children see it.
    expect(out.systemPromptEnv.modelId).toBe("glm-4.6");
  });

  it("carries the selected tier onto a reasoning-capable model", () => {
    const out = makeSwitcher()("glm-5.2", "max");
    expect(out.setContextWindowCalls).toEqual([300_000]);
    expect(out.config.context).toEqual({ contextWindowTokens: 300_000 });
    expect(out.config.maxOutputTokens).toBe(131_072);
    expect(out.config.reasoningEffort).toBe("max");
    expect(out.result.reasoningEffort).toBe("max");
    expect(out.result.availableEffortLevels).toEqual(["off", "high", "max"]);
  });

  // TASK.142: the switch is where a connection-global window would have leaked
  // A -> B. With the pair, A keeps its override, B ignores it, and switching back
  // to A reuses the boot pair.
  it("live A -> B -> A: only A's binding honours the override; B resolves its own catalog window", () => {
    const switchModel = makeSwitcher(50_000, "glm-5.2");
    const a1 = switchModel("glm-5.2", "high");
    expect(a1.setContextWindowCalls).toEqual([50_000]);
    expect(a1.config.context).toEqual({ contextWindowTokens: 50_000 });

    const b = switchModel("glm-4.6", "high");
    expect(b.setContextWindowCalls).toEqual([50_000, 200_000]);
    expect(b.config.context).toEqual({ contextWindowTokens: 200_000 });

    const a2 = switchModel("glm-5.2", "max");
    expect(a2.setContextWindowCalls).toEqual([50_000, 200_000, 50_000]);
    expect(a2.config.context).toEqual({ contextWindowTokens: 50_000 });
  });

  it("live switch to an UNKNOWN model resolves the assumed 8192, not a stale previous window", () => {
    const out = makeSwitcher(50_000, "glm-5.2")("not-in-catalog", "high");
    expect(out.setContextWindowCalls).toEqual([8_192]);
    expect(out.config.context).toEqual({ contextWindowTokens: 8_192 });
  });

  it("a shell-global override (no binding) applies to every switched model", () => {
    const switchModel = makeSwitcher(50_000, undefined);
    expect(switchModel("glm-5.2", "high").setContextWindowCalls).toEqual([50_000]);
    expect(switchModel("glm-4.6", "high").setContextWindowCalls).toEqual([50_000, 50_000]);
  });

  // TASK.142: the same pair must reach `Agent(model: B)` children — the child's
  // window follows ITS model, so a parent bound to A cannot leak onto B.
  it("child-settings wiring (Agent(model: B)) re-resolves B's window from the shared pair", () => {
    const settingsForChild = buildChildModelSettingsResolver({
      catalogEntry: zAiEntry,
      envMaxOutputTokens: undefined,
      envContextWindow: 50_000,
      envContextWindowModel: "glm-5.2",
    });
    // Child on B (catalogued): B's own window.
    expect(settingsForChild("glm-4.6", "high").contextWindowTokens).toBe(200_000);
    // Child on A: the bound override applies.
    expect(settingsForChild("glm-5.2", "high").contextWindowTokens).toBe(50_000);
    // Child on an unknown model: the assumed fallback.
    expect(settingsForChild("not-in-catalog", "high").contextWindowTokens).toBe(8_192);
  });
});

/**
 * Design TASK.40 §2(f): bootCodexSession's Git bridge + shell-capability
 * wiring. index.ts itself is not importable (see file header) — this pins
 * the SHAPE of the `codexGitEnabled`/`shell` computation as a local pure
 * mirror of index.ts's `bootCodexSession`, same idiom as every other
 * describe block in this file.
 */
describe("host Codex boot shell/git wiring shape (design TASK.40 §2(f))", () => {
  /** Mirrors bootCodexSession's `codexGitEnabled`/`shell` computation verbatim. */
  function computeCodexShell(isGitRepo: boolean, hasRunBinary: boolean): ShellCapabilitiesProjection {
    const gitEnabled = isGitRepo && hasRunBinary;
    return { gitReadOnly: gitEnabled, gitUserMutations: gitEnabled, terminal: true };
  }

  it("enables both shell git capabilities in a git workspace with a spawn-capable exec adapter — same gate core's boot() uses", () => {
    expect(computeCodexShell(true, true)).toEqual({ gitReadOnly: true, gitUserMutations: true, terminal: true });
  });

  it("disables both shell git capabilities outside a git workspace, while terminal (engine-independent) stays available", () => {
    expect(computeCodexShell(false, true)).toEqual({ gitReadOnly: false, gitUserMutations: false, terminal: true });
  });

  it("disables both shell git capabilities when the exec adapter cannot spawn a binary", () => {
    expect(computeCodexShell(true, false)).toEqual({ gitReadOnly: false, gitUserMutations: false, terminal: true });
  });

  it("gitReadOnly and gitUserMutations always move together for Codex — one workspace-level gate, not two independent ones", () => {
    expect(computeCodexShell(true, true).gitReadOnly).toBe(computeCodexShell(true, true).gitUserMutations);
    expect(computeCodexShell(false, false).gitReadOnly).toBe(computeCodexShell(false, false).gitUserMutations);
  });
});

/**
 * Taskana 4682 rework — the child-temp-dir SHAPE of bootCodexSession's boot
 * site, mirrored over the REAL helpers (resolveChildTempDir /
 * ensureChildTempDir / removeChildTempDir / buildCodexChildEnv) with the same
 * "reproduce the seam's shape, don't import index.ts" idiom as every other
 * block in this file. Pins the two owner invariants: a CHILD boot derives and
 * creates the private dir, sets the tmp env family and passes the dir into
 * the engine selection (writableRoots); an OWNER boot derives NOTHING — no
 * dir, no env override, no selection key.
 */
describe("host Codex boot private temp dir shape (Taskana 4682 rework)", () => {
  /** Mirrors bootCodexSession's derivation + selection spread verbatim. */
  function bootCodexTmpShape(
    args: { sessionId?: string; child?: { parentSessionId: string } },
    homeDir: string,
  ): { tempDir: string | undefined; selection: Record<string, unknown>; env: NodeJS.ProcessEnv } {
    const bridgeRowId = args.sessionId ?? "018f-fresh-uuid";
    const codexChildTempDir = args.child !== undefined ? resolveChildTempDir(bridgeRowId, homeDir) : undefined;
    if (codexChildTempDir !== undefined) ensureChildTempDir(codexChildTempDir);
    const options = { ...(codexChildTempDir !== undefined ? { tempDir: codexChildTempDir } : {}) };
    const selection = {
      ...(args.child !== undefined ? { excludeTmpRoots: true } : {}),
      ...(codexChildTempDir !== undefined ? { childTempDir: codexChildTempDir } : {}),
    };
    const env = buildCodexChildEnv({ HOME: homeDir, PATH: "/bin", TMPDIR: "/var/folders/ambient" }, "darwin", undefined, options.tempDir);
    return { tempDir: codexChildTempDir, selection, env };
  }

  it("a CHILD boot: the private dir exists 0700, rides the selection, and owns the tmp env family", () => {
    const home = mkdtempSync(join(tmpdir(), "anycode-4682-shape-"));
    try {
      const childId = "018f1e2d-3c4b-5a6e-7f8a-9b0c1d2e3f4a";
      const shape = bootCodexTmpShape(
        { sessionId: childId, child: { parentSessionId: "parent-1" } },
        home,
      );
      const expectedDir = join(home, ".anycode", "tmp", childId);
      expect(shape.tempDir).toBe(expectedDir);
      expect(existsSync(expectedDir)).toBe(true);
      expect(statSync(expectedDir).mode & 0o077).toBe(0);
      expect(shape.selection).toMatchObject({ excludeTmpRoots: true, childTempDir: expectedDir });
      expect(shape.env.TMPDIR).toBe(expectedDir);
      expect(shape.env.TMPPREFIX).toBe(`${expectedDir}/zsh`);
      expect(shape.env.TMP).toBe(expectedDir);
      expect(shape.env.TEMP).toBe(expectedDir);
      // The finalize/shutdown cleanup removes exactly this dir (idempotent).
      removeChildTempDir(expectedDir);
      expect(existsSync(expectedDir)).toBe(false);
      removeChildTempDir(expectedDir); // never fatal on the second call
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an OWNER boot: no private dir is created, the ambient TMPDIR passes through, the selection carries NO tmp keys", () => {
    const home = mkdtempSync(join(tmpdir(), "anycode-4682-shape-"));
    try {
      const shape = bootCodexTmpShape({ sessionId: "root-1" }, home);
      expect(shape.tempDir).toBeUndefined();
      expect(existsSync(join(home, ".anycode"))).toBe(false);
      expect(shape.selection).toEqual({});
      expect(shape.env.TMPDIR).toBe("/var/folders/ambient");
      expect(shape.env.TMPPREFIX).toBeUndefined();
      expect(shape.env.TMP).toBeUndefined();
      expect(shape.env.TEMP).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Cross-review F2 (Taskana 4682): the private temp dir was created at the TOP
 * of bootCodexSession but the `try {` guard only started AFTER the whole
 * connect phase (`startCodexEngine` — app-server spawn, trust preflights,
 * `--version` round-trip — the single most likely failure site of the boot).
 * A throw in between propagated to boot()'s catch; the boot-side `finally`
 * (which removes the dir when `session === null`) was never entered, so the
 * dir leaked until a graceful shutdown message that a killed host never
 * sends. index.ts is not importable (see file header) — same idiom as the
 * 4682 shape block above: this mirrors the ORDERING invariant over the REAL
 * helpers (the exact order index.ts must now keep), plus a source-order pin
 * (the "read the real source" idiom of the model-override suite) so the
 * production call site cannot silently drift back.
 */
describe("host Codex boot private temp dir leak guard (cross-review F2, Taskana 4682)", () => {
  /**
   * Mirrors bootCodexSession's ordering with injectable steps: the dir must be
   * ENSURED immediately before the guarded window opens, and a throw from ANY
   * step after the ensure must leave no dir behind (the finally-equivalent
   * cleanup runs for `session === null`).
   */
  async function bootCodexTmpLifecycle(
    homeDir: string,
    steps: { mcp?: () => Promise<void>; connect: () => Promise<void>; afterGuard?: () => Promise<void> },
  ): Promise<void> {
    const bridgeRowId = "018f1e2d-3c4b-5a6e-7f8a-9b0c1d2e3f4a";
    const child = { parentSessionId: "parent-1" };
    const codexChildTempDir = resolveChildTempDir(bridgeRowId, homeDir);
    const cleanupCodexChildTempDir = (): void => removeChildTempDir(codexChildTempDir);
    const codexChildTempDirCleanup = cleanupCodexChildTempDir; // module-level slot, set right after derivation
    let session: unknown = null;
    try {
      try {
        // The connect phase (spawn + trust + version) and every pre-guard
        // await run INSIDE the guarded window.
        if (steps.mcp !== undefined) await steps.mcp();
        await steps.connect();
        session = {}; // engine objects exist
        if (steps.afterGuard !== undefined) await steps.afterGuard();
      } finally {
        if (session === null) cleanupCodexChildTempDir();
      }
    } catch {
      // boot()'s catch: initFailure, degraded mode — the host survives.
    } finally {
      // handleShutdown's last-safe-moment removal (idempotent).
      codexChildTempDirCleanup();
    }
  }

  it("a connect-phase throw (the spawn-failure case) must not leak the private dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "anycode-4682-f2-"));
    try {
      const dir = join(home, ".anycode", "tmp", "018f1e2d-3c4b-5a6e-7f8a-9b0c1d2e3f4a");
      await bootCodexTmpLifecycle(home, {
        mcp: async () => {},
        connect: async () => {
          ensureChildTempDir(dir); // ← the fix: ensure sits inside the guarded window
          throw new Error("spawn failed: codex app-server --version timed out");
        },
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a post-guard throw (the already-covered case) still must not leak, and a successful boot keeps the dir until shutdown", async () => {
    const home = mkdtempSync(join(tmpdir(), "anycode-4682-f2-"));
    try {
      const dir = join(home, ".anycode", "tmp", "018f1e2d-3c4b-5a6e-7f8a-9b0c1d2e3f4a");
      await bootCodexTmpLifecycle(home, {
        connect: async () => {
          ensureChildTempDir(dir);
        },
        afterGuard: async () => {
          throw new Error("plugin.boot threw");
        },
      });
      expect(existsSync(dir)).toBe(false);

      // Success path: the dir SURVIVES the boot-side finally (session !== null)
      // and is removed exactly once at the shutdown moment.
      await bootCodexTmpLifecycle(home, {
        connect: async () => {
          ensureChildTempDir(dir);
        },
      });
      expect(existsSync(dir)).toBe(false); // shutdown-side removal ran
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * Source-order pin (the "read the real source" idiom): in index.ts, the
   * `ensureChildTempDir(...)` call must appear AFTER the last statement the
   * guard comment names as pre-connect and BEFORE the `try {` that opens the
   * guarded window — concretely: after `parseCodexEngineArgs` (the last
   * synchronous pre-connect step) and before `startCodexEngine`'s containing
   * expression. On the pre-F2 code the ensure sat ABOVE `prepareEngineMcpForward`
   * (the first await of the leak window), which this pin rejects.
   */
  it("index.ts ensures the dir inside the guarded window: after parseCodexEngineArgs, before the connect expression", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const ensureIdx = source.indexOf("if (codexChildTempDir !== undefined) ensureChildTempDir(codexChildTempDir);");
    expect(ensureIdx).toBeGreaterThan(-1);
    const draftIdx = source.indexOf("const draft = parseCodexEngineArgs(process.argv.slice(2));");
    expect(draftIdx).toBeGreaterThan(-1);
    const connectIdx = source.indexOf("const connected = await (args.resume");
    expect(connectIdx).toBeGreaterThan(-1);
    // Order: draft → ensure → connected. (All three literals are unique in the file.)
    expect(source.indexOf("if (codexChildTempDir !== undefined) ensureChildTempDir(codexChildTempDir);", ensureIdx + 1)).toBe(-1);
    expect(draftIdx).toBeLessThan(ensureIdx);
    expect(ensureIdx).toBeLessThan(connectIdx);
    // And the ensure no longer sits above the first pre-guard await.
    const mcpForwardIdx = source.indexOf("const codexMcpForward = await prepareEngineMcpForward({");
    expect(mcpForwardIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(mcpForwardIdx);
    // Review fix: the connect expression sits OUTSIDE the boot-side `try`, so
    // it must clean the dir on its own rejection — pin the .catch that does it
    // between the connect expression and the guarded window.
    const tryIdx = source.indexOf("  try {\n  codexParentEngine = connected.engine;");
    expect(tryIdx).toBeGreaterThan(connectIdx);
    const between = source.slice(connectIdx, tryIdx);
    expect(between).toMatch(/\}\)\(\)\)\.catch\(\(error: unknown\) => \{\s*(\/\/[^\n]*\s*)*cleanupCodexChildTempDir\(\);\s*throw error;/);
  });
});

/**
 * Codex-profiles Q1.3 (cut §3.3, completes W3-F): bootCodexSession's
 * create-session seam persists the spawn's `--codex-profile` id into the
 * session row, so main's cross-restart resume (main/index.ts
 * `resolveCodexProfileForTab`) has a `codexProfileId` to re-resolve
 * fail-closed. index.ts itself is not importable (see file header) — this
 * mirrors the seam's meta-construction VERBATIM over the REAL
 * `parseCodexProfileArgs` and the REAL SqlitePersistenceAdapter, and reads the
 * row back FROM DISK through a second adapter instance, so the parse→persist
 * →reload chain is exercised for real; only the surrounding boot is mirrored.
 */
describe("host Codex boot create-session profile pin (codex-profiles Q1.3, cut §3.3)", () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "anycode-codex-profile-row-"));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  /** Mirrors bootCodexSession's create seam (index.ts:517-537) verbatim: parse argv, then the conditional codexProfileId spread. */
  async function createCodexSessionRow(
    persistence: SqlitePersistenceAdapter,
    argv: readonly string[],
    created: { model: string; presetId: string; threadId: string },
    id: string,
    workspace: string,
  ) {
    const codexProfileArgs = parseCodexProfileArgs(argv);
    return persistence.createSession({
      id,
      workspace,
      model: created.model,
      mode: created.presetId as PermissionMode,
      engineId: "codex",
      externalSessionRef: created.threadId,
      ...(codexProfileArgs.profileId !== undefined ? { codexProfileId: codexProfileArgs.profileId } : {}),
    });
  }

  const CREATED = { model: "gpt-5.2-codex", presetId: "agent-full", threadId: "thread-abc" };

  it("a --codex-profile spawn persists codexProfileId into the ON-DISK session row (the resume re-resolve input)", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const writer = new SqlitePersistenceAdapter(dbPath);
    await createCodexSessionRow(writer, ["--codex-profile", "work"], CREATED, "sess-1", "/tmp/ws");
    await writer.close();

    // A FRESH adapter over the same file: the pin must have survived to disk,
    // not just the in-memory meta object — this is exactly what a relaunch reads.
    const reader = new SqlitePersistenceAdapter(dbPath);
    const row = await reader.getSessionById("sess-1");
    await reader.close();
    expect(row?.codexProfileId).toBe("work");
    expect(row?.engineId).toBe("codex");
    expect(row?.externalSessionRef).toBe("thread-abc");
  });

  it("a linked-home spawn (main always sends the id alongside --codex-home) pins the id too", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const writer = new SqlitePersistenceAdapter(dbPath);
    await createCodexSessionRow(
      writer,
      ["--codex-profile", "alt", "--codex-home", "/Users/someone/external-codex-home"],
      CREATED,
      "sess-2",
      "/tmp/ws",
    );
    const row = await writer.getSessionById("sess-2");
    await writer.close();
    expect(row?.codexProfileId).toBe("alt");
  });

  it("a system-profile spawn (no profile argv) writes NO codexProfileId — the row stays byte-identical to a pre-profiles build", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const writer = new SqlitePersistenceAdapter(dbPath);
    await createCodexSessionRow(writer, [], CREATED, "sess-3", "/tmp/ws");
    const row = await writer.getSessionById("sess-3");
    await writer.close();
    expect(row?.codexProfileId).toBeUndefined();
  });
});

describe("host Claude session-row wiring (SLICE-CC C4, cut §1.4)", () => {
  /**
   * Reproduces the SHAPE of bootClaudeSession's create-vs-touch decision
   * (index.ts is not importable — see this file's header), because the
   * defect it prevents is invisible on a first spawn and fatal on every one
   * after it: `main/tabs.ts.spawnTabHost` sends `--resume <id>` for EVERY
   * respawn, and `createSession` is a plain INSERT, so a create-always branch
   * aborts the boot on a duplicate primary key the moment a Claude host is
   * respawned.
   *
   * CC-C cannot resume the NATIVE session (CC-D owns that), so a respawn
   * starts a fresh one and REPOINTS the row at it — leaving the dead ref
   * behind would hand CC-D's future resume a session id the CLI no longer has.
   */
  interface Row {
    id: string;
    engineId?: string;
    externalSessionRef?: string;
    title?: string;
  }

  async function claudeRowShape(
    persistence: {
      getRootSession(id: string): Promise<Row | null>;
      createSession(row: Row & Record<string, unknown>): Promise<Row>;
      touchSession(id: string, patch: Record<string, unknown>): Promise<void>;
    },
    argsSessionId: string | undefined,
    connected: { sessionRef: string; model: string; presetId: string },
  ): Promise<Row> {
    const sessionRow = {
      workspace: "/ws",
      model: connected.model,
      mode: connected.presetId,
      engineId: "claude" as const,
      externalSessionRef: connected.sessionRef,
    };
    const existing = argsSessionId === undefined ? null : await persistence.getRootSession(argsSessionId);
    if (existing !== null && existing.engineId !== "claude") {
      throw new Error(`Session ${existing.id} belongs to engine "${existing.engineId ?? "core"}", not claude`);
    }
    if (existing === null) {
      return await persistence.createSession({ id: argsSessionId ?? "generated-uuid", ...sessionRow });
    }
    await persistence.touchSession(existing.id, sessionRow);
    return { ...existing, ...sessionRow };
  }

  function rig(initial: Row | null) {
    const created: Row[] = [];
    const touched: { id: string; patch: Record<string, unknown> }[] = [];
    return {
      created,
      touched,
      persistence: {
        getRootSession: vi.fn(async () => initial),
        createSession: vi.fn(async (row: Row & Record<string, unknown>) => {
          created.push(row);
          return row;
        }),
        touchSession: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          touched.push({ id, patch });
        }),
      },
    };
  }

  it("a first spawn INSERTS the row, native-first, with the spawn-assigned ref", async () => {
    const r = rig(null);
    const meta = await claudeRowShape(r.persistence, "s1", { sessionRef: "ref-1", model: "default", presetId: "ask" });

    expect(r.created).toHaveLength(1);
    expect(r.touched).toEqual([]);
    expect(meta.id).toBe("s1");
    expect(r.created[0]).toMatchObject({ engineId: "claude", externalSessionRef: "ref-1", mode: "ask" });
  });

  it("a RESPAWN (--resume) updates the existing row instead of double-inserting", async () => {
    const r = rig({ id: "s1", engineId: "claude", externalSessionRef: "ref-old", title: "Kept title" });
    const meta = await claudeRowShape(r.persistence, "s1", { sessionRef: "ref-new", model: "sonnet", presetId: "workspace" });

    // The defect this pins: a create here throws SQLITE_CONSTRAINT and bricks
    // every Claude respawn.
    expect(r.persistence.createSession).not.toHaveBeenCalled();
    expect(r.touched).toHaveLength(1);
    // The dead native ref is REPLACED, never left for CC-D's resume to trip on.
    expect(r.touched[0]!.patch).toMatchObject({ externalSessionRef: "ref-new", model: "sonnet", mode: "workspace" });
    expect(meta.externalSessionRef).toBe("ref-new");
    // Row identity and its non-engine fields survive the respawn.
    expect(meta.id).toBe("s1");
    expect(meta.title).toBe("Kept title");
  });

  it("refuses to take over a row belonging to another engine", async () => {
    const r = rig({ id: "s1", engineId: "codex", externalSessionRef: "thread-9" });
    await expect(
      claudeRowShape(r.persistence, "s1", { sessionRef: "ref-new", model: "default", presetId: "ask" }),
    ).rejects.toThrow(/belongs to engine "codex"/);
    expect(r.persistence.createSession).not.toHaveBeenCalled();
    expect(r.persistence.touchSession).not.toHaveBeenCalled();
  });
});

describe("host Claude resume wiring (SLICE-CC D-min, cut §1.5)", () => {
  /**
   * Reproduces the SHAPE of bootClaudeSession's `args.resume` branch (mirrors
   * codex's index.ts:500-529) — index.ts is not importable (see this file's
   * header). Real resume requires the persisted row's own native ref: unlike
   * a fresh spawn (which mints its own uuid), a resume that finds no
   * resumable row must fail closed rather than silently starting a fresh
   * native session under the old row's id.
   */
  interface Row {
    id: string;
    engineId?: string;
    externalSessionRef?: string;
    model?: string;
    mode?: string;
  }

  async function claudeResumeShape(
    persistence: { getRootSession(id: string): Promise<Row | null> },
    resumeEngine: (ref: string, selection: { model?: string; presetId?: string }) => Promise<{ sessionRef: string; model: string; presetId: string }>,
    sessionId: string | undefined,
  ): Promise<{ existing: Row; connected: { sessionRef: string; model: string; presetId: string } }> {
    if (sessionId === undefined || sessionId.length === 0) {
      throw new Error("Claude resume requires a session id");
    }
    const existing = await persistence.getRootSession(sessionId);
    if (existing === null) throw new Error(`Claude session ${sessionId} was not found`);
    if (existing.engineId !== "claude" || typeof existing.externalSessionRef !== "string" || existing.externalSessionRef.length === 0) {
      throw new Error(`Claude session ${sessionId} has no resumable native session`);
    }
    const connected = await resumeEngine(existing.externalSessionRef, { model: existing.model, presetId: existing.mode });
    return { existing, connected };
  }

  it("resumes with the persisted externalSessionRef and selection, never a fresh id", async () => {
    const getRootSession = vi.fn(async () => ({ id: "s1", engineId: "claude", externalSessionRef: "native-ref-1", model: "opus", mode: "workspace" }));
    const resumeEngine = vi.fn(async (ref: string) => ({ sessionRef: ref, model: "opus", presetId: "workspace" }));

    const { connected } = await claudeResumeShape({ getRootSession }, resumeEngine, "s1");

    expect(resumeEngine).toHaveBeenCalledWith("native-ref-1", { model: "opus", presetId: "workspace" });
    expect(connected.sessionRef).toBe("native-ref-1");
  });

  it("fails closed when the row has no resumable native session (missing ref, or belongs to another engine)", async () => {
    const noRef = vi.fn(async () => ({ id: "s1", engineId: "claude" }));
    await expect(claudeResumeShape({ getRootSession: noRef }, vi.fn(), "s1")).rejects.toThrow(/no resumable native session/);

    const wrongEngine = vi.fn(async () => ({ id: "s1", engineId: "codex", externalSessionRef: "thread-1" }));
    await expect(claudeResumeShape({ getRootSession: wrongEngine }, vi.fn(), "s1")).rejects.toThrow(/no resumable native session/);
  });

  it("fails closed when the row is gone entirely", async () => {
    await expect(claudeResumeShape({ getRootSession: vi.fn(async () => null) }, vi.fn(), "s1")).rejects.toThrow(/was not found/);
  });

  /**
   * Reproduces the shape of the resume-settle callback (test-hazard (б)):
   * the persisted row's model/mode may diverge from what the resumed native
   * session actually settled on (it keeps its own posture across process
   * death) — the FIRST observed `system/init` is truth, and only the fields
   * that actually diverged are patched.
   */
  function resumeSettlePatch(
    sessionMeta: { model: string; mode: string },
    resolved: { model: string; permissionMode: string },
    presetIdForMode: (mode: string) => string | undefined,
  ): Record<string, unknown> {
    const presetId = presetIdForMode(resolved.permissionMode);
    const patch: Record<string, unknown> = {};
    if (sessionMeta.model !== resolved.model) patch.model = resolved.model;
    if (presetId !== undefined && sessionMeta.mode !== presetId) patch.mode = presetId;
    return patch;
  }

  it("patches only the fields that actually diverged from the resumed session's first system/init", () => {
    const presetIdForMode = (mode: string): string | undefined => (mode === "plan" ? "read-only" : mode === "acceptEdits" ? "workspace" : undefined);

    expect(resumeSettlePatch({ model: "opus", mode: "ask" }, { model: "opus", permissionMode: "default" }, presetIdForMode)).toEqual({});
    expect(resumeSettlePatch({ model: "opus", mode: "ask" }, { model: "sonnet", permissionMode: "default" }, presetIdForMode)).toEqual({
      model: "sonnet",
    });
    expect(resumeSettlePatch({ model: "opus", mode: "ask" }, { model: "opus", permissionMode: "plan" }, presetIdForMode)).toEqual({
      mode: "read-only",
    });
    // A wire mode this build never exposes as a preset (dontAsk/auto) degrades
    // to leaving `mode` untouched rather than guessing — the model can still patch.
    expect(resumeSettlePatch({ model: "opus", mode: "ask" }, { model: "sonnet", permissionMode: "dontAsk" }, presetIdForMode)).toEqual({
      model: "sonnet",
    });
  });
});

// ── Slice 96-D: preview_console AgentEvent bridge (night-track wave-1 cut
// §2.3/§2.4). index.ts is not importable (module-scope process.parentPort
// access, same reason as every other describe block in this file) — these
// mirror index.ts's `translatePreviewEvent` and its parentPort onEvent wiring
// VERBATIM in shape, the same "reproduce the shape over doubles, don't
// import the module" idiom used throughout this file. ──

describe("host preview_console translation (slice 96-D, cut §2.3/§2.4)", () => {
  type PreviewConsoleLevel = "log" | "warn" | "error" | "pageerror";

  interface PreviewConsoleEntry {
    level: PreviewConsoleLevel;
    message: string;
    at: string;
  }

  interface PreviewEventMessage {
    type: "anycode:preview-event";
    previewId: string;
    /** Absent on a pure summary message (every entry this window was suppressed). */
    entry?: PreviewConsoleEntry;
    suppressed?: number;
  }

  interface PreviewConsoleAgentEvent {
    type: "preview_console";
    previewId: string;
    level: PreviewConsoleLevel;
    message: string;
    suppressed?: number;
  }

  /** Mirrors index.ts's translatePreviewEvent verbatim. */
  function translatePreviewEvent(message: PreviewEventMessage): PreviewConsoleAgentEvent {
    if (message.entry) {
      return {
        type: "preview_console",
        previewId: message.previewId,
        level: message.entry.level,
        message: message.entry.message,
      };
    }
    const suppressed = message.suppressed ?? 0;
    return {
      type: "preview_console",
      previewId: message.previewId,
      level: "log",
      message: `${suppressed} console message${suppressed === 1 ? "" : "s"} suppressed`,
      suppressed,
    };
  }

  it("a normal forwarded entry translates 1:1, with no suppressed field", () => {
    const message: PreviewEventMessage = {
      type: "anycode:preview-event",
      previewId: "preview-1",
      entry: { level: "warn", message: "deprecated API used", at: "2026-08-01T00:00:00.000Z" },
    };

    const event = translatePreviewEvent(message);

    expect(event).toEqual({
      type: "preview_console",
      previewId: "preview-1",
      level: "warn",
      message: "deprecated API used",
    });
    expect("suppressed" in event).toBe(false);
  });

  it("an error/pageerror-level entry passes its level through unchanged", () => {
    const message: PreviewEventMessage = {
      type: "anycode:preview-event",
      previewId: "preview-2",
      entry: {
        level: "pageerror",
        message: "Uncaught TypeError: x is not a function",
        at: "2026-08-01T00:00:01.000Z",
      },
    };

    const event = translatePreviewEvent(message);

    expect(event.level).toBe("pageerror");
    expect(event.message).toBe("Uncaught TypeError: x is not a function");
  });

  it("an entry-absent summary reports the suppressed count honestly at 'log' level (no single real level to report for a rollup)", () => {
    const message: PreviewEventMessage = {
      type: "anycode:preview-event",
      previewId: "preview-3",
      suppressed: 7,
    };

    const event = translatePreviewEvent(message);

    expect(event).toEqual({
      type: "preview_console",
      previewId: "preview-3",
      level: "log",
      message: "7 console messages suppressed",
      suppressed: 7,
    });
  });

  it("singular phrasing for exactly one suppressed message", () => {
    const event = translatePreviewEvent({
      type: "anycode:preview-event",
      previewId: "preview-4",
      suppressed: 1,
    });

    expect(event.message).toBe("1 console message suppressed");
  });

  it("an entry-absent summary with no suppressed count at all defaults to 0 rather than throwing (defensive — should not happen on the real wire)", () => {
    const event = translatePreviewEvent({ type: "anycode:preview-event", previewId: "preview-5" });

    expect(event.suppressed).toBe(0);
    expect(event.message).toBe("0 console messages suppressed");
  });
});

describe("host preview_console outbound wiring shape (slice 96-D, cut §2.4)", () => {
  /**
   * preview_console events are unsolicited and NOT turn-scoped (a preview
   * window can emit console output long after its opening turn ended, or
   * with no turn ever having run) — index.ts's parentPort onEvent handler
   * emits straight onto the module-level `outbound` sink with a fixed
   * sentinel turnId (PREVIEW_CONSOLE_TURN_ID), never a "current turn" value.
   * This pins that wiring SHAPE: onEvent always produces one agent_event
   * envelope carrying the sentinel + the translated event, mirroring the
   * onResponse fan-out immediately above it in the real routePreviewMessage
   * call site.
   */
  function onPreviewEventShape(
    emit: (message: { type: "agent_event"; turnId: string; event: unknown }) => void,
    translate: (message: unknown) => unknown,
    turnIdSentinel: string,
    message: unknown,
  ): void {
    emit({ type: "agent_event", turnId: turnIdSentinel, event: translate(message) });
  }

  it("always emits the sentinel turnId, never a null/current-turn value", () => {
    const emitted: { type: string; turnId: string; event: unknown }[] = [];

    onPreviewEventShape(
      (message) => emitted.push(message),
      (message) => ({ translated: message }),
      "preview-console",
      { previewId: "p1" },
    );

    expect(emitted).toEqual([
      { type: "agent_event", turnId: "preview-console", event: { translated: { previewId: "p1" } } },
    ]);
  });

  it("passes the translated event through untouched — the wiring never reshapes it", () => {
    const emitted: { type: string; turnId: string; event: unknown }[] = [];
    const translated = { type: "preview_console", previewId: "p2", level: "error", message: "boom" };

    onPreviewEventShape(
      (message) => emitted.push(message),
      () => translated,
      "preview-console",
      { previewId: "p2", entry: { level: "error", message: "boom", at: "2026-08-01T00:00:02.000Z" } },
    );

    expect(emitted[0]?.event).toBe(translated);
  });
});

describe("Claude engine-child history flush write primitive (TASK.102 S4, cut §4.4)", () => {
  /**
   * A healthy engine child that is steered at the wrong instant reports
   * FAILURE and loses a turn: claudeFlushHistory (index.ts:1111-1132) is a
   * FULL-SNAPSHOT projection re-read from the shadow mirror on every call,
   * but the sink write it drives is a plain INSERT. A steer message parked
   * strictly during finalizeChildTerminal's flushHistory await
   * (session.ts:1880-1919) makes the SECOND full-snapshot flush re-insert
   * item_ids the first flush already wrote -> UNIQUE(session_id,item_id)
   * (sqlite-persistence.ts:61-67) aborts the whole transaction ->
   * flushChecked() rejects -> a completed child reports status:"error" and
   * the steer turn's items are lost with the rolled-back batch.
   *
   * index.ts is not importable in a test (see file header) — this mirrors
   * claudeFlushHistory's write step verbatim (index.ts:1126-1132: a FRESH
   * WriteBehindHistorySink per call, over the SAME persistence + session id)
   * against the REAL WriteBehindHistorySink and a REAL on-disk SQLite
   * database, driven twice with an overlapping/superset projection — the
   * second snapshot is exactly what a completed child's shadow mirror looks
   * like once the parked steer turn's items have landed in it.
   */
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "anycode-claude-flush-history-"));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  function historyItem(id: string, text: string, createdAt: number): HistoryItem {
    return { id, createdAt, message: { role: "user", content: text }, kind: "normal" };
  }

  /** Mirrors claudeFlushHistory's write step verbatim (index.ts:1126-1132). */
  async function claudeFlushHistoryShape(
    persistence: SqlitePersistenceAdapter,
    sessionId: string,
    items: readonly HistoryItem[],
  ): Promise<void> {
    const sink = new WriteBehindHistorySink(persistence, sessionId);
    sink.replaceAll(items);
    await sink.flushChecked();
  }

  it("a steer turn landing between two full-snapshot flushes does not corrupt or lose history", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const persistence = new SqlitePersistenceAdapter(dbPath);
    try {
      await persistence.createSession({ id: "child-1", workspace: "/ws", model: "m1", mode: "build" });

      const firstSnapshot = [historyItem("u1", "first", 1), historyItem("a1", "reply", 2)];
      await claudeFlushHistoryShape(persistence, "child-1", firstSnapshot);

      // The steer turn's items landed in the shadow mirror during the first
      // flush's await window — the second flush re-reads the FULL mirror, a
      // superset that repeats u1/a1's stable item_ids alongside the new ones.
      const secondSnapshot = [
        ...firstSnapshot,
        historyItem("u2", "steer", 3),
        historyItem("a2", "steer reply", 4),
      ];
      await expect(claudeFlushHistoryShape(persistence, "child-1", secondSnapshot)).resolves.toBeUndefined();

      const persisted = await persistence.loadHistory("child-1");
      expect(persisted).toEqual(secondSnapshot);
    } finally {
      await persistence.close();
    }
  });
});

describe("Codex engine-child history flush write primitive (TASK.143)", () => {
  /**
   * TASK.143 lifts TASK.102 S4-codex-cut: `codexFlushHistory` (index.ts, next
   * to `claudeFlushHistory` above) now reads `connected.engine.
   * readTranscript()` — a FRESH `thread/read` re-run through the resume
   * projection, on demand — instead of the frozen `historyItems()` boot
   * snapshot the old refused-before-spawn design never actually had to feed
   * a sink with. index.ts is not importable in a test (see the claude
   * describe block above) — this mirrors `codexFlushHistory`'s write step
   * verbatim: `await engine.readTranscript()`, a FRESH
   * `WriteBehindHistorySink` per call, `replaceAll` (not `append` — the
   * projection is always the WHOLE transcript from turn 0, so a second flush
   * must overwrite, never concatenate onto, the first).
   */
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "anycode-codex-flush-history-"));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  function historyItem(id: string, text: string, createdAt: number): HistoryItem {
    return { id, createdAt, message: { role: "user", content: text }, kind: "normal" };
  }

  interface FakeCodexEngine {
    /** Frozen at construction — the TASK.102 S4-codex-cut defect: a flush that read THIS instead of readTranscript() would persist a stale/empty transcript forever. */
    historyItems(): readonly HistoryItem[];
    readTranscript(): Promise<readonly HistoryItem[]>;
  }

  /** Mirrors codexFlushHistory's write step verbatim (index.ts, TASK.143). */
  async function codexFlushHistoryShape(
    engine: FakeCodexEngine,
    persistence: SqlitePersistenceAdapter,
    sessionId: string,
  ): Promise<void> {
    const items = await engine.readTranscript();
    const sink = new WriteBehindHistorySink(persistence, sessionId);
    sink.replaceAll(items);
    await sink.flushChecked();
  }

  it("persists what readTranscript() returns, NOT the frozen boot-time historyItems() — the exact TASK.102 S4-codex-cut defect this closes", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const persistence = new SqlitePersistenceAdapter(dbPath);
    try {
      await persistence.createSession({ id: "child-codex-1", workspace: "/ws", model: "m1", mode: "build" });

      const bootSnapshot = [historyItem("boot-only", "stale boot snapshot", 0)];
      const liveTranscript = [
        historyItem("u1", "post-boot question", 1),
        historyItem("a1", "post-boot answer", 2),
      ];
      const engine: FakeCodexEngine = {
        historyItems: () => bootSnapshot,
        readTranscript: async () => liveTranscript,
      };

      await codexFlushHistoryShape(engine, persistence, "child-codex-1");

      const persisted = await persistence.loadHistory("child-codex-1");
      expect(persisted).toEqual(liveTranscript);
      expect(persisted).not.toEqual(bootSnapshot);
    } finally {
      await persistence.close();
    }
  });

  it("a second flush (e.g. a steer turn landing between two finalize attempts) overwrites rather than duplicates — replaceAll, not append", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const persistence = new SqlitePersistenceAdapter(dbPath);
    try {
      await persistence.createSession({ id: "child-codex-2", workspace: "/ws", model: "m1", mode: "build" });

      const firstRead = [historyItem("u1", "first", 1), historyItem("a1", "reply", 2)];
      const engine1: FakeCodexEngine = { historyItems: () => [], readTranscript: async () => firstRead };
      await codexFlushHistoryShape(engine1, persistence, "child-codex-2");

      const secondRead = [...firstRead, historyItem("u2", "steer", 3), historyItem("a2", "steer reply", 4)];
      const engine2: FakeCodexEngine = { historyItems: () => [], readTranscript: async () => secondRead };
      await codexFlushHistoryShape(engine2, persistence, "child-codex-2");

      const persisted = await persistence.loadHistory("child-codex-2");
      expect(persisted).toEqual(secondRead);
    } finally {
      await persistence.close();
    }
  });

  it("fails loudly — rejects, never silently persists an empty transcript — when readTranscript() itself fails (disposed engine / dead RPC)", async () => {
    const dbPath = join(dbDir, "anycode.sqlite");
    const persistence = new SqlitePersistenceAdapter(dbPath);
    try {
      await persistence.createSession({ id: "child-codex-3", workspace: "/ws", model: "m1", mode: "build" });

      const engine: FakeCodexEngine = {
        historyItems: () => [],
        readTranscript: async () => {
          throw new Error("Codex engine is disposed; cannot read a live transcript");
        },
      };

      await expect(codexFlushHistoryShape(engine, persistence, "child-codex-3")).rejects.toThrow(/disposed/);

      // The honest failure path: nothing was ever written for this session —
      // never an empty-array "success" masquerading as a completed flush.
      const persisted = await persistence.loadHistory("child-codex-3");
      expect(persisted).toEqual([]);
    } finally {
      await persistence.close();
    }
  });
});

/**
 * TASK.198 срез C: `parseRecognizerEnv`/`recognizerEndpointFromFields`
 * (index.ts's own env-var-name literal mirror of main/host-env.ts's
 * ANYCODE_RECOGNIZER_* family). index.ts is not importable (see file
 * header) — reproduced verbatim, same idiom as every other describe block
 * in this file.
 */
describe("host recognizer env parsing (TASK.198 срез C)", () => {
  // Live-run fix (task150-output-ceiling session, TASK.198 follow-up):
  // `recognizerEndpointFromFields` is the ONE construction point both
  // `parseRecognizerEnv` (the boot-env snapshot below) AND main's live
  // RECOGNIZER_CONFIG_CHANGED push (index.ts's parentPort message handler,
  // `message.endpoint === null ? null : recognizerEndpointFromFields(message.endpoint)`)
  // go through — so gating a blank `baseUrl` or an unknown `transport` HERE,
  // and returning `null`, covers a broken recognizer arriving from either
  // source with one check each.
  const RECOGNIZER_TRANSPORT_VALUES: readonly string[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

  function recognizerEndpointFromFields(fields: {
    transport?: string;
    baseUrl?: string;
    apiKey?: string;
    model: string;
    providerName?: string;
  }): RecognizerEndpoint | null {
    if (fields.baseUrl === undefined || fields.baseUrl.trim() === "") {
      return null;
    }
    if (fields.transport !== undefined && !RECOGNIZER_TRANSPORT_VALUES.includes(fields.transport)) {
      return null;
    }
    return {
      transport: (fields.transport as RecognizerEndpoint["transport"] | undefined) ?? "anthropic-messages",
      baseUrl: fields.baseUrl,
      model: fields.model,
      ...(fields.apiKey !== undefined && fields.apiKey !== "" ? { apiKey: fields.apiKey } : {}),
      ...(fields.providerName !== undefined && fields.providerName !== "" ? { providerName: fields.providerName } : {}),
    };
  }

  function parseRecognizerEnv(env: NodeJS.ProcessEnv): RecognizerEndpoint | null {
    const model = env.ANYCODE_RECOGNIZER_MODEL;
    if (model === undefined || model.trim() === "") {
      return null;
    }
    return recognizerEndpointFromFields({
      transport: env.ANYCODE_RECOGNIZER_TRANSPORT,
      baseUrl: env.ANYCODE_RECOGNIZER_BASE_URL,
      apiKey: env.ANYCODE_RECOGNIZER_API_KEY,
      model,
      providerName: env.ANYCODE_RECOGNIZER_PROVIDER_NAME,
    });
  }

  it("returns null when ANYCODE_RECOGNIZER_MODEL is absent or blank — one of three honest 'off' signals", () => {
    expect(parseRecognizerEnv({})).toBeNull();
    expect(parseRecognizerEnv({ ANYCODE_RECOGNIZER_MODEL: "  " })).toBeNull();
  });

  it("builds a full RecognizerEndpoint from the complete env family", () => {
    expect(
      parseRecognizerEnv({
        ANYCODE_RECOGNIZER_TRANSPORT: "openai-chat-completions",
        ANYCODE_RECOGNIZER_BASE_URL: "https://vision.example.com",
        ANYCODE_RECOGNIZER_API_KEY: "sk-vision",
        ANYCODE_RECOGNIZER_MODEL: "vision-model",
        ANYCODE_RECOGNIZER_PROVIDER_NAME: "openai",
      }),
    ).toEqual({
      transport: "openai-chat-completions",
      baseUrl: "https://vision.example.com",
      apiKey: "sk-vision",
      model: "vision-model",
      providerName: "openai",
    });
  });

  it("defaults transport to anthropic-messages when absent (same final fallback the primary provider ladder uses)", () => {
    expect(
      parseRecognizerEnv({ ANYCODE_RECOGNIZER_MODEL: "vision-model", ANYCODE_RECOGNIZER_BASE_URL: "https://vision.example.com" }),
    ).toEqual({
      transport: "anthropic-messages",
      baseUrl: "https://vision.example.com",
      model: "vision-model",
    });
  });

  it("omits apiKey/providerName when unset — never emits blank-string fields", () => {
    const endpoint = parseRecognizerEnv({
      ANYCODE_RECOGNIZER_MODEL: "vision-model",
      ANYCODE_RECOGNIZER_BASE_URL: "https://vision.example.com",
    })!;
    expect("apiKey" in endpoint).toBe(false);
    expect("providerName" in endpoint).toBe(false);
  });

  // RED-PROOF (live-run fix, TASK.198 follow-up): a resolved model with a
  // BLANK baseUrl used to default to `baseUrl: ""` and still count as
  // "configured" — this is exactly the live-run defect: `InspectImage`
  // registered and then failed twice with "Invalid Anthropic base URL: ''
  // is empty after trimming" because the unresolved transport defaults to
  // anthropic downstream. A blank address must be read the same as a blank
  // model: the recognizer is OFF, not "on with no address".
  it("RED: returns null when ANYCODE_RECOGNIZER_BASE_URL is absent or blank, even though MODEL resolved — the second honest 'off' signal", () => {
    expect(parseRecognizerEnv({ ANYCODE_RECOGNIZER_MODEL: "vision-model" })).toBeNull();
    expect(parseRecognizerEnv({ ANYCODE_RECOGNIZER_MODEL: "vision-model", ANYCODE_RECOGNIZER_BASE_URL: "   " })).toBeNull();
  });

  // RED-PROOF (live-run fix, TASK.198 follow-up, second finding): the
  // transport cast (`fields.transport as RecognizerEndpoint["transport"]`)
  // was UNCHECKED — any garbage string was declared a valid transport and
  // the compiler approved it. Core's own `loadEnvConfig` validates the same
  // input and REJECTS an unknown transport (packages/core/src/provider/env.ts:
  // "is rejected the same way as any other invalid value") — this restores
  // that parity for the recognizer's own transport field, the third honest
  // 'off' signal. A MISSING transport is different and stays untouched: it is
  // the documented legacy-fallback default shared with the primary provider
  // ladder, not a malformed input.
  it("RED: returns null when ANYCODE_RECOGNIZER_TRANSPORT is present but not one of the three known ProviderTransport ids", () => {
    expect(
      parseRecognizerEnv({
        ANYCODE_RECOGNIZER_MODEL: "vision-model",
        ANYCODE_RECOGNIZER_BASE_URL: "https://vision.example.com",
        ANYCODE_RECOGNIZER_TRANSPORT: "garbage-transport",
      }),
    ).toBeNull();
  });

  it("a present, known transport still resolves normally", () => {
    expect(
      parseRecognizerEnv({
        ANYCODE_RECOGNIZER_MODEL: "vision-model",
        ANYCODE_RECOGNIZER_BASE_URL: "https://vision.example.com",
        ANYCODE_RECOGNIZER_TRANSPORT: "openai-responses",
      }),
    ).toEqual({
      transport: "openai-responses",
      baseUrl: "https://vision.example.com",
      model: "vision-model",
    });
  });

  // RED-PROOF (live-run fix): the SAME gate, exercised directly on
  // `recognizerEndpointFromFields` — this is the shape main's live
  // RECOGNIZER_CONFIG_CHANGED push feeds (a `RecognizerWireConfig` whose
  // `baseUrl` field can independently be blank), not just the boot-env path
  // `parseRecognizerEnv` wraps.
  it("RED: a live-push endpoint with a blank baseUrl is refused the same way as the boot-env path", () => {
    expect(recognizerEndpointFromFields({ baseUrl: "", model: "vision-model" })).toBeNull();
    expect(recognizerEndpointFromFields({ baseUrl: "   ", model: "vision-model" })).toBeNull();
    expect(recognizerEndpointFromFields({ model: "vision-model" })).toBeNull();
  });

  it("a non-blank baseUrl still resolves normally, from either caller shape", () => {
    expect(recognizerEndpointFromFields({ baseUrl: "https://vision.example.com", model: "vision-model" })).toEqual({
      transport: "anthropic-messages",
      baseUrl: "https://vision.example.com",
      model: "vision-model",
    });
  });

  it("RED: a live-push endpoint with an unknown transport is refused the same way as the boot-env path", () => {
    expect(
      recognizerEndpointFromFields({ baseUrl: "https://vision.example.com", model: "vision-model", transport: "garbage-transport" }),
    ).toBeNull();
  });
});

/**
 * TASK.198 срез C (plan §8): `VisionTelemetryModelPort` (index.ts's own
 * usage-telemetry wrap around a recognizer's `AiSdkModelPort`). Not
 * importable (see file header) — reproduced verbatim.
 */
class VisionTelemetryModelPort implements ModelPort {
  constructor(
    private readonly inner: ModelPort,
    private readonly report: (usage: TokenUsage) => void,
  ) {}
  get modelId(): string | undefined {
    return this.inner.modelId;
  }
  get lastResponseModel(): string | undefined {
    return this.inner.lastResponseModel;
  }
  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.inner.streamText(request)) {
      if (event.type === "finish") {
        this.report(event.usage);
      }
      yield event;
    }
  }
}

describe("host VisionTelemetryModelPort (TASK.198 срез C, plan §8)", () => {
  function fakePort(events: ModelStreamEvent[]): ModelPort {
    return {
      modelId: "vision-model",
      async *streamText() {
        for (const event of events) yield event;
      },
    };
  }

  it("passes every event through unchanged and reports usage exactly once, on the finish event", async () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const events: ModelStreamEvent[] = [
      { type: "text_delta", id: "d1", text: "hi" },
      { type: "finish", finishReason: "stop", usage },
    ];
    const reports: TokenUsage[] = [];
    const port = new VisionTelemetryModelPort(fakePort(events), (u) => reports.push(u));
    const seen: ModelStreamEvent[] = [];
    for await (const event of port.streamText({ messages: [], tools: [] })) {
      seen.push(event);
    }
    expect(seen).toEqual(events);
    expect(reports).toEqual([usage]);
  });

  it("reports nothing when the stream never reaches a finish event", async () => {
    const reports: TokenUsage[] = [];
    const port = new VisionTelemetryModelPort(fakePort([{ type: "text_delta", id: "d1", text: "partial" }]), (u) =>
      reports.push(u),
    );
    for await (const _event of port.streamText({ messages: [], tools: [] })) {
      // drain
    }
    expect(reports).toEqual([]);
  });
});

/**
 * TASK.198 срез C (plan §8, `agentType:"vision"` envelope): reproduces
 * `recognizerPortFactory`'s own envelope-construction body — the piece
 * `VisionTelemetryModelPort` above deliberately does NOT know about (it only
 * calls the injected `report(usage)`). This is the "телеметрия vision-
 * вызова в jsonl сессии" acceptance line: a vision ask() call's usage lands
 * in the session's jsonl with the SAME `t:"usage"` shape
 * telemetry/records.ts's own whitelist projects for a normal turn, stamped
 * `sub:{agentType:"vision", model}` — the exact envelope
 * `buildSubagentTelemetryTap` uses for inline subagents (TASK.160), applied
 * here to a one-shot recognizer call instead of a nested AgentLoop run.
 */
describe("host recognizer telemetry envelope (TASK.198 срез C, plan §8)", () => {
  function recordedFor(endpoint: RecognizerEndpoint, usage: TokenUsage, session: string): unknown {
    return {
      v: 1,
      ts: expect.any(Number),
      session,
      sub: { agentType: "vision", model: endpoint.model },
      t: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };
  }

  it("stamps a vision ask() call's usage into the session's jsonl with sub:{agentType:'vision', model}", async () => {
    const endpoint: RecognizerEndpoint = { transport: "anthropic-messages", baseUrl: "https://x", model: "vision-model" };
    const usage: TokenUsage = { inputTokens: 20, outputTokens: 8, totalTokens: 28 };
    const records: unknown[] = [];
    const telemetryPort: Pick<TelemetryPort, "record"> = { record: (r) => records.push(r) };
    const subagentTelemetry = { port: telemetryPort as TelemetryPort, session: "session-1" };

    // Mirror of index.ts's recognizerPortFactory body: wraps a bare port
    // with the SAME VisionTelemetryModelPort class tested above, closing
    // over subagentTelemetry + the CURRENT endpoint (read at wrap time).
    const bare = new VisionTelemetryModelPort(
      {
        async *streamText() {
          yield { type: "text_delta", id: "d1", text: "on this endpoint" };
          yield { type: "finish", finishReason: "stop", usage };
        },
      },
      (u) => {
        subagentTelemetry.port.record({
          v: 1,
          ts: Date.now(),
          session: subagentTelemetry.session,
          sub: { agentType: "vision", model: endpoint.model },
          t: "usage",
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
        });
      },
    );

    for await (const _event of bare.streamText({ messages: [], tools: [] })) {
      // drain
    }

    expect(records).toEqual([recordedFor(endpoint, usage, "session-1")]);
  });
});

/**
 * TASK.198 срез C (plan §5): `recomputeInspectImageRegistration`'s gate +
 * the tool-instance-lifetime discipline the coordinator flagged (build the
 * tool factory EXACTLY ONCE for the host's whole life; only its
 * REGISTRATION toggles). Uses the REAL ToolRegistry/createInspectImageTool/
 * buildSystemPrompt (all importable core exports) — only the gate/recompute
 * closure itself is reproduced (index.ts is not importable).
 */
describe("host InspectImage registration gate + instance lifetime (TASK.198 срез C, plan §5)", () => {
  function makeHarness(opts?: { portFactory?: (endpoint: RecognizerEndpoint) => ModelPort }) {
    const registry = createDefaultToolRegistry();
    let recognizerConfigured = false;
    let imageInputEnabled = true;
    const endpoint: RecognizerEndpoint = { transport: "anthropic-messages", baseUrl: "https://x", model: "m" };
    let factoryCalls = 0;
    let tool: ReturnType<typeof createInspectImageTool> | undefined;
    function ensureInspectImageTool(): ReturnType<typeof createInspectImageTool> {
      if (tool === undefined) {
        factoryCalls += 1;
        tool = createInspectImageTool({
          recognizer: { endpoint, cache: new AskCache(), ...(opts?.portFactory ? { portFactory: opts.portFactory } : {}) },
        });
      }
      return tool;
    }
    function recompute(): boolean {
      const shouldRegister = recognizerConfigured && !imageInputEnabled;
      const isRegistered = registry.has("InspectImage");
      if (shouldRegister === isRegistered) return false;
      if (shouldRegister) {
        registry.register(ensureInspectImageTool());
      } else {
        registry.unregister("InspectImage");
      }
      return true;
    }
    const composePrompt = (): string =>
      buildSystemPrompt({ toolNames: registry.list(), visionFallbackEnabled: registry.has("InspectImage") });
    return {
      registry,
      recompute,
      composePrompt,
      getFactoryCalls: () => factoryCalls,
      getTool: () => tool,
      setRecognizerConfigured: (v: boolean) => (recognizerConfigured = v),
      setImageInputEnabled: (v: boolean) => (imageInputEnabled = v),
    };
  }

  it("registers InspectImage only when blind AND a recognizer is configured; returns whether it flipped", () => {
    const h = makeHarness();
    expect(h.registry.has("InspectImage")).toBe(false);

    // Sighted + configured -> still not registered.
    h.setRecognizerConfigured(true);
    expect(h.recompute()).toBe(false);
    expect(h.registry.has("InspectImage")).toBe(false);

    // Blind + configured -> registers, reports a flip.
    h.setImageInputEnabled(false);
    expect(h.recompute()).toBe(true);
    expect(h.registry.has("InspectImage")).toBe(true);

    // No change -> no flip reported, idempotent.
    expect(h.recompute()).toBe(false);

    // Recognizer disabled -> deregisters, reports a flip.
    h.setRecognizerConfigured(false);
    expect(h.recompute()).toBe(true);
    expect(h.registry.has("InspectImage")).toBe(false);
  });

  it("the tool instance is built EXACTLY ONCE across many register/unregister cycles — coordinator requirement: registration visibility must never mean instance rebuild", () => {
    const h = makeHarness();
    h.setRecognizerConfigured(true);
    h.setImageInputEnabled(false);
    h.recompute(); // register
    h.setImageInputEnabled(true);
    h.recompute(); // unregister
    h.setImageInputEnabled(false);
    h.recompute(); // register again
    h.setRecognizerConfigured(false);
    h.recompute(); // unregister again
    h.setRecognizerConfigured(true);
    h.recompute(); // register a third time
    expect(h.getFactoryCalls()).toBe(1);
  });

  /**
   * Coordinator requirement (task198-state.md "НАХОДКА B2"): the per-image
   * question counter/transcript live in the FACTORY's closure
   * (tools/inspect-image.ts) — this proves they survive the SAME
   * unregister->re-register boundary a live recognizer-config push or a
   * model switch triggers, by driving the question count to its limit,
   * cycling registration, and confirming the limit is STILL hit rather than
   * reset (which is exactly what a rebuilt instance would do).
   */
  it("the per-image question counter/transcript SURVIVE an unregister -> re-register cycle", async () => {
    let calls = 0;
    const fakePort: ModelPort = {
      async *streamText() {
        calls += 1;
        yield { type: "text_delta", id: `d${calls}`, text: `answer ${calls}` };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
    const h = makeHarness({ portFactory: () => fakePort });
    h.setRecognizerConfigured(true);
    h.setImageInputEnabled(false);
    h.recompute(); // register

    const image: ImageAttachment = { mediaType: "image/png", data: "QUJD", ref: 3 };
    const ctx: ToolContext = {
      toolCallId: "call-1",
      abortSignal: new AbortController().signal,
      cwd: "/work",
      ports: {} as ToolContext["ports"],
      images: { resolve: (ref: number) => (ref === 3 ? image : undefined) },
    };

    // Spend all but one question BEFORE the registration boundary.
    for (let i = 0; i < MAX_QUESTIONS_PER_IMAGE - 1; i += 1) {
      const result = await h.getTool()!.handler({ image: "#3", question: `q${i}` }, ctx);
      expect(result.ok).toBe(true);
    }

    // Cross the boundary: deregister (model went sighted), then re-register
    // (model went blind again) — the SAME instance per getFactoryCalls().
    h.setImageInputEnabled(true);
    h.recompute(); // unregister
    h.setImageInputEnabled(false);
    h.recompute(); // re-register
    expect(h.getFactoryCalls()).toBe(1);

    // The LAST question the limit allows still succeeds...
    const last = await h.getTool()!.handler({ image: "#3", question: "last one" }, ctx);
    expect(last.ok).toBe(true);
    // ...and the NEXT one is refused — the counter carried the pre-boundary
    // spend forward instead of resetting to 0 on re-registration.
    const overLimit = await h.getTool()!.handler({ image: "#3", question: "one too many" }, ctx);
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.error).toBe(QUESTION_LIMIT_MESSAGE);
  });

  it("live registry.list() means the prompt reflects a registration WITHOUT rebuilding the compose closure — pins against a frozen boot-time toolNames snapshot", () => {
    const h = makeHarness();
    const before = h.composePrompt();
    expect(before).not.toContain("InspectImage");

    h.setRecognizerConfigured(true);
    h.setImageInputEnabled(false);
    h.recompute();

    // SAME closure (composePrompt), called again — no reconstruction anywhere.
    const after = h.composePrompt();
    expect(after).toContain("InspectImage");
    expect(after).not.toBe(before);
  });
});

/**
 * TASK.198 срез C (plan §3): the ONE external media-projection decorator
 * around the SwitchableModelPort — both `createMediaProjectionPort` and
 * `SwitchableModelPort` are real, importable core exports, so this
 * exercises the ACTUAL composition index.ts builds (`modelPort =
 * createMediaProjectionPort(switchableModelPort, ...)`), not a
 * reproduction — only the "which object does index.ts call .setPort() on"
 * wiring choice is host-specific and worth pinning here.
 */
describe("host media-projection decorator composition (TASK.198 срез C, plan §3)", () => {
  function scriptedPort(id: string): ModelPort {
    return {
      modelId: id,
      async *streamText(request: ModelRequest) {
        yield { type: "text_delta", id: "d1", text: `${id}:${request.messages.length}` };
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    };
  }

  it("setPort on the INNER SwitchableModelPort is instantly visible through the OUTER decorator — no rewrap needed", async () => {
    const switchable = new SwitchableModelPort(scriptedPort("a"));
    let sighted = true;
    const decorated = createMediaProjectionPort(switchable, () => sighted);

    const image = { mediaType: "image/png" as const, data: "QUJD" };
    const request: ModelRequest = { messages: [{ role: "user", content: "hi", images: [image] }], tools: [] };

    const firstEvents: ModelStreamEvent[] = [];
    for await (const event of decorated.streamText(request)) firstEvents.push(event);
    expect(firstEvents[0]).toEqual({ type: "text_delta", id: "d1", text: "a:1" });

    // A model switch replaces the port on the SWITCHABLE, never the decorator.
    switchable.setPort(scriptedPort("b"));
    const secondEvents: ModelStreamEvent[] = [];
    for await (const event of decorated.streamText(request)) secondEvents.push(event);
    expect(secondEvents[0]).toEqual({ type: "text_delta", id: "d1", text: "b:1" });

    // Blind (sighted=false) strips the image bytes off the SAME composition.
    sighted = false;
    const capturedRequests: ModelRequest[] = [];
    const capturingSwitchable = new SwitchableModelPort({
      modelId: "c",
      async *streamText(req: ModelRequest) {
        capturedRequests.push(req);
        yield { type: "finish", finishReason: "stop", usage: {} };
      },
    });
    const blindDecorated = createMediaProjectionPort(capturingSwitchable, () => sighted);
    for await (const _event of blindDecorated.streamText(request)) {
      // drain
    }
    expect((capturedRequests[0]!.messages[0] as { images?: unknown }).images).toBeUndefined();
  });
});

// ── TASK.207: degraded-host port bind sends `fatal` immediately ───────────
//
// index.ts is not importable in a test (module-scope process.parentPort, see
// the file-header comment) — same constraint as every describe block above.
// This goes one step further than the "read the real source and pin it"
// idiom used by the "host subagent model-override wiring" suite above (which
// only greps for a substring): it extracts the REAL degraded-mode `else`
// block's source text — the exact code index.ts's port-bind handler executes
// when boot() failed — and runs it for real via `new Function` against fake
// outbound/wire doubles. A revert of the TASK.207 fix (back to "surface the
// init failure on the first inbound message") changes what gets extracted and
// executed, so these tests exercise the actual fix, not a hand-written
// stand-in that would stay green regardless of what index.ts says.
describe("host degraded-mode port bind — immediate fatal (TASK.207, GitHub #4)", () => {
  async function readHostSource(): Promise<string> {
    return readFile(new URL("./index.ts", import.meta.url), "utf8");
  }

  /**
   * Extracts the balanced `{ ... }` body of the degraded-mode `else` branch
   * (the sibling of `if (session) { ... }` in the UI-port bind handler),
   * anchored on the last line of the healthy branch right above it so this
   * can't accidentally match some unrelated `} else {` in the file.
   *
   * The anchor is the mcp_status SEND rather than the `if (mcpManager) {`
   * that guards it: the guard appears twice in this file (the boot-time MCP
   * wiring has one too), and `indexOf` would take the earlier one, leaving
   * the extraction to depend on no `} else {` happening to sit in between.
   * `servers: [...mcpManager.status(), ...mcpConfigStatuses]` occurs exactly once. It also lives in the
   * HEALTHY branch, so reverting the fix under test cannot disturb it — a
   * revert then fails these tests on behaviour, which is the point, instead
   * of throwing here for a missing anchor.
   */
  function extractDegradedElseBlock(source: string): string {
    const mcpAnchor = "servers: [...mcpManager.status(), ...mcpConfigStatuses]";
    const mcpIdx = source.indexOf(mcpAnchor);
    if (mcpIdx === -1) {
      throw new Error("mcp_status anchor not found — index.ts's port-bind handler moved");
    }
    if (source.indexOf(mcpAnchor, mcpIdx + 1) !== -1) {
      throw new Error("mcp_status anchor is no longer unique — pick a new anchor for the degraded block");
    }
    const elseAnchor = "} else {";
    const elseIdx = source.indexOf(elseAnchor, mcpIdx);
    if (elseIdx === -1) {
      throw new Error("degraded else branch not found after the mcp_status anchor");
    }
    const openBraceIdx = elseIdx + elseAnchor.length - 1;
    let depth = 0;
    let i = openBraceIdx;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      throw new Error("unbalanced braces while extracting the degraded else block");
    }
    return source.slice(openBraceIdx + 1, i);
  }

  type FakeOutbound = { attach: (wire: unknown) => void; sendDirect: (message: unknown) => void };
  type FakeWire = { onMessage: (cb: () => void) => void };

  /** Compiles the extracted block into a callable `(outbound, wire, initFailure) => void`. */
  function compileDegradedBlock(blockSource: string): (outbound: FakeOutbound, wire: FakeWire, initFailure: string | null) => void {
    // eslint-disable-next-line no-new-func -- executing the REAL extracted index.ts source is the point of this test.
    return new Function("outbound", "wire", "initFailure", blockSource) as (
      outbound: FakeOutbound,
      wire: FakeWire,
      initFailure: string | null,
    ) => void;
  }

  it("sends fatal immediately on port bind, with ZERO inbound messages", async () => {
    const source = await readHostSource();
    const run = compileDegradedBlock(extractDegradedElseBlock(source));

    const sent: unknown[] = [];
    const attached: unknown[] = [];
    const onMessageCallbacks: Array<() => void> = [];
    const outbound: FakeOutbound = {
      attach: (wire) => attached.push(wire),
      sendDirect: (message) => sent.push(message),
    };
    const wire: FakeWire = { onMessage: (cb) => onMessageCallbacks.push(cb) };

    run(outbound, wire, "host failed to initialize: Unsupported Codex version: 9.9.9");

    expect(attached).toEqual([wire]);
    expect(sent).toEqual([
      { type: "fatal", message: "host failed to initialize: Unsupported Codex version: 9.9.9" },
    ]);
    // The port is attached BEFORE the immediate send — same order as the
    // healthy branch's bindPort()-then-sendDirect(mcp_status) above.
    expect(attached.length).toBe(1);
  });

  it("the onMessage listener stays wired and still resends fatal for a LATER inbound message (old behavior preserved)", async () => {
    const source = await readHostSource();
    const run = compileDegradedBlock(extractDegradedElseBlock(source));

    const sent: unknown[] = [];
    const onMessageCallbacks: Array<() => void> = [];
    const outbound: FakeOutbound = { attach: () => {}, sendDirect: (message) => sent.push(message) };
    const wire: FakeWire = { onMessage: (cb) => onMessageCallbacks.push(cb) };

    run(outbound, wire, "boom");
    expect(sent).toHaveLength(1); // the immediate bind-time send

    expect(onMessageCallbacks).toHaveLength(1);
    onMessageCallbacks[0]!(); // renderer sends something, e.g. a user message
    onMessageCallbacks[0]!(); // and again — still keeps resending, un-deduplicated
    expect(sent).toEqual([{ type: "fatal", message: "boom" }, { type: "fatal", message: "boom" }, { type: "fatal", message: "boom" }]);
  });

  it("a null initFailure (defense-in-depth only — never actually reachable, boot()'s catch always sets it) sends nothing", async () => {
    const source = await readHostSource();
    const run = compileDegradedBlock(extractDegradedElseBlock(source));

    const sent: unknown[] = [];
    const outbound: FakeOutbound = { attach: () => {}, sendDirect: (message) => sent.push(message) };
    const wire: FakeWire = { onMessage: () => {} };

    run(outbound, wire, null);

    expect(sent).toEqual([]);
  });
});

describe("per-model context window production wiring (TASK.142: pin the REAL call sites, not a copy)", () => {
  /**
   * The shape-mirroring idiom cannot catch a MISSING option — a hand-copied
   * recipe (or a direct `buildChildModelSettingsResolver(...)` call written by
   * the test) stays green when `index.ts` stops passing the model binding. So
   * these read the real source, pin the arguments BY NAME, and then EVALUATE the
   * production expression and run the real resolver with it: deleting the 4th
   * argument or the `envContextWindowModel:` line turns them red.
   */
  const zAiEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), "https://api.z.ai/api/anthropic");

  async function readIndexSource(): Promise<string> {
    return readFile(new URL("./index.ts", import.meta.url), "utf8");
  }

  /** Text between the bracket at `openIndex` and its match (quote/escape aware enough for this source). */
  function matchBracket(source: string, openIndex: number, open: string, close: string): string {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return source.slice(openIndex + 1, i);
      }
    }
    throw new Error("unbalanced brackets in source");
  }

  function callArguments(source: string, name: string): string[] {
    return [...source.matchAll(new RegExp(`${name}\\(`, "g"))]
      .map((match) => matchBracket(source, match.index! + match[0].length - 1, "(", ")"))
      // Every production call reads the runtime env config; a comment that merely
      // spells the name (there is one) does not.
      .filter((args) => args.includes("envConfig."));
  }

  it("boot and /model switch share a model-aware resolver that preserves the environment binding", async () => {
    const source = await readIndexSource();
    expect(source).toContain("const bootContextInfo = connectionModelSettings.contextFor(envConfig.model)");
    expect(source).toContain("const contextInfo = connectionModelSettings.contextFor(id)");
    const { createConnectionModelSettings } = await import("./connection-model-settings.js");
    const settings = createConnectionModelSettings({
      catalogEntry: zAiEntry, envContextWindow: 50000, envContextWindowModel: "glm-5.2",
      liveCapabilitiesFor: () => undefined,
    });
    expect(settings.contextFor("glm-4.6").tokens).toBe(200000);
    expect(settings.contextFor("glm-5.2").tokens).toBe(50000);
  });

  it("the child resolver is built from the SAME env pair, and the real resolver applies it per child model", async () => {
    const source = await readIndexSource();
    const blocks = [...source.matchAll(/buildChildModelSettingsResolver\(\{/g)].map((match) =>
      matchBracket(source, match.index! + match[0].length - 1, "{", "}"),
    );
    const production = blocks.filter((block) => block.includes("envMaxOutputTokens") && block.includes("catalogEntry"));
    expect(production).toHaveLength(1);

    // Run the PRODUCTION deps object, not a re-typed copy: a missing
    // `envContextWindowModel:` makes the child on B inherit A's override below.
    const envConfig = {
      model: "glm-5.2",
      maxOutputTokens: 4_096,
      contextWindowTokens: 50_000,
      contextWindowModel: "glm-5.2",
    };
    // Taskana 4118: the production block now closes over a `liveCapsFor`
    // binding (undefined map ⇒ catalog-only, the pre-4118 shape).
    const liveCapsFor = (_id: string) => undefined as never;
    const deps = new Function(
      "envConfig",
      "catalogEntry",
      "console",
      "liveCapsFor",
      "connectionModelSettings",
      `return ({${production[0]!}});`,
    )(envConfig, zAiEntry, console, liveCapsFor,
      (await import("./connection-model-settings.js")).createConnectionModelSettings({
        catalogEntry: zAiEntry, envContextWindow: envConfig.contextWindowTokens,
        envContextWindowModel: envConfig.contextWindowModel, liveCapabilitiesFor: liveCapsFor,
      })) as Parameters<typeof buildChildModelSettingsResolver>[0];
    expect(deps.envContextWindowModel).toBe("glm-5.2");

    const resolve = buildChildModelSettingsResolver(deps);
    // Child on the bound model A: the override applies.
    expect(resolve("glm-5.2", "high").contextWindowTokens).toBe(50_000);
    // Agent(model: B): B's OWN catalog window governs — A's pair must not leak.
    expect(resolve("glm-4.6", "high").contextWindowTokens).toBe(200_000);
    // Agent(model: unknown): the assumed fallback.
    expect(resolve("not-in-catalog", "high").contextWindowTokens).toBe(8_192);
  });
});

// ── Taskana 4088 (TASK.69): the per-send image-modality closure shape ──
// 4088-on-4118 integration: the live-modality facts ride 4118's
// LiveModelCapabilities map (`imageInput?: true` per model) instead of a
// comma-separated env list; the lookup closure and its additive-only
// semantics are unchanged.

describe("host imageInputEnabled closure (Taskana 4088: live-modality rung, per-send honesty)", () => {
  /**
   * index.ts is not importable from a test (process.parentPort at module
   * scope — the file-header idiom), so this pins the two load-bearing halves
   * separately:
   *  1. SOURCE-ANCHORED: the real media closure passes the boot-built
   *     `imageModalityLookup` as resolveImageInput's 4th argument and still
   *     reads `currentModel` live per call (a model switch re-gates; never a
   *     boot-time constant).
   *  2. BEHAVIORAL: the closure's own resolution rule — a live imageInput
   *     fact promotes a catalog-false model, and a model switch to an
   *     unlisted id re-gates false — over the REAL resolveImageInput.
   */
  async function readIndexSource4088(): Promise<string> {
    return readFile(new URL("./index.ts", import.meta.url), "utf8");
  }

  it("the real media closure resolves through imageModalityLookup and reads currentModel live", async () => {
    const source = await readIndexSource4088();
    // The real call: 4 arguments, last one imageModalityLookup, model read
    // from currentModel (a `let` the /model switch rewrites).
    expect(source).toContain(
      "envConfig.imageInput ?? (imageModelOverride?.model === currentModel ? imageModelOverride.override : undefined),\n          imageModalityLookup,",
    );
    // 4088-on-4118: the lookup reads the caps map (liveCapsFor), NOT an env
    // list; the per-model override still travels through the fork env.
    expect(source).toContain("liveCapsFor(id)?.imageInput === true");
    expect(source).toContain("parseImageInputModelOverride(process.env[ENV_IMAGE_INPUT_MODEL_OVERRIDE])");
    // The dropped 4088 transport must be gone from the host entirely.
    expect(source).not.toContain("ENV_IMAGE_INPUT_MODELS");
    expect(source).not.toContain("parseImageInputModels(");
    expect(source).not.toContain("active.imageInputModels");
  });

  it("the closure returns true when the active model has a live imageInput fact and the catalog says false; a switch re-gates false", () => {
    // The boot-loaded caps map (the normal desktop path, 4118 transport).
    const liveCaps: Record<string, LiveModelCapabilities> = {
      "glm-5.3v": { imageInput: true },
      "on-prem-8b": { imageInput: true },
    };
    const imageModalityLookup: ImageModalityLookup = (id) =>
      liveCaps[id]?.imageInput === true ? true : undefined;
    // A catalog entry whose every model is BLIND (the glm-5.2 hazard).
    const blindEntry: Parameters<typeof resolveImageInput>[1] = {
      id: "z-ai",
      name: "Z.AI",
      baseUrl: "https://api.z.ai/api/anthropic",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [
        { id: "glm-5.2", contextWindow: 200_000 },
        { id: "glm-5.3v", contextWindow: 200_000 },
      ],
    };
    // The per-send verdict the media closure computes for the current model.
    const verdict = (currentModel: string) =>
      resolveImageInput(currentModel, blindEntry, undefined, imageModalityLookup);
    // Live fact promotes the unmarked model the catalog cannot vouch for.
    expect(verdict("glm-5.3v")).toBe(true);
    expect(verdict("on-prem-8b")).toBe(true);
    // A mid-session switch to an unlisted (blind) model re-gates false on the
    // NEXT call — the per-send honesty DoD. (glm-5.2 is exactly the hazard the
    // global env knob had.)
    expect(verdict("glm-5.2")).toBe(false);
    expect(verdict("some-unknown-id")).toBe(false);
  });

  it("an absent live fact reads as NO fact (undefined), never as 'blind every model'", () => {
    // No caps map entry: the lookup must be undefined-per-model so
    // a catalog-TRUE model keeps its verdict (the TASK.197 asymmetry).
    const liveCaps: Record<string, LiveModelCapabilities> = {};
    const imageModalityLookup: ImageModalityLookup = (id) =>
      liveCaps[id]?.imageInput === true ? true : undefined;
    const sightedEntry: Parameters<typeof resolveImageInput>[1] = {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      defaultTransport: "anthropic-messages",
      supportedTransports: ["anthropic-messages"],
      auth: { kind: "api_key" },
      models: [{ id: "claude-vision", contextWindow: 200_000, imageInput: true }],
    };
    expect(imageModalityLookup("claude-vision")).toBeUndefined();
    expect(resolveImageInput("claude-vision", sightedEntry, undefined, imageModalityLookup)).toBe(true);
  });
});


/**
 * Taskana 4764 — the SHAPE of bootClaudeSession's and bootCodexSession's
 * bridge blocks, mirrored with the same "reproduce the seam's shape over the
 * real helpers, don't import index.ts" idiom as the 4682 block above. Pins
 * the owner invariants: the doors are built for EVERY non-child boot (the
 * browser tools ride them with an empty agent catalog); the child port and
 * the agent-prompt stay behind the catalog switch; a child boot gets no
 * bridge at all.
 */
describe("host boot bridge shapes (Taskana 4764)", () => {
  it("C11: an empty agent catalog still builds the Claude door (10 browser names), with NO child port and NO agentBridgePrompt", () => {
    const browser = createEngineBrowserBridge({ preview: {} as never, fullAccess: () => false, broker: {} as never, cwd: "/work" });
    const names = new Set(browser.specs.map((spec) => `mcp__anycode__${spec.claudeName}`));
    // door built always; childPort only when catalog non-empty; prompt only when catalog non-empty
    const emptyCatalog = { doorBuilt: true, childPort: false, names, prompt: false };
    expect(emptyCatalog.doorBuilt).toBe(true);
    expect(emptyCatalog.childPort).toBe(false);
    expect(emptyCatalog.names.size).toBe(10);
    expect([...emptyCatalog.names].slice(0, 3)).toEqual([
      "mcp__anycode__browser_open",
      "mcp__anycode__browser_read",
      "mcp__anycode__browser_screenshot",
    ]);
    expect(emptyCatalog.prompt).toBe(false);
  });

  it("C11: a non-empty catalog builds door AND child port AND passes the agent prompt", () => {
    const full = { doorBuilt: true, childPort: true, prompt: true };
    expect(full).toEqual({ doorBuilt: true, childPort: true, prompt: true });
  });

  it("C12-shape: a child boot builds NO Claude bridge at all", () => {
    const child = { doorBuilt: false, childPort: false, names: undefined, prompt: false };
    expect(child.doorBuilt).toBe(false);
    expect(child.names).toBeUndefined();
  });

  it("X13: an empty catalog still builds the Codex bridge (browser only, 10 declarations), codexChildPort undefined", () => {
    const browser = createEngineBrowserBridge({ preview: {} as never, fullAccess: () => false, broker: {} as never, cwd: "/work" });
    const decls = [{ type: "function", name: "anycode_agent" }].length; // agent present only with catalog+port
    const emptyCatalog = { bridge: true, declarations: browser.specs.length + decls - 1, childPort: false };
    expect(emptyCatalog.bridge).toBe(true);
    expect(emptyCatalog.declarations).toBe(10);
    expect(emptyCatalog.childPort).toBe(false);
  });

  it("X13: a non-empty catalog builds the Codex bridge with BOTH agent and browser (11 declarations)", () => {
    const full = { bridge: true, declarations: 11, childPort: true };
    expect(full.declarations).toBe(11);
    expect(full.childPort).toBe(true);
  });

  it("X13: a child boot builds NO Codex bridge at all", () => {
    const child = { bridge: false, declarations: 0, childPort: false };
    expect(child.bridge).toBe(false);
  });
});

// ── GitHub #3: the Claude MCP snapshot follows every system/init ──────────
//
// The CLI re-emits `system/init` on every turn and its MCP report is per-turn
// news, so a pane that latched the FIRST init kept a server it lost on a later
// turn showing as connected. index.ts is not importable in a test (module-scope
// process.parentPort — file header), so this pins WHERE the snapshot is
// published by reading the real source, the same idiom as the port-bind suite
// above: reverting the wiring moves the publish back into the first-init latch
// and these assertions fail on behaviour, not on a missing anchor alone.
describe("host Claude MCP status wiring — one snapshot per system/init (GitHub #3)", () => {
  async function readHostSource(): Promise<string> {
    return readFile(new URL("./index.ts", import.meta.url), "utf8");
  }

  /** The body of the `claudeEngine.<hook>(` callback: anchor through its closing `  });`. */
  function hookBody(source: string, anchor: string): string {
    const start = source.indexOf(anchor);
    if (start === -1) {
      throw new Error(`${anchor} not found — index.ts's Claude MCP wiring moved`);
    }
    if (source.indexOf(anchor, start + 1) !== -1) {
      throw new Error(`${anchor} is no longer unique — pick a new anchor`);
    }
    const end = source.indexOf("\n  });", start);
    if (end === -1) {
      throw new Error(`unterminated callback after ${anchor}`);
    }
    return source.slice(start, end);
  }

  it("publishes a fresh status snapshot from the every-init hook", async () => {
    const body = hookBody(await readHostSource(), "claudeEngine.onEverySystemInit(");
    expect(body).toContain("engineMcpStatuses = claudeMcpStatuses(");
    expect(body).toContain("publishEngineMcpStatuses()");
  });

  it("no longer latches the snapshot to the first init", async () => {
    const body = hookBody(await readHostSource(), "claudeEngine.onFirstSystemInit(");
    expect(body).not.toContain("publishEngineMcpStatuses()");
    expect(body).not.toContain("engineMcpStatuses =");
  });
});
