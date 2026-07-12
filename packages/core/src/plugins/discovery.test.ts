/**
 * Plugin discovery tests (design slice-3.3-cut.md §3.6, test matrix §5.2 item
 * 8). Two suites:
 *  - hermetic (fake in-memory FileSystemPort): manifest fail-soft, containment,
 *    mcp rename + cwd default/relative/absolute, ${env:VAR} fail-closed,
 *    stdio env scrub, claimed-set precedence, caps/dedupe, deterministic
 *    manifest-name output ordering.
 *  - real integration (tmpdir + the REAL `mcp/fixtures/fixture-server.mjs`
 *    child, mirroring `mcp/manager.integration.test.ts`): a plugin manifest on
 *    real disk declares the fixture server; the REAL `NodeMcpTransportFactory`
 *    spawns it via `McpManager`; the bridged tool is byte-identical to the
 *    frozen fail-closed metadata table; a call is driven through the FULL
 *    dispatch pipeline (`executeToolCall`) so a mocked `PermissionBroker`
 *    actually sees the "ask"; `env_probe` proves `ANYCODE_API_KEY` never
 *    reaches the child even with `inheritEnv:true`; `dispose()` leaves the
 *    child pid ACTUALLY dead (zero orphans).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins } from "./discovery.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpHttpServerSpec, McpStdioServerSpec } from "../ports/mcp.js";
import { MAX_PLUGINS, MCP_CALL_TIMEOUT_MS, MCP_RESULT_MAX_BYTES } from "../types/config.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeMcpTransportFactory, NodeStdioMcpTransport } from "../adapters/node/node-mcp-transport.js";
import type { McpServerSpec, McpTransportFactory, McpWireTransport } from "../ports/mcp.js";
import { ToolRegistry } from "../tools/registry.js";
import { McpManager } from "../mcp/manager.js";
import { executeToolCall, type DispatchContext } from "../dispatch/dispatcher.js";
import { ModePermissionEngine } from "../permissions/engine.js";
import type {
  AggregatedPreToolUseResult,
  HookRunner,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "../types/hooks.js";
import type { PermissionBroker, PermissionDecision, PermissionRequest } from "../types/permissions.js";
import type { ProposedToolCall } from "../types/events.js";
import type { ToolMetadata } from "../types/tools.js";

// ---------------------------------------------------------------------------
// Hermetic fake FileSystemPort (mirrors mcp/config.test.ts's makeFs helper)

interface FakeFsSpec {
  /** dir path -> entry names returned by readdir. */
  dirs?: Record<string, string[]>;
  /** file path -> content. */
  files?: Record<string, string>;
}

function makeFs(spec: FakeFsSpec): FileSystemPort {
  const dirs = spec.dirs ?? {};
  const files = spec.files ?? {};
  return {
    readFile: async (path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path]!;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path: string) => path in files || path in dirs,
    mkdir: async () => {},
    readdir: async (path: string) => {
      if (!(path in dirs)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...dirs[path]!];
    },
  };
}

const WORKSPACE = "/proj";
const HOME = "/home/u";
const PROJECT_PLUGINS = "/proj/.anycode/plugins";
const USER_PLUGINS = "/home/u/.anycode/plugins";

/** Builds the fake-fs entries for one plugin directory: its manifest.json + optional extra files. */
function pluginFiles(root: string, dir: string, manifest: unknown): Record<string, string> {
  return { [`${root}/${dir}/.anycode-plugin/plugin.json`]: JSON.stringify(manifest) };
}

function asStdio(spec: McpServerSpec): McpStdioServerSpec {
  return spec as McpStdioServerSpec;
}
function asHttp(spec: McpServerSpec): McpHttpServerSpec {
  return spec as McpHttpServerSpec;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Empty world

describe("discoverPlugins — empty world", () => {
  it("returns an all-empty result at zero readdir cost when neither plugins root exists", async () => {
    const fs = makeFs({});
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result).toEqual({ skillRoots: [], agentRoots: [], mcpServerSpecs: [], problems: [] });
  });
});

// ---------------------------------------------------------------------------
// Manifest validation fail-soft (§5.2 item 8)

describe("discoverPlugins — manifest validation is fail-soft", () => {
  it("a directory with no manifest is silently not a plugin (no problem)", async () => {
    const fs = makeFs({ dirs: { [PROJECT_PLUGINS]: ["not-a-plugin"] } });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result).toEqual({ skillRoots: [], agentRoots: [], mcpServerSpecs: [], problems: [] });
  });

  it("bad JSON in one plugin's manifest is skipped+problem; other plugins still load", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["bad-json", "good"] },
      files: {
        [`${PROJECT_PLUGINS}/bad-json/.anycode-plugin/plugin.json`]: "{ not json",
        ...pluginFiles(PROJECT_PLUGINS, "good", { name: "good" }),
      },
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Invalid JSON in plugin manifest.*bad-json/);
    expect(result.skillRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/good/skills`, source: "plugin:good" }]);
    expect(result.agentRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/good/agents`, source: "plugin:good" }]);
  });

  it("a schema-invalid manifest (missing name) is skipped+problem, never crashes", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["bad-schema"] },
      files: pluginFiles(PROJECT_PLUGINS, "bad-schema", { version: "1.0" }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Invalid plugin manifest.*bad-schema/);
    expect(result.skillRoots).toEqual([]);
  });

  it("an unreadable plugins root is fail-soft (readdir throws -> problem, never crashes)", async () => {
    const fs: FileSystemPort = {
      readFile: async () => {
        throw new Error("should not be called");
      },
      writeFile: async () => {},
      stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
      exists: async (path) => path === PROJECT_PLUGINS,
      mkdir: async () => {},
      readdir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Could not list plugins directory.*permission denied/);
  });
});

// ---------------------------------------------------------------------------


describe("discoverPlugins — skills/agents directory containment", () => {
  it("drops a `..`-escape and an absolute path, keeps the well-formed entries, one problem per drop", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["esc"] },
      files: pluginFiles(PROJECT_PLUGINS, "esc", {
        name: "esc",
        skills: ["../../etc", "ok-skills"],
        agents: ["/abs/etc", "ok-agents"],
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });

    expect(result.skillRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/esc/ok-skills`, source: "plugin:esc" }]);
    expect(result.agentRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/esc/ok-agents`, source: "plugin:esc" }]);

    expect(result.problems).toHaveLength(2);
    expect(result.problems.some((p) => p.includes("../../etc") && p.includes("escapes"))).toBe(true);
    expect(result.problems.some((p) => p.includes("/abs/etc") && p.includes("absolute"))).toBe(true);
  });

  it("a dir resolving exactly to the plugin root itself is contained (not an escape)", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["dotroot"] },
      files: pluginFiles(PROJECT_PLUGINS, "dotroot", { name: "dotroot", skills: ["."], agents: [] }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/dotroot`, source: "plugin:dotroot" }]);
  });
});

// ---------------------------------------------------------------------------
// mcpServers rename + cwd handling (§3.6)

describe("discoverPlugins — mcpServers rename + cwd defaulting", () => {
  it("renames plugin_<plugin>_<srv> and defaults cwd to the plugin root when unset", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["np"] },
      files: pluginFiles(PROJECT_PLUGINS, "np", {
        name: "np",
        mcpServers: { alpha: { command: "node", args: ["a.js"] } },
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toEqual([]);
    expect(result.mcpServerSpecs).toHaveLength(1);
    const spec = asStdio(result.mcpServerSpecs[0]!);
    expect(spec.name).toBe("plugin_np_alpha");
    expect(spec.cwd).toBe(`${PROJECT_PLUGINS}/np`);
  });

  it("resolves a relative cwd from the plugin root; leaves an absolute cwd as-is", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["np"] },
      files: pluginFiles(PROJECT_PLUGINS, "np", {
        name: "np",
        mcpServers: {
          relCwd: { command: "node", cwd: "sub/dir" },
          absCwd: { command: "node", cwd: "/abs/somewhere" },
        },
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.problems).toEqual([]);
    const byName = new Map(result.mcpServerSpecs.map((s) => [s.name, asStdio(s)]));
    expect(byName.get("plugin_np_relCwd")?.cwd).toBe(`${PROJECT_PLUGINS}/np/sub/dir`);
    expect(byName.get("plugin_np_absCwd")?.cwd).toBe("/abs/somewhere");
  });

  it("also renames an http server and preserves resolved headers", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["hp"] },
      files: pluginFiles(PROJECT_PLUGINS, "hp", {
        name: "hp",
        mcpServers: { remote: { url: "https://example.com/mcp" } },
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.mcpServerSpecs).toHaveLength(1);
    expect(asHttp(result.mcpServerSpecs[0]!).name).toBe("plugin_hp_remote");
  });
});

// ---------------------------------------------------------------------------
// ${env:VAR} fail-closed + stdio env scrub, reused from resolveMcpServerEntries

describe("discoverPlugins — ${env:VAR} fail-closed and env scrub (via resolveMcpServerEntries reuse)", () => {
  it("a missing referenced env var skips ONLY that server, with a problem; siblings still load", async () => {
    vi.stubEnv("MISSING_VAR_XYZ", undefined);
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["envtest"] },
      files: pluginFiles(PROJECT_PLUGINS, "envtest", {
        name: "envtest",
        mcpServers: {
          needsVar: { command: "node", env: { TOKEN: "${env:MISSING_VAR_XYZ}" } },
          fine: { command: "node" },
        },
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_envtest_fine"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/plugin_envtest_needsVar/);
    expect(result.problems[0]).toMatch(/MISSING_VAR_XYZ/);
  });

  it("by default (no inheritEnv) the stdio env is the minimal base — no ambient secret leaks", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/u");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("ANYCODE_API_KEY", "super-secret");
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["p"] },
      files: pluginFiles(PROJECT_PLUGINS, "p", {
        name: "p",
        mcpServers: { srv: { command: "node" } },
      }),
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    const env = asStdio(result.mcpServerSpecs[0]!).env;
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8" });
    expect(env.ANYCODE_API_KEY).toBeUndefined();
  });

  it("inheritEnv:true still strips every ANYCODE_* key (the plugin path inherits the same scrub)", async () => {
    const savedEnv = process.env;
    process.env = {
      PATH: "/usr/bin",
      ANYCODE_API_KEY: "super-secret",
      CUSTOM_VAR: "keep-me",
    } as NodeJS.ProcessEnv;
    try {
      const fs = makeFs({
        dirs: { [PROJECT_PLUGINS]: ["p"] },
        files: pluginFiles(PROJECT_PLUGINS, "p", {
          name: "p",
          mcpServers: { srv: { command: "node", inheritEnv: true } },
        }),
      });
      const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
      const env = asStdio(result.mcpServerSpecs[0]!).env;
      expect(env).toEqual({ PATH: "/usr/bin", CUSTOM_VAR: "keep-me" });
      expect(env.ANYCODE_API_KEY).toBeUndefined();
    } finally {
      process.env = savedEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Claimed-set: explicit config wins (§3.6/§3.7)

describe("discoverPlugins — the shared claimed-set: explicit config wins", () => {
  it("a name already claimed by explicit config is silently skipped (no problem, no duplicate spec)", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["p1"] },
      files: pluginFiles(PROJECT_PLUGINS, "p1", {
        name: "p1",
        mcpServers: { srv: { command: "node" }, other: { command: "node" } },
      }),
    });
    const claimed = new Set(["plugin_p1_srv"]); // explicit config already claimed this exact renamed name.
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: claimed });

    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_p1_other"]);
    expect(result.problems).toEqual([]);
    expect(claimed.has("plugin_p1_srv")).toBe(true);
    expect(claimed.has("plugin_p1_other")).toBe(true); // now claimed by the plugin itself.
  });
});

// ---------------------------------------------------------------------------
// Caps + dedupe (§3.6)

describe("discoverPlugins — dedupe (project wins) + MAX_PLUGINS cap", () => {
  it("project wins over user for the same manifest name; the user copy is dropped with a problem", async () => {
    const fs = makeFs({
      dirs: {
        [PROJECT_PLUGINS]: ["shared"],
        [USER_PLUGINS]: ["shared"],
      },
      files: {
        ...pluginFiles(PROJECT_PLUGINS, "shared", { name: "shared" }),
        ...pluginFiles(USER_PLUGINS, "shared", { name: "shared" }),
      },
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.skillRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/shared/skills`, source: "plugin:shared" }]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/shared.*already claimed/);
  });

  it(`caps at MAX_PLUGINS (${MAX_PLUGINS}); overflow plugins are skipped with a problem`, async () => {
    const names = Array.from({ length: MAX_PLUGINS + 2 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const files: Record<string, string> = {};
    for (const name of names) {
      Object.assign(files, pluginFiles(PROJECT_PLUGINS, name, { name }));
    }
    const fs = makeFs({ dirs: { [PROJECT_PLUGINS]: names }, files });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });

    expect(result.skillRoots).toHaveLength(MAX_PLUGINS);
    const acceptedNames = new Set(result.skillRoots.map((r) => r.source));
    expect(acceptedNames.size).toBe(MAX_PLUGINS);
    // Scan order is sorted-dir-name order; the first MAX_PLUGINS are accepted, the tail overflows.
    for (const name of names.slice(0, MAX_PLUGINS)) {
      expect(acceptedNames.has(`plugin:${name}`)).toBe(true);
    }
    const overflow = names.slice(MAX_PLUGINS);
    expect(result.problems).toHaveLength(overflow.length);
    for (const name of overflow) {
      expect(result.problems.some((p) => p.includes(name) && p.includes("MAX_PLUGINS"))).toBe(true);
    }
  });

  it("contributions are ordered by manifest NAME (not directory-scan order)", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["aaa-dir", "zzz-dir"] },
      files: {
        ...pluginFiles(PROJECT_PLUGINS, "aaa-dir", { name: "zebra" }),
        ...pluginFiles(PROJECT_PLUGINS, "zzz-dir", { name: "alpha" }),
      },
    });
    const result = await discoverPlugins(fs, { workspace: WORKSPACE, home: HOME, claimedMcpNames: new Set() });
    expect(result.skillRoots.map((r) => r.source)).toEqual(["plugin:alpha", "plugin:zebra"]);
  });
});

// ===========================================================================
// Real integration: tmpdir manifest + the REAL fixture-server child (mirrors
// mcp/manager.integration.test.ts). Proves the plugin path end-to-end: real
// spawn, byte-identical fail-closed metadata, a real permission "ask" reaching
// a broker mock, env scrub against a real child, and zero orphans on dispose.

const FIXTURE = fileURLToPath(new URL("../mcp/fixtures/fixture-server.mjs", import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Captures the concrete NodeStdioMcpTransport the real factory creates, purely to read its .pid test hook. */
class CapturingRealFactory implements McpTransportFactory {
  private readonly real = new NodeMcpTransportFactory();
  transport: NodeStdioMcpTransport | undefined;
  create(spec: McpServerSpec): McpWireTransport {
    const transport = this.real.create(spec);
    this.transport = transport as NodeStdioMcpTransport;
    return transport;
  }
}

function fakeHooks(): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async (): Promise<AggregatedPreToolUseResult> => ({}),
    runUserPromptSubmit: async () => ({}),
    runObservers: async (
      _event: "PostToolUse" | "PostToolUseFailure" | "Stop",
      _input: PostToolUseHookInput,
    ): Promise<void> => {},
  } as unknown as HookRunner;
}

describe("discoverPlugins — real integration (tmpdir manifest + real fixture-server child)", () => {
  let tmpWorkspace: string | undefined;
  let tmpHome: string | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
    if (tmpWorkspace) {
      await rm(tmpWorkspace, { recursive: true, force: true });
      tmpWorkspace = undefined;
    }
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = undefined;
    }
  });

  it(
    "spawns the real child via a plugin manifest; bridged tool metadata is byte-identical; " +
      "a real permission ask reaches a broker mock; env_probe proves no ANYCODE_API_KEY leak " +
      "even with inheritEnv:true; dispose() leaves the pid ACTUALLY dead (zero orphans)",
    async () => {
      vi.stubEnv("ANYCODE_API_KEY", "plugin-integration-secret");

      tmpWorkspace = await mkdtemp(join(tmpdir(), "anycode-plugin-ws-"));
      tmpHome = await mkdtemp(join(tmpdir(), "anycode-plugin-home-"));
      const pluginRoot = join(tmpWorkspace, ".anycode", "plugins", "greeter");
      await mkdir(join(pluginRoot, ".anycode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".anycode-plugin", "plugin.json"),
        JSON.stringify({
          name: "greeter",
          mcpServers: {
            echoer: { command: process.execPath, args: [FIXTURE], inheritEnv: true },
          },
        }),
      );

      const discovered = await discoverPlugins(new NodeFileSystemAdapter(), {
        workspace: tmpWorkspace,
        home: tmpHome,
        claimedMcpNames: new Set(),
      });
      expect(discovered.problems).toEqual([]);
      expect(discovered.mcpServerSpecs).toHaveLength(1);
      const spec = asStdio(discovered.mcpServerSpecs[0]!);
      expect(spec.name).toBe("plugin_greeter_echoer");
      expect(spec.cwd).toBe(pluginRoot);
      // The real inherited env keeps a plain var (PATH) but never leaks ANYCODE_*.
      expect(spec.env.ANYCODE_API_KEY).toBeUndefined();

      const registry = new ToolRegistry();
      const factory = new CapturingRealFactory();
      manager = new McpManager({ registry, transports: factory });
      await manager.start(discovered.mcpServerSpecs);

      const pid = factory.transport?.pid;
      expect(pid).toBeTruthy();
      expect(isPidAlive(pid!)).toBe(true);
      expect(manager.status()).toEqual([
        expect.objectContaining({ name: "plugin_greeter_echoer", state: "connected", toolCount: 6 }),
      ]);

      const toolName = "mcp__plugin_greeter_echoer__echo";
      const echoTool = registry.get(toolName);
      expect(echoTool).toBeDefined();
      // Byte-identical to the frozen fail-closed table (design slice-3.2-cut.md §4.3):
      // the plugin path buys the SAME metadata as explicit config, no softening.
      const expectedMetadata: ToolMetadata = {
        name: toolName,
        description: "Echoes the message argument back as text.",
        readOnly: false,
        destructive: true,
        concurrentSafe: false,
        riskLevel: "high",
        needsApproval: true,
        sideEffectScope: "process",
        timeoutMs: MCP_CALL_TIMEOUT_MS,
        maxOutputBytes: MCP_RESULT_MAX_BYTES,
      };
      expect(echoTool!.metadata).toEqual(expectedMetadata);

      // Drive the call through the FULL dispatch pipeline so a real "ask" reaches a broker mock.
      const brokerMock = vi.fn<PermissionBroker["requestPermission"]>(
        async (): Promise<PermissionDecision> => ({ behavior: "allow" }),
      );
      const broker: PermissionBroker = { requestPermission: brokerMock };
      const dispatchCtx: DispatchContext = {
        registry,
        hooks: fakeHooks(),
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: broker,
        mode: "auto", // riskLevel:"high" -> "ask" in auto mode (design §2.8/permissions/engine.ts).
        ports: {} as DispatchContext["ports"],
        cwd: tmpWorkspace,
      };
      const call: ProposedToolCall = { id: "call-1", name: toolName, input: { message: "hello-from-plugin" } };
      const outcome = await executeToolCall(dispatchCtx, call);

      expect(brokerMock).toHaveBeenCalledTimes(1);
      const requestSeen = brokerMock.mock.calls[0]![0] as PermissionRequest;
      expect(requestSeen.toolName).toBe(toolName);
      expect(outcome.status).toBe("success");
      expect(outcome.modelText).toContain("hello-from-plugin");

      // env_probe proves the real child never saw ANYCODE_API_KEY, even under inheritEnv:true.
      const envProbeTool = registry.get("mcp__plugin_greeter_echoer__env_probe");
      expect(envProbeTool).toBeDefined();
      const probeResult = await envProbeTool!.handler(
        {},
        { toolCallId: "t2", abortSignal: new AbortController().signal, cwd: tmpWorkspace, ports: {} as never },
      );
      expect(probeResult.ok).toBe(true);
      const childEnv = JSON.parse(probeResult.output as string) as Record<string, string | undefined>;
      expect(childEnv.ANYCODE_API_KEY).toBeUndefined();
      expect(childEnv.PATH).toBeTruthy(); // inheritEnv:true DID inherit a plain var — proves it wasn't just an empty env.

      await manager.dispose();
      manager = undefined;

      await waitForDead(pid!);
      expect(isPidAlive(pid!)).toBe(false); // zero orphans on the plugin path.
    },
    20_000,
  );
});
