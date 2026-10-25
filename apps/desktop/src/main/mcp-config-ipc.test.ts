/**
 * Unit tests for the MCP config-management IPC handler logic (design
 * slice-P7.19-cut.md §3, §4 W2 gate), exercised as the exported handle*
 * functions off a fake in-memory fs + deps bag (no Electron ipcMain, no real
 * disk). Covers: scope resolution + `no_workspace` refusal, compat
 * `read_only_source` refusal, the custody invariant (no env/header VALUE in
 * ANY get/scan response), forced-disabled after import-apply, exists-skip, and
 * `shadowed` marking when project+user both define the same server name.
 */

import { describe, expect, it } from "vitest";
import {
  handleMcpConfigGet,
  handleMcpDelete,
  handleMcpImportApply,
  handleMcpImportScan,
  handleMcpPromoteCompat,
  handleMcpSetEnabled,
  handleMcpUpsert,
  type McpConfigFs,
  type McpConfigIpcDeps,
} from "./mcp-config-ipc.js";

const HOME = "/home/u";
const WORKSPACE = "/proj";
const TAB_ID = "tab-1";
const SENTINEL = "SENTINEL_MCP_SECRET_93F1";

/** In-memory fs honouring the McpConfigFs surface — mirrors core's test fakes. `dirs` feeds readdir so plugin discovery can walk `<root>/.anycode/plugins`. */
function makeFs(files: Record<string, string> = {}, dirs: Record<string, string[]> = {}): { fs: McpConfigFs; files: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  const fs: McpConfigFs = {
    readFile: async (path) => {
      const content = store[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async (path, content) => {
      store[path] = content;
    },
    exists: async (path) => path in store || path in dirs,
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    mkdir: async () => {},
    readdir: async (path) => [...(dirs[path] ?? [])],
    rename: async (from, to) => {
      const content = store[from];
      if (content === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      store[to] = content;
      delete store[from];
    },
  };
  return { fs, files: store };
}

function makeDeps(files: Record<string, string> = {}, opts?: { noTab?: boolean }, dirs: Record<string, string[]> = {}): {
  deps: McpConfigIpcDeps;
  files: Record<string, string>;
} {
  const { fs, files: store } = makeFs(files, dirs);
  const deps: McpConfigIpcDeps = {
    home: () => HOME,
    workspaceForTab: (tabId) => (opts?.noTab || tabId !== TAB_ID ? undefined : WORKSPACE),
    fs,
  };
  return { deps, files: store };
}

const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";
const COMPAT_CONFIG = "/proj/.mcp.json";
const CLAUDE_JSON = "/home/u/.claude.json";

// ---------------------------------------------------------------------------
// handleMcpConfigGet: joined view + shadowed marking

describe("handleMcpConfigGet", () => {
  it("returns entries from project, user, and compat sources", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] } } }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { b: { command: "node", args: ["b.js"] } } }),
      [COMPAT_CONFIG]: JSON.stringify({ mcpServers: { c: { url: "https://c" } } }),
    });
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    expect(snapshot.problems).toEqual([]);
    const names = snapshot.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a", "b", "c"]);
    const a = snapshot.entries.find((e) => e.name === "a");
    expect(a).toMatchObject({ source: "project", enabled: true, transport: "stdio", commandLine: "node a.js" });
    expect(a?.shadowed).toBeUndefined();
    const c = snapshot.entries.find((e) => e.name === "c");
    expect(c).toMatchObject({ source: "compat", transport: "http", commandLine: "https://c" });
  });

  it("marks the lower-priority row shadowed:true when project and user both define the same name (R9)", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { dup: { command: "node", args: ["proj.js"] } } }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { dup: { command: "node", args: ["user.js"] } } }),
    });
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    const rows = snapshot.entries.filter((e) => e.name === "dup");
    expect(rows).toHaveLength(2);
    const projectRow = rows.find((r) => r.source === "project");
    const userRow = rows.find((r) => r.source === "user");
    expect(projectRow?.shadowed).toBeUndefined();
    expect(userRow?.shadowed).toBe(true);
  });

  it("omits project/compat sources with no resolvable tab workspace (user-only)", async () => {
    const { deps } = makeDeps(
      {
        [USER_CONFIG]: JSON.stringify({ mcpServers: { b: { command: "node" } } }),
      },
      { noTab: true },
    );
    const snapshot = await handleMcpConfigGet(deps, {});
    expect(snapshot.entries.map((e) => e.name)).toEqual(["b"]);
  });

  it("CUSTODY: an env/header VALUE never appears in the get response, even when the raw config carries one", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { withSecret: { command: "node", args: ["s.js"], env: { API_KEY: SENTINEL } } },
      }),
    });
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    const entry = snapshot.entries.find((e) => e.name === "withSecret");
    expect(entry?.envKeys).toEqual(["API_KEY"]);
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  });

  it("projects cwd from a stdio entry (W3-FIX: trusted filesystem path, not a secret)", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { withCwd: { command: "node", cwd: "/work/x" } } }),
    });
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    expect(snapshot.entries.find((e) => e.name === "withCwd")?.cwd).toBe("/work/x");
  });

  it("snapshot carries projectAvailable:true when the tab's workspace resolves", async () => {
    const { deps } = makeDeps();
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    expect(snapshot.projectAvailable).toBe(true);
  });

  it("snapshot carries projectAvailable:false when no workspace resolves (no tab / unknown tab)", async () => {
    const { deps } = makeDeps({}, { noTab: true });
    expect((await handleMcpConfigGet(deps, { tabId: TAB_ID })).projectAvailable).toBe(false);
    expect((await handleMcpConfigGet(deps, {})).projectAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleMcpUpsert / handleMcpDelete: scope resolution, refusals, writes

describe("handleMcpUpsert", () => {
  it("writes to the project scope's config file and returns a fresh snapshot", async () => {
    const { deps, files } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "srv",
      entry: { command: "node", args: ["srv.js"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.entries.map((e) => e.name)).toEqual(["srv"]);
      expect(result.snapshot.projectAvailable).toBe(true);
    }
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.mcpServers.srv).toEqual({ command: "node", args: ["srv.js"] });
  });

  it("writes to the user scope's config file", async () => {
    const { deps, files } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      scope: "user",
      name: "srv",
      entry: { command: "node" },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(files[USER_CONFIG] ?? "{}").mcpServers.srv).toEqual({ command: "node" });
  });

  it("refuses `no_workspace` for project scope with no resolvable tab workspace", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      scope: "project",
      name: "srv",
      entry: { command: "node" },
    });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });

  it("refuses `read_only_source` for compat scope — never writes a foreign harness's file", async () => {
    const { deps, files } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      tabId: TAB_ID,
      scope: "compat",
      name: "srv",
      entry: { command: "node" },
    });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
    expect(files[COMPAT_CONFIG]).toBeUndefined();
  });

  it("refuses `invalid` for a malformed entry (both command and url present)", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "srv",
      entry: { command: "node", url: "https://x" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("preserves unrelated top-level keys of the target file (byte-semantic patch)", async () => {
    const { deps, files } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({ hooks: { pre: [] }, mcpServers: {} }),
    });
    await handleMcpUpsert(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "srv",
      entry: { command: "node" },
    });
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.hooks).toEqual({ pre: [] });
    expect(written.mcpServers.srv).toEqual({ command: "node" });
  });
});

describe("handleMcpDelete", () => {
  it("deletes an entry from the project config", async () => {
    const { deps, files } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const result = await handleMcpDelete(deps, { tabId: TAB_ID, scope: "project", name: "srv" });
    expect(result.ok).toBe(true);
    expect(JSON.parse(files[PROJECT_CONFIG] ?? "{}").mcpServers).toEqual({});
  });

  it("refuses `no_workspace` for project scope with no tab", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpDelete(deps, { scope: "project", name: "srv" });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });

  it("refuses `read_only_source` for compat scope", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpDelete(deps, { tabId: TAB_ID, scope: "compat", name: "srv" });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });
});

// ---------------------------------------------------------------------------
// handleMcpSetEnabled: lossless enabled-only patch (W3-FIX)

describe("handleMcpSetEnabled", () => {
  it("toggles enabled while preserving cwd and secret env values verbatim", async () => {
    const { deps, files } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: { command: "node", args: ["s.js"], cwd: "/work/srv", env: { API_KEY: SENTINEL }, enabled: true },
        },
      }),
    });
    const result = await handleMcpSetEnabled(deps, { tabId: TAB_ID, scope: "project", name: "srv", enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.snapshot.entries.find((e) => e.name === "srv");
      expect(entry?.enabled).toBe(false);
      expect(entry?.cwd).toBe("/work/srv");
    }
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.mcpServers.srv).toEqual({
      command: "node",
      args: ["s.js"],
      cwd: "/work/srv",
      env: { API_KEY: SENTINEL },
      enabled: false,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL); // fresh snapshot still custody-safe
  });

  it("refuses `read_only_source` for compat scope", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpSetEnabled(deps, { tabId: TAB_ID, scope: "compat", name: "srv", enabled: true });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses `no_workspace` for project scope with no resolvable tab workspace", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpSetEnabled(deps, { scope: "project", name: "srv", enabled: true });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });

  it("refuses `not_found` for a name absent from the target scope's config", async () => {
    const { deps } = makeDeps({ [PROJECT_CONFIG]: JSON.stringify({ mcpServers: {} }) });
    const result = await handleMcpSetEnabled(deps, { tabId: TAB_ID, scope: "project", name: "ghost", enabled: true });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("writes to the user scope's config file", async () => {
    const { deps, files } = makeDeps({
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node", enabled: true } } }),
    });
    const result = await handleMcpSetEnabled(deps, { scope: "user", name: "srv", enabled: false });
    expect(result.ok).toBe(true);
    expect(JSON.parse(files[USER_CONFIG] ?? "{}").mcpServers.srv.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleMcpImportScan: custody + alreadyConfigured projection

describe("handleMcpImportScan", () => {
  it("CUSTODY: an env VALUE never appears in the scan response, only its key name", async () => {
    const { deps } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: { fromClaude: { command: "node", args: ["x.js"], env: { API_KEY: SENTINEL } } },
      }),
    });
    const result = await handleMcpImportScan(deps, { tabId: TAB_ID });
    const candidate = result.candidates.find((c) => c.name === "fromClaude");
    expect(candidate?.envKeys).toEqual(["API_KEY"]);
    expect(candidate?.hasSecrets).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("marks alreadyConfigured when the name already exists in the project or user config", async () => {
    const { deps } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({ mcpServers: { existing: { command: "node" }, fresh: { command: "node" } } }),
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { existing: { command: "node" } } }),
    });
    const result = await handleMcpImportScan(deps, { tabId: TAB_ID });
    expect(result.candidates.find((c) => c.name === "existing")?.alreadyConfigured).toBe(true);
    expect(result.candidates.find((c) => c.name === "fresh")?.alreadyConfigured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleMcpImportApply: forced-disabled, exists-skip, consent gating

describe("handleMcpImportApply", () => {
  it("applies a candidate with enabled forced false, no consent ⇒ env values stripped", async () => {
    const { deps, files } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: { srv: { command: "node", args: ["x.js"], env: { API_KEY: SENTINEL }, enabled: true } },
      }),
    });
    const result = await handleMcpImportApply(deps, {
      tabId: TAB_ID,
      scope: "project",
      names: ["srv"],
      includeEnvValues: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([{ name: "srv", harness: "claude", applied: true }]);
    }
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.mcpServers.srv.enabled).toBe(false);
    expect(written.mcpServers.srv.env).toBeUndefined();
    expect(JSON.stringify(written)).not.toContain(SENTINEL);
  });

  it("includes env values when includeEnvValues:true, still forces enabled:false", async () => {
    const { deps, files } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: { srv: { command: "node", env: { API_KEY: SENTINEL } } },
      }),
    });
    await handleMcpImportApply(deps, {
      tabId: TAB_ID,
      scope: "project",
      names: ["srv"],
      includeEnvValues: true,
    });
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.mcpServers.srv.env).toEqual({ API_KEY: SENTINEL });
    expect(written.mcpServers.srv.enabled).toBe(false);
  });

  it("exists-skip: a name already present in the target is skipped, not overwritten", async () => {
    const { deps, files } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({ mcpServers: { srv: { command: "node", args: ["new.js"] } } }),
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node", args: ["old.js"] } } }),
    });
    const result = await handleMcpImportApply(deps, {
      tabId: TAB_ID,
      scope: "project",
      names: ["srv"],
      includeEnvValues: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toEqual([{ name: "srv", harness: "claude", applied: false, skipped: "exists" }]);
    }
    const written = JSON.parse(files[PROJECT_CONFIG] ?? "{}");
    expect(written.mcpServers.srv.args).toEqual(["old.js"]);
  });

  it("refuses `read_only_source` for compat scope", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpImportApply(deps, {
      tabId: TAB_ID,
      scope: "compat",
      names: ["srv"],
      includeEnvValues: false,
    });
    expect(result).toEqual({ ok: false, reason: "read_only_source" });
  });

  it("refuses `no_workspace` for project scope with no tab", async () => {
    const { deps } = makeDeps();
    const result = await handleMcpImportApply(deps, {
      scope: "project",
      names: ["srv"],
      includeEnvValues: false,
    });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 2): import-apply selects on IDENTITY, not name — no cross-source copy

describe("W5-FIX finding 2 — import-apply matches candidate identity", () => {
  const ZCODE_JSON = "/home/u/.zcode/cli/config.json";

  it("two same-named candidates from different harnesses: applying the OTHER one writes only it, never the sentinel", async () => {
    // `foo` exists in BOTH Claude (carrying a secret) and zcode (clean).
    const { deps, files } = makeDeps({
      [CLAUDE_JSON]: JSON.stringify({ mcpServers: { foo: { command: "claude-foo", env: { API_TOKEN: SENTINEL } } } }),
      [ZCODE_JSON]: JSON.stringify({ mcp: { servers: { foo: { command: "zcode-foo" } } } }),
    });

    // Discover both, pick the zcode candidate's identity.
    const scan = await handleMcpImportScan(deps, { tabId: TAB_ID });
    const zcodeCand = scan.candidates.find((c) => c.harness === "zcode" && c.name === "foo")!;
    const claudeCand = scan.candidates.find((c) => c.harness === "claude" && c.name === "foo")!;
    expect(zcodeCand.id).not.toBe(claudeCand.id);

    // Apply ONLY the zcode identity — even with consent on, the Claude secret must never land.
    const result = await handleMcpImportApply(deps, {
      tabId: TAB_ID,
      scope: "project",
      ids: [zcodeCand.id],
      includeEnvValues: true,
    });
    expect(result.ok).toBe(true);

    const written = JSON.parse(files[PROJECT_CONFIG]!);
    expect(written.mcpServers.foo.command).toBe("zcode-foo");
    expect(written.mcpServers.foo.enabled).toBe(false);
    expect(files[PROJECT_CONFIG]).not.toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 3): compat promote is main-side, verbatim, forced-disabled

describe("W5-FIX finding 3 — handleMcpPromoteCompat", () => {
  it("promotes the REAL .mcp.json entry (quoted args + cwd + env verbatim) into the project config, forced enabled:false", async () => {
    const compatEntry = {
      command: "node",
      args: ["--label", "two words", "server.js"],
      cwd: "/work/srv",
      env: { API_TOKEN: SENTINEL },
      enabled: true,
    };
    const { deps, files } = makeDeps({
      [COMPAT_CONFIG]: JSON.stringify({ mcpServers: { promoteMe: compatEntry } }),
    });

    const result = await handleMcpPromoteCompat(deps, { tabId: TAB_ID, name: "promoteMe" });
    expect(result.ok).toBe(true);

    const written = JSON.parse(files[PROJECT_CONFIG]!);
    const got = written.mcpServers.promoteMe;
    // Args are byte-identical — no whitespace reparse corrupting the quoted arg.
    expect(got.args).toEqual(["--label", "two words", "server.js"]);
    expect(got.cwd).toBe("/work/srv");
    expect(got.env).toEqual({ API_TOKEN: SENTINEL });
    // Trust gate: never silently enabled.
    expect(got.enabled).toBe(false);
  });

  it("refuses no_workspace with no tab, and not_found for a missing compat entry", async () => {
    const noTab = makeDeps({}, { noTab: true });
    expect(await handleMcpPromoteCompat(noTab.deps, { name: "x" })).toEqual({ ok: false, reason: "no_workspace" });

    const { deps } = makeDeps({ [COMPAT_CONFIG]: JSON.stringify({ mcpServers: {} }) });
    expect(await handleMcpPromoteCompat(deps, { tabId: TAB_ID, name: "ghost" })).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 7): __proto__ / reserved-key handling at the main boundary

describe("W5-FIX finding 7 — reserved prototype-key names", () => {
  it("handleMcpUpsert refuses a __proto__ name with `invalid` (not a silent success)", async () => {
    const { deps, files } = makeDeps();
    const result = await handleMcpUpsert(deps, {
      tabId: TAB_ID,
      scope: "project",
      name: "__proto__",
      entry: { command: "node" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(files[PROJECT_CONFIG]).toBeUndefined();
  });

  it("handleMcpConfigGet skips a foreign config's __proto__ server key with a content-free problem (no pollution)", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: '{"mcpServers":{"__proto__":{"command":"node"},"ok":{"command":"node"}}}',
    });
    const snapshot = await handleMcpConfigGet(deps, { tabId: TAB_ID });
    expect(snapshot.entries.map((e) => e.name)).toEqual(["ok"]);
    expect(snapshot.problems.some((pr) => /reserved unsafe name/.test(pr))).toBe(true);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Taskana 4732 S1-C (design 4732 §6 "Elsewhere"): plugin-contributed rows.
// The snapshot's `pluginServers` ride the SAME discovery the runtime uses —
// renames `plugin_<plugin>_<server>`, explicit config wins a name collision,
// read-only rows only (no new channel, no consent re-derivation in stage 1:
// consentGranted stays an honest false until the Plugins pane owns it).

const USER_PLUGINS_ROOT = "/home/u/.anycode/plugins";

function pluginManifestJson(mcpServers?: Record<string, unknown>): string {
  return JSON.stringify({
    name: "ozon-tools",
    version: "0.3.1",
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  });
}

describe("handleMcpConfigGet pluginServers (Taskana 4732 S1-C)", () => {
  function pluginWorld(manifest: string): { deps: McpConfigIpcDeps } {
    const { deps } = makeDeps(
      { [`${USER_PLUGINS_ROOT}/ozon-tools/.anycode-plugin/plugin.json`]: manifest },
      undefined,
      { [USER_PLUGINS_ROOT]: ["ozon-tools"], [`${USER_PLUGINS_ROOT}/ozon-tools`]: [".anycode-plugin"] },
    );
    return { deps };
  }

  it("projects a plugin's stdio server as a read-only row with the plugin_<name>_<server> rename", async () => {
    const { deps } = pluginWorld(pluginManifestJson({ api: { command: "node", args: ["api.js"], cwd: "." } }));
    const snapshot = await handleMcpConfigGet(deps, {});
    expect(snapshot.pluginServers).toEqual([
      {
        name: "plugin_ozon-tools_api",
        pluginName: "ozon-tools",
        transport: "stdio",
        commandLine: "node api.js",
        consentGranted: false,
        shadowed: false,
        pluginRoot: expect.stringContaining("ozon-tools"),
      },
    ]);
    // Read-only rows never enter `entries` (config rows and plugin rows are
    // distinct views even when a name collides — config wins at runtime).
    expect(snapshot.entries.map((e) => e.name)).not.toContain("plugin_ozon-tools_api");
  });

  it("projects an http server's url as its command line", async () => {
    const { deps } = pluginWorld(pluginManifestJson({ web: { url: "https://example.com/mcp" } }));
    const snapshot = await handleMcpConfigGet(deps, {});
    expect(snapshot.pluginServers?.[0]).toMatchObject({
      name: "plugin_ozon-tools_web",
      transport: "http",
      commandLine: "https://example.com/mcp",
    });
  });

  it("drops a plugin row whose runtime name an explicit config row claims (config wins at runtime — nothing to shadow)", async () => {
    const { deps } = makeDeps(
      {
        [`${USER_PLUGINS_ROOT}/ozon-tools/.anycode-plugin/plugin.json`]: pluginManifestJson({ api: { command: "node", args: ["api.js"] } }),
        [USER_CONFIG]: JSON.stringify({ mcpServers: { "plugin_ozon-tools_api": { command: "mine", args: [] } } }),
      },
      undefined,
      { [USER_PLUGINS_ROOT]: ["ozon-tools"], [`${USER_PLUGINS_ROOT}/ozon-tools`]: [".anycode-plugin"] },
    );
    const snapshot = await handleMcpConfigGet(deps, {});
    // Core's resolver drops plugin servers whose renamed name is already
    // claimed by explicit config, so the pane shows exactly the config row —
    // the runtime precedence, mirrored read-only.
    expect(snapshot.pluginServers).toEqual([]);
    expect(snapshot.entries.map((e) => e.name)).toContain("plugin_ozon-tools_api");
  });

  it("yields no plugin rows (and no problems) when no plugins directory exists — the no-plugin boot is unchanged", async () => {
    const { deps } = makeDeps({ [USER_CONFIG]: JSON.stringify({ mcpServers: {} }) });
    const snapshot = await handleMcpConfigGet(deps, {});
    expect(snapshot.pluginServers).toEqual([]);
    expect(snapshot.problems).toEqual([]);
  });

  it("collects discovery problems fail-soft instead of failing the snapshot", async () => {
    const { deps } = makeDeps(
      { [`${USER_PLUGINS_ROOT}/broken/.anycode-plugin/plugin.json`]: "{ not json" },
      undefined,
      { [USER_PLUGINS_ROOT]: ["broken"], [`${USER_PLUGINS_ROOT}/broken`]: [".anycode-plugin"] },
    );
    const snapshot = await handleMcpConfigGet(deps, {});
    expect(snapshot.pluginServers).toEqual([]);
    expect(snapshot.problems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Taskana 4758: a workspace scope reference (`ws_…`) resolves like a tab id.

describe("mcp scope reference (Taskana 4758)", () => {
  const WS_REF = "ws_0123456789abcdef";
  const refDeps = (files: Record<string, string>, workspace: string | undefined): { deps: McpConfigIpcDeps; files: Record<string, string> } => {
    const built = makeDeps(files, { noTab: true });
    return {
      deps: { ...built.deps, workspaceForTab: (ref) => (ref === WS_REF ? workspace : undefined) },
      files: built.files,
    };
  };

  it("get returns the folder's project entries when a ws_ reference resolves", async () => {
    const { deps } = refDeps({ [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { a: { command: "node" } } }) }, WORKSPACE);
    const snapshot = await handleMcpConfigGet(deps, { tabId: WS_REF });
    expect(snapshot.entries.find((e) => e.name === "a")?.source).toBe("project");
  });

  it("get falls back to user-only for an unresolvable ws_ reference", async () => {
    const { deps } = refDeps({ [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { a: { command: "node" } } }) }, undefined);
    const snapshot = await handleMcpConfigGet(deps, { tabId: "ws_ffffffffffffffff" });
    expect(snapshot.entries.find((e) => e.name === "a")).toBeUndefined();
    expect(snapshot.projectAvailable).toBe(false);
  });

  it("an unresolvable (stale) ws_ reference refuses a project upsert and writes nothing", async () => {
    const { deps, files } = refDeps({}, undefined);
    const result = await handleMcpUpsert(deps, {
      tabId: "ws_ffffffffffffffff",
      scope: "project",
      name: "srv",
      entry: { command: "node" },
    });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
    expect(files[PROJECT_CONFIG]).toBeUndefined();
  });
});
