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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bashTool,
  backgroundCapableBashTool,
  createWebSearchTool,
  loadWebSearchConfig,
  buildTelemetryTap,
  JsonlTelemetrySink,
  loadTelemetryConfig,
  matchCatalogEntryByBaseUrl,
  NodeFileSystemAdapter,
  resolveContextWindow,
  resolveEffortLevels,
  resolveMaxOutputTokens,
  resolveReasoningEffort,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "@anycode/core";
import type { AgentEvent, PermissionMode, ResolvedTelemetryConfig, ResolvedWebSearchBackend, TelemetryPort } from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type { ShellCapabilitiesProjection } from "../shared/protocol.js";
import { TerminalManager } from "./terminal.js";

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
  ): { context: { contextWindowTokens: number } } | Record<string, never> {
    const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), baseUrl);
    const bootContextWindow = resolveContextWindow(modelId, catalogEntry, override);
    return bootContextWindow !== undefined ? { context: { contextWindowTokens: bootContextWindow } } : {};
  }

  it("model absent from the matched entry (anthropic catalog + test-model) -> spread yields NO context field (default byte-identity)", () => {
    const spread = bootContextSpread("https://api.anthropic.com", "test-model", undefined);

    expect(spread).toEqual({});
    expect("context" in spread).toBe(false);
  });

  it("catalog hit (z-ai + glm-4.5) -> spread yields { context: { contextWindowTokens: 128000 } }", () => {
    const spread = bootContextSpread("https://api.z.ai/api/anthropic", "glm-4.5", undefined);

    expect(spread).toEqual({ context: { contextWindowTokens: 128_000 } });
  });

  it("env override wins over a catalog hit", () => {
    const spread = bootContextSpread("https://api.z.ai/api/anthropic", "glm-4.5", 50_000);

    expect(spread).toEqual({ context: { contextWindowTokens: 50_000 } });
  });

  it("env override wins even with no catalog match at all", () => {
    const spread = bootContextSpread("https://custom.example.com", "test-model", 50_000);

    expect(spread).toEqual({ context: { contextWindowTokens: 50_000 } });
  });
});

describe("host boot reasoning-effort support shape", () => {
  function bootReasoningOptions(baseUrl: string, modelId: string): {
    reasoningSupported: boolean;
    availableEffortLevels?: string[];
  } {
    const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), baseUrl);
    const bootEffortLevels = resolveEffortLevels(modelId, catalogEntry);
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
  function makeSwitcher() {
    const setContextWindowCalls: number[] = [];
    const loop = { setContextWindow: (n: number) => setContextWindowCalls.push(n) };
    const config: { maxOutputTokens?: number; reasoningEffort?: string; context?: { contextWindowTokens: number } } = {};
    const systemPromptEnv: { modelId?: string } = { modelId: "glm-5.2" };
    const switchModel = (id: string, selectedTier: "off" | "low" | "medium" | "high" | "max") => {
      systemPromptEnv.modelId = id;
      const contextWindow =
        resolveContextWindow(id, zAiEntry, undefined) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
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
    // glm-4.6: 200k window, not reasoning-capable.
    expect(out.setContextWindowCalls).toEqual([200_000]);
    expect(out.config.context).toEqual({ contextWindowTokens: 200_000 });
    expect(out.config.maxOutputTokens).toBe(32_768);
    // Effort collapses: config.reasoningEffort undefined, payload "off", no levels.
    expect(out.config.reasoningEffort).toBeUndefined();
    expect(out.result.reasoningEffort).toBe("off");
    expect(out.result.availableEffortLevels).toBeUndefined();
    // Session-static modelId mutated so the rebuilt prompt + children see it.
    expect(out.systemPromptEnv.modelId).toBe("glm-4.6");
  });

  it("carries the selected tier onto a reasoning-capable model", () => {
    const out = makeSwitcher()("glm-5.2", "max");
    expect(out.setContextWindowCalls).toEqual([1_000_000]);
    expect(out.config.context).toEqual({ contextWindowTokens: 1_000_000 });
    expect(out.config.maxOutputTokens).toBe(131_072);
    expect(out.config.reasoningEffort).toBe("max");
    expect(out.result.reasoningEffort).toBe("max");
    expect(out.result.availableEffortLevels).toEqual(["off", "high", "max"]);
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
