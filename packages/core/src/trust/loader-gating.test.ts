/**
 * Trust gate on the project-level loaders (Taskana 4736, design 2.5/2.6).
 * `projectTrusted === false` skips ONLY the project sources (project config,
 * compat .mcp.json, project-tier plugin MCP) with one problem line; user-level
 * config still loads; an absent option keeps today's behaviour.
 */

import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { loadMcpServerSpecs } from "../mcp/config.js";
import { createCommandHook, loadHookConfigs } from "../dispatch/hook-config.js";
import { loadLspServerSpecs } from "../lsp/config.js";
import { loadWebSearchConfig } from "../websearch/config.js";
import { loadTelemetryConfig } from "../telemetry/config.js";
import { loadRepoMapConfig } from "../repoMap/config.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { discoverExtensions } from "../extensions/bootstrap.js";
import type { ExecutionPort } from "../ports/index.js";

const WS = "/proj";
const HOME = "/home/u";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";
const COMPAT = "/proj/.mcp.json";
const PROJECT_PLUGIN = "/proj/.anycode/plugins/acme/.anycode-plugin/plugin.json";
const USER_PLUGIN = "/home/u/.anycode/plugins/tools/.anycode-plugin/plugin.json";

function makeFs(files: Record<string, string>): FileSystemPort {
  const map = new Map(Object.entries(files));
  return {
    readFile: async (path) => {
      const content = map.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => map.has(path) || [...map.keys()].some((k) => k.startsWith(`${path}/`)),
    mkdir: async () => {},
    readdir: async (dir) => {
      const names = new Set<string>();
      for (const key of map.keys()) {
        if (key.startsWith(`${dir}/`)) names.add(key.slice(dir.length + 1).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const stdio = (command: string) => ({ command, args: [] });
const mcpFile = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

describe("loadMcpServerSpecs trust gate", () => {
  const files = {
    [PROJECT_CONFIG]: mcpFile({ proj: stdio("proj-srv") }),
    [USER_CONFIG]: mcpFile({ user: stdio("user-srv") }),
    [COMPAT]: mcpFile({ compat: stdio("compat-srv") }),
  };

  it("untrusted: skips project config and compat .mcp.json, keeps user config, reports one line per skipped source", async () => {
    const result = await loadMcpServerSpecs(makeFs(files), WS, HOME, { projectTrusted: false });
    expect(result.specs.map((s) => s.name)).toEqual(["user"]);
    expect(result.problems).toContain(
      "Project MCP servers in /proj/.anycode/config.json skipped: folder not trusted",
    );
    expect(result.problems).toContain("Project MCP servers in /proj/.mcp.json skipped: folder not trusted");
  });

  it("absent option keeps today's behaviour (library callers)", async () => {
    const result = await loadMcpServerSpecs(makeFs(files), WS, HOME);
    expect(result.specs.map((s) => s.name).sort()).toEqual(["compat", "proj", "user"]);
    expect(result.problems).toEqual([]);
  });

  it("trusted: loads project sources as before", async () => {
    const result = await loadMcpServerSpecs(makeFs(files), WS, HOME, { projectTrusted: true });
    expect(result.specs.map((s) => s.name).sort()).toEqual(["compat", "proj", "user"]);
  });

  it("workspace === home: the shared file is user config and is never gated", async () => {
    const result = await loadMcpServerSpecs(makeFs({ [USER_CONFIG]: mcpFile({ user: stdio("u") }) }), HOME, HOME, {
      projectTrusted: false,
    });
    expect(result.specs.map((s) => s.name)).toEqual(["user"]);
    expect(result.problems).toEqual([]);
  });
});

describe("loadHookConfigs trust gate", () => {
  const hookFile = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ command }] } });
  const files = {
    [PROJECT_CONFIG]: hookFile("echo project"),
    [USER_CONFIG]: hookFile("echo user"),
  };

  it("untrusted: only user hook declarations are returned and the skip is reported", async () => {
    const skipped: string[] = [];
    const decls = await loadHookConfigs(makeFs(files), WS, HOME, {
      projectTrusted: false,
      onSkip: (m) => skipped.push(m),
    });
    expect(decls.map((d) => d.command)).toEqual(["echo user"]);
    expect(skipped).toEqual([
      "Project hooks in /proj/.anycode/config.json skipped: folder not trusted",
    ]);
  });

  it("absent option keeps today's behaviour", async () => {
    const decls = await loadHookConfigs(makeFs(files), WS, HOME);
    expect(decls.map((d) => d.command)).toEqual(["echo user", "echo project"]);
  });

  it("an untrusted workspace registers zero command hooks from the project file", async () => {
    const registered: unknown[] = [];
    const decls = await loadHookConfigs(makeFs({ [PROJECT_CONFIG]: hookFile("echo p") }), WS, HOME, {
      projectTrusted: false,
    });
    for (const decl of decls) registered.push(createCommandHook({} as ExecutionPort, decl, WS));
    expect(registered).toEqual([]);
  });
});

describe("loadLspServerSpecs trust gate", () => {
  const lspFile = (name: string) =>
    JSON.stringify({ lspServers: [{ name, command: `${name}-ls`, extensions: [".ts"] }] });

  it("untrusted: project lspServers are not spawned; user ones still load", async () => {
    const result = await loadLspServerSpecs(
      makeFs({ [PROJECT_CONFIG]: lspFile("proj"), [USER_CONFIG]: lspFile("user") }),
      WS,
      HOME,
      { projectTrusted: false },
    );
    expect(result.specs.map((s) => s.name)).toEqual(["user"]);
    expect(result.issues).toContain("Project LSP servers in /proj/.anycode/config.json skipped: folder not trusted");
  });

  it("absent option keeps today's behaviour", async () => {
    const result = await loadLspServerSpecs(
      makeFs({ [PROJECT_CONFIG]: lspFile("proj") }),
      WS,
      HOME,
    );
    expect(result.specs.map((s) => s.name)).toEqual(["proj"]);
  });
});

describe("discoverPlugins trust gate", () => {
  const manifest = (name: string, command: string) =>
    JSON.stringify({ name, mcpServers: { srv: { command } } });
  const files = {
    [PROJECT_PLUGIN]: manifest("acme", "acme-mcp"),
    [USER_PLUGIN]: manifest("tools", "tools-mcp"),
  };

  it("untrusted: project-tier plugin MCP never spawns; user-tier plugin MCP still does", async () => {
    const result = await discoverPlugins(makeFs(files), {
      workspace: WS,
      home: HOME,
      claimedMcpNames: new Set(),
      projectTrusted: false,
    });
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_tools_srv"]);
    expect(result.problems).toContain('Plugin "acme" MCP servers skipped: folder not trusted');
  });

  it("trusted or absent option: project-tier plugin MCP is discovered as before", async () => {
    const trusted = await discoverPlugins(makeFs(files), {
      workspace: WS,
      home: HOME,
      claimedMcpNames: new Set(),
      projectTrusted: true,
    });
    const absent = await discoverPlugins(makeFs(files), {
      workspace: WS,
      home: HOME,
      claimedMcpNames: new Set(),
    });
    expect(trusted.mcpServerSpecs.map((s) => s.name).sort()).toEqual(["plugin_acme_srv", "plugin_tools_srv"]);
    expect(absent.mcpServerSpecs.map((s) => s.name).sort()).toEqual(["plugin_acme_srv", "plugin_tools_srv"]);
  });

  it("untrusted: project plugin skills and agents are NOT gated (they spawn nothing)", async () => {
    const result = await discoverPlugins(
      makeFs({
        [PROJECT_PLUGIN]: JSON.stringify({ name: "acme", skills: ["skills"] }),
        "/proj/.anycode/plugins/acme/skills/x/SKILL.md": "---\nname: x\n---\n",
      }),
      { workspace: WS, home: HOME, claimedMcpNames: new Set(), projectTrusted: false },
    );
    expect(result.skillRoots.map((r) => r.source)).toEqual(["plugin:acme"]);
  });

  it("untrusted: an explicit config claim is unaffected and project MCP names are not claimed", async () => {
    const claimed = new Set<string>();
    await discoverPlugins(makeFs(files), { workspace: WS, home: HOME, claimedMcpNames: claimed, projectTrusted: false });
    expect([...claimed]).toEqual(["plugin_tools_srv"]);
  });
});

describe("discoverExtensions passes the trust flag through", () => {
  it("untrusted: pluginMcpServerSpecs excludes project-tier plugin servers", async () => {
    const bundle = await discoverExtensions(
      makeFs({ [PROJECT_PLUGIN]: JSON.stringify({ name: "acme", mcpServers: { srv: { command: "x" } } }) }),
      { workspace: WS, home: HOME, projectTrusted: false },
    );
    expect(bundle.pluginMcpServerSpecs).toEqual([]);
  });
});

// Taskana 4736 xfix D2: the project webSearch/telemetry/repoMap sections are
// project-controlled, side-effect-carrying config (a webSearch endpoint gets
// every query POSTed to it; a telemetry dir writes session content to a
// project-chosen path) — same trust question as mcp/hooks/lsp, so the SAME
// gate applies: untrusted => user-level values only, one warning line.
describe("webSearch/telemetry/repoMap trust gate (xfix D2)", () => {
  const projectWebSearch = JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://attacker.example/" } });
  const userWebSearch = JSON.stringify({ webSearch: { backend: "searxng", endpoint: "http://user.example/" } });
  const projectTelemetry = JSON.stringify({ telemetry: { enabled: true, dir: "/proj/tel" } });
  const userTelemetry = JSON.stringify({ telemetry: { enabled: true, dir: "/home/u/tel" } });

  it("untrusted: the project webSearch endpoint never resolves; the user section still can", async () => {
    const result = await loadWebSearchConfig(
      makeFs({ [PROJECT_CONFIG]: projectWebSearch, [USER_CONFIG]: userWebSearch }),
      WS,
      HOME,
      {},
      { projectTrusted: false },
    );
    expect(result.backend?.endpoint).toBe("http://user.example/");
    expect(result.issues).toContain(`Project webSearch config in ${PROJECT_CONFIG} skipped: folder not trusted`);
  });

  it("untrusted with no user webSearch: backend stays null and the skip is reported", async () => {
    const result = await loadWebSearchConfig(makeFs({ [PROJECT_CONFIG]: projectWebSearch }), WS, HOME, {}, {
      projectTrusted: false,
    });
    expect(result.backend).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it("trusted or absent option: the project webSearch section loads as before", async () => {
    const trusted = await loadWebSearchConfig(makeFs({ [PROJECT_CONFIG]: projectWebSearch }), WS, HOME, {}, {
      projectTrusted: true,
    });
    const absent = await loadWebSearchConfig(makeFs({ [PROJECT_CONFIG]: projectWebSearch }), WS, HOME, {});
    expect(trusted.backend?.endpoint).toBe("http://attacker.example/");
    expect(absent.backend?.endpoint).toBe("http://attacker.example/");
    expect(trusted.issues).toEqual([]);
    expect(absent.issues).toEqual([]);
  });

  it("untrusted: the project telemetry dir never resolves; the user section still can", async () => {
    const result = await loadTelemetryConfig(
      makeFs({ [PROJECT_CONFIG]: projectTelemetry, [USER_CONFIG]: userTelemetry }),
      WS,
      HOME,
      {},
      { projectTrusted: false },
    );
    expect(result.telemetry?.dir).toBe("/home/u/tel");
    expect(result.issues).toContain(`Project telemetry config in ${PROJECT_CONFIG} skipped: folder not trusted`);
  });

  it("untrusted with no user telemetry: telemetry stays null and the skip is reported", async () => {
    const result = await loadTelemetryConfig(makeFs({ [PROJECT_CONFIG]: projectTelemetry }), WS, HOME, {}, {
      projectTrusted: false,
    });
    expect(result.telemetry).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it("trusted: the project telemetry section loads as before", async () => {
    const result = await loadTelemetryConfig(makeFs({ [PROJECT_CONFIG]: projectTelemetry }), WS, HOME, {}, {
      projectTrusted: true,
    });
    expect(result.telemetry?.dir).toBe("/proj/tel");
  });

  it("untrusted: the project repoMap section is skipped, user still applies", async () => {
    const files = {
      [PROJECT_CONFIG]: JSON.stringify({ repoMap: { enabled: true, maxTokens: 12000 } }),
      [USER_CONFIG]: JSON.stringify({ repoMap: { enabled: true, maxTokens: 8000 } }),
    };
    const result = await loadRepoMapConfig(makeFs(files), WS, HOME, {}, { projectTrusted: false });
    expect(result.repoMap).toEqual({ enabled: true, maxTokens: 8000 });
    expect(result.issues).toContain(`Project repo-map config in ${PROJECT_CONFIG} skipped: folder not trusted`);
  });

  it("untrusted with no user repoMap: repoMap stays null and the skip is reported", async () => {
    const result = await loadRepoMapConfig(
      makeFs({ [PROJECT_CONFIG]: JSON.stringify({ repoMap: { enabled: true } }) }),
      WS,
      HOME,
      {},
      { projectTrusted: false },
    );
    expect(result.repoMap).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it("workspace === home: the shared file is user config and is never gated", async () => {
    const result = await loadWebSearchConfig(
      makeFs({ [USER_CONFIG]: userWebSearch }),
      HOME,
      HOME,
      {},
      { projectTrusted: false },
    );
    expect(result.backend?.endpoint).toBe("http://user.example/");
    expect(result.issues).toEqual([]);
  });

  it("an absent project file reports nothing even when untrusted", async () => {
    const result = await loadWebSearchConfig(makeFs({}), WS, HOME, {}, { projectTrusted: false });
    expect(result.backend).toBeNull();
    expect(result.issues).toEqual([]);
  });
});
