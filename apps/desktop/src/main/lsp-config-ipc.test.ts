/**
 * Unit tests for the LSP config-management IPC handler logic (Taskana 4743),
 * exercised as the exported handle* functions off a fake in-memory fs + deps
 * bag (no Electron ipcMain, no real disk) — the same style
 * mcp-config-ipc.test.ts established. Covers: the status snapshot (missing /
 * invalid files, non-array lspServers, presetId mapping, hasInitOptions
 * boolean custody), enable writing ONLY lspServers while preserving other
 * keys, re-enable idempotence (no duplicate name), disable, custom-upsert
 * normalization + refusals, unknown preset, `.strict()` extra-key refusals,
 * no_workspace, invalid_shape, and detection wiring over the fake fs.
 */

import { describe, expect, it } from "vitest";
import {
  handleLspCatalogStatus,
  handleLspCustomUpsert,
  handleLspDisable,
  handleLspEnable,
  normalizeLspExtension,
  type LspConfigFs,
  type LspConfigIpcDeps,
} from "./lsp-config-ipc.js";

const HOME = "/home/u";
const WORKSPACE = "/proj";
const TAB_ID = "tab-1";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";
const TRUST_STORE = "/home/u/.anycode/workspace-trust.json";

/** In-memory fs honouring the LspConfigFs surface (stat feeds detection's X_OK check). */
function makeFs(files: Record<string, string> = {}, executables: Record<string, number> = {}): { fs: LspConfigFs; files: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  const fs: LspConfigFs = {
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
    exists: async (path) => path in store || path in executables,
    stat: async (path) => {
      const mode = executables[path];
      if (mode !== undefined) {
        return { size: 0, mtimeMs: 0, isFile: true, isDirectory: false, mode };
      }
      if (path in store) {
        return { size: 0, mtimeMs: 0, isFile: true, isDirectory: false, mode: 0o644 };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    mkdir: async () => {},
    readdir: async () => [],
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

interface DepsOpts {
  noTab?: boolean;
  onceHashes?: Record<string, string>;
  executables?: Record<string, number>;
}

function makeDeps(files: Record<string, string> = {}, opts: DepsOpts = {}): { deps: LspConfigIpcDeps; files: Record<string, string> } {
  const { fs, files: store } = makeFs(files, opts.executables);
  const deps: LspConfigIpcDeps = {
    home: () => HOME,
    workspaceForTab: (tabId) => (opts.noTab || tabId !== TAB_ID ? undefined : WORKSPACE),
    fs,
    pathEnv: () => "/usr/bin:/usr/local/bin",
    platform: () => "darwin",
    ...(opts.onceHashes !== undefined
      ? { trust: { onceHash: (workspace) => opts.onceHashes![workspace] } }
      : {}),
  };
  return { deps, files: store };
}

// ---------------------------------------------------------------------------
// handleLspCatalogStatus

describe("handleLspCatalogStatus", () => {
  it("empty world: full catalog, all not found, empty entries, project available via tab", async () => {
    const { deps } = makeDeps();
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    expect(status.projectScopeAvailable).toBe(true);
    expect(status.entries).toEqual({ project: [], user: [] });
    expect(status.issues).toEqual([]);
    expect(status.catalog.length).toBeGreaterThan(0);
    for (const row of status.catalog) {
      expect(row.found).toBe(false);
      expect(row.foundSource).toBeNull();
      expect(row.installHint.length).toBeGreaterThan(0);
    }
  });

  it("no tabId => projectScopeAvailable false, entries.project null", async () => {
    const { deps } = makeDeps();
    const status = await handleLspCatalogStatus(deps, {});
    expect(status.projectScopeAvailable).toBe(false);
    expect(status.entries.project).toBeNull();
    expect(status.entries.user).toEqual([]);
  });

  it("marks a binary found when it exists in a PATH dir (executable bit set)", async () => {
    const { deps } = makeDeps({}, { executables: { "/usr/local/bin/gopls": 0o755 } });
    const status = await handleLspCatalogStatus(deps, {});
    const gopls = status.catalog.find((row) => row.id === "gopls");
    expect(gopls).toMatchObject({ found: true, foundSource: "path" });
  });

  it("a non-executable file is NOT found (X_OK discipline)", async () => {
    const { deps } = makeDeps({}, { executables: { "/usr/local/bin/gopls": 0o644 } });
    const status = await handleLspCatalogStatus(deps, {});
    const gopls = status.catalog.find((row) => row.id === "gopls");
    expect(gopls).toMatchObject({ found: false, foundSource: null });
  });

  it("nodeBin entries also look in <workspace>/node_modules/.bin; a project-only hit is found:false (foundSource project)", async () => {
    const { deps } = makeDeps(
      {},
      { executables: { "/proj/node_modules/.bin/typescript-language-server": 0o755 } },
    );
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    const ts = status.catalog.find((row) => row.id === "typescript");
    expect(ts).toMatchObject({ found: false, foundSource: "project" });
  });

  it("reads configured entries per scope with presetId mapping and hasInitOptions custody", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: JSON.stringify({
        lspServers: [
          { name: "gopls", command: "gopls", args: [], extensions: [".go"] },
          { name: "mine", command: "my-server", args: ["--stdio"], extensions: [".zz"], initializationOptions: { a: 1 } },
        ],
      }),
      [USER_CONFIG]: JSON.stringify({
        lspServers: [{ name: "gopls", command: "other-go-ls", extensions: [".go", ".GO"] }],
      }),
    });
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    expect(status.entries.project).toEqual([
      { name: "gopls", command: "gopls", args: [], extensions: [".go"], presetId: "gopls", hasInitOptions: false },
      { name: "mine", command: "my-server", args: ["--stdio"], extensions: [".zz"], presetId: null, hasInitOptions: true },
    ]);
    // Extensions normalized to lowercase-dot form; dedup-by-name is the LOADER's
    // job — the pane's view shows each scope's own list.
    expect(status.entries.user).toEqual([
      { name: "gopls", command: "other-go-ls", args: [], extensions: [".go", ".go"], presetId: "gopls", hasInitOptions: false },
    ]);
  });

  it("invalid JSON / bad entry / non-array lspServers surface as issues, never throw", async () => {
    const { deps } = makeDeps({
      [PROJECT_CONFIG]: "{not json",
      [USER_CONFIG]: JSON.stringify({ lspServers: [{ name: "" }, { nomatch: true }] }),
    });
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    expect(status.issues.length).toBeGreaterThanOrEqual(2);
    expect(status.entries.user).toEqual([]);
    expect(status.issues.some((issue) => issue.includes("Invalid JSON"))).toBe(true);
    expect(status.issues.some((issue) => issue.includes("Invalid LSP server"))).toBe(true);
  });

  it("non-array lspServers reports the must-be-an-array issue", async () => {
    const { deps } = makeDeps({ [USER_CONFIG]: JSON.stringify({ lspServers: { a: 1 } }) });
    const status = await handleLspCatalogStatus(deps, {});
    expect(status.issues.some((issue) => issue.includes('"lspServers" must be an array'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projectTrusted

describe("handleLspCatalogStatus — projectTrusted", () => {
  it("is null without a workspace (no tab)", async () => {
    const { deps } = makeDeps();
    const status = await handleLspCatalogStatus(deps, {});
    expect(status.projectTrusted).toBeNull();
  });

  it("is true when the workspace has no project spawn declarations (state none)", async () => {
    const { deps } = makeDeps();
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    expect(status.projectTrusted).toBe(true);
  });

  it("is true when the trust store holds a matching trusted hash for the declarations", async () => {
    // Declarations: a project lspServers entry => a non-empty spawn set.
    const project = { lspServers: [{ name: "gopls", command: "gopls", args: [], extensions: [".go"] }] };
    // First resolve the hash by asking with an empty store (unknown => not trusted),
    // then write a trusted record with that hash and re-ask.
    const { deps: deps1, files } = makeDeps({ [PROJECT_CONFIG]: JSON.stringify(project) });
    const first = await handleLspCatalogStatus(deps1, { tabId: TAB_ID });
    expect(first.projectTrusted).toBe(false);

    // Extract the hash by re-running the core resolver the same way main does.
    const { resolveWorkspaceTrust, defaultTrustStorePath, writeTrustDecision } = await import("@anycode/core/workspace-trust");
    const probe = await resolveWorkspaceTrust(deps1.fs, {
      workspace: WORKSPACE,
      home: HOME,
      storePath: defaultTrustStorePath(HOME),
    });
    files[TRUST_STORE] = JSON.stringify({
      version: 1,
      folders: { [probe.folder]: { decision: "trusted", hash: probe.hash, decidedAt: "2026-10-25T00:00:00Z" } },
    });
    const second = await handleLspCatalogStatus(deps1, { tabId: TAB_ID });
    expect(second.projectTrusted).toBe(true);
    expect(writeTrustDecision).toBeDefined();
  });

  it("is honored via the in-memory once-approval too", async () => {
    const project = { lspServers: [{ name: "gopls", command: "gopls", args: [], extensions: [".go"] }] };
    const { deps: deps1 } = makeDeps({ [PROJECT_CONFIG]: JSON.stringify(project) });
    const { resolveWorkspaceTrust, defaultTrustStorePath } = await import("@anycode/core/workspace-trust");
    const probe = await resolveWorkspaceTrust(deps1.fs, {
      workspace: WORKSPACE,
      home: HOME,
      storePath: defaultTrustStorePath(HOME),
    });
    const { deps } = makeDeps({ [PROJECT_CONFIG]: JSON.stringify(project) }, { onceHashes: { [WORKSPACE]: probe.hash } });
    const status = await handleLspCatalogStatus(deps, { tabId: TAB_ID });
    expect(status.projectTrusted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleLspEnable

describe("handleLspEnable", () => {
  it("writes the preset entry into the USER config, creating the file; only lspServers touched", async () => {
    const { deps, files } = makeDeps({
      [USER_CONFIG]: JSON.stringify({ mcpServers: { context7: { command: "npx" } }, telemetry: { enabled: true } }),
    });
    const result = await handleLspEnable(deps, { presetId: "gopls", scope: "user" });
    expect(result.ok).toBe(true);
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.mcpServers).toEqual({ context7: { command: "npx" } });
    expect(config.telemetry).toEqual({ enabled: true });
    expect(config.lspServers).toEqual([{ name: "gopls", command: "gopls", args: [], extensions: [".go"] }]);
  });

  it("writes into the PROJECT config via the tab's workspace", async () => {
    const { deps, files } = makeDeps();
    const result = await handleLspEnable(deps, { tabId: TAB_ID, presetId: "typescript", scope: "project" });
    expect(result.ok).toBe(true);
    const config = JSON.parse(files[PROJECT_CONFIG]!);
    expect(config.lspServers).toEqual([
      { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
    ]);
    if (result.ok) {
      expect(result.status.entries.project?.[0]).toMatchObject({ name: "typescript", presetId: "typescript" });
    }
  });

  it("re-enable is idempotent: replace-by-name, never a duplicate", async () => {
    const { deps, files } = makeDeps();
    await handleLspEnable(deps, { presetId: "gopls", scope: "user" });
    await handleLspEnable(deps, { presetId: "gopls", scope: "user" });
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.lspServers).toHaveLength(1);
  });

  it("a preset enable over a same-name hand-written entry replaces it (canonical definition wins)", async () => {
    const { deps, files } = makeDeps({
      [USER_CONFIG]: JSON.stringify({
        lspServers: [{ name: "gopls", command: "weird-gopls", args: ["--x"], extensions: [".go", ".gotype"] }],
      }),
    });
    await handleLspEnable(deps, { presetId: "gopls", scope: "user" });
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.lspServers).toEqual([{ name: "gopls", command: "gopls", args: [], extensions: [".go"] }]);
  });

  it("refuses an unknown preset (unknown_preset), writes nothing", async () => {
    const { deps, files } = makeDeps();
    const result = await handleLspEnable(deps, { presetId: "no-such", scope: "user" });
    expect(result).toEqual({ ok: false, reason: "unknown_preset" });
    expect(files[USER_CONFIG]).toBeUndefined();
  });

  it("project scope with no resolvable workspace => no_workspace", async () => {
    const { deps, files } = makeDeps({}, { noTab: true });
    const result = await handleLspEnable(deps, { tabId: "other", presetId: "gopls", scope: "project" });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
    expect(files[USER_CONFIG]).toBeUndefined();
  });

  it("refuses extra keys (.strict): a renderer-supplied `path` never reaches the writer", async () => {
    const { deps } = makeDeps();
    const result = await handleLspEnable(deps, { presetId: "gopls", scope: "user", path: "/etc/evil" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("non-array lspServers => invalid_shape, file untouched", async () => {
    const raw = JSON.stringify({ lspServers: "nope" });
    const { deps, files } = makeDeps({ [USER_CONFIG]: raw });
    const result = await handleLspEnable(deps, { presetId: "gopls", scope: "user" });
    expect(result).toEqual({ ok: false, reason: "invalid_shape" });
    expect(files[USER_CONFIG]).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// handleLspDisable

describe("handleLspDisable", () => {
  it("removes the named entry from the scope, preserving other keys", async () => {
    const { deps, files } = makeDeps({
      [USER_CONFIG]: JSON.stringify({
        telemetry: { enabled: true },
        lspServers: [
          { name: "gopls", command: "gopls", args: [], extensions: [".go"] },
          { name: "mine", command: "x", extensions: [".zz"] },
        ],
      }),
    });
    const result = await handleLspDisable(deps, { name: "gopls", scope: "user" });
    expect(result.ok).toBe(true);
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.telemetry).toEqual({ enabled: true });
    expect(config.lspServers).toEqual([{ name: "mine", command: "x", extensions: [".zz"] }]);
  });

  it("disable of a missing name succeeds (idempotent no-op)", async () => {
    const raw = JSON.stringify({ lspServers: [] });
    const { deps, files } = makeDeps({ [USER_CONFIG]: raw });
    const result = await handleLspDisable(deps, { name: "ghost", scope: "user" });
    expect(result.ok).toBe(true);
    expect(files[USER_CONFIG]).toBe(raw);
  });

  it("no_workspace / invalid refusals mirror enable", async () => {
    const { deps } = makeDeps({}, { noTab: true });
    expect(await handleLspDisable(deps, { name: "gopls", scope: "project" })).toEqual({ ok: false, reason: "no_workspace" });
    expect(await handleLspDisable(deps, { name: "gopls", scope: "user", sneaky: 1 })).toEqual({ ok: false, reason: "invalid" });
  });
});

// ---------------------------------------------------------------------------
// handleLspCustomUpsert

describe("handleLspCustomUpsert", () => {
  it("normalizes extensions to lowercase dot-form and trims name/command", async () => {
    const { deps, files } = makeDeps();
    const result = await handleLspCustomUpsert(deps, {
      scope: "user",
      entry: { name: "  mine ", command: " my-server ", extensions: ["ZZ", ".Q"] },
    });
    expect(result.ok).toBe(true);
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.lspServers).toEqual([{ name: "mine", command: "my-server", extensions: [".zz", ".q"] }]);
  });

  it("keeps optional args and replaces by name on re-upsert", async () => {
    const { deps, files } = makeDeps();
    await handleLspCustomUpsert(deps, { scope: "user", entry: { name: "mine", command: "a", args: ["--x"], extensions: [".a"] } });
    await handleLspCustomUpsert(deps, { scope: "user", entry: { name: "mine", command: "b", args: ["--y", "--z"], extensions: [".b"] } });
    const config = JSON.parse(files[USER_CONFIG]!);
    expect(config.lspServers).toEqual([{ name: "mine", command: "b", args: ["--y", "--z"], extensions: [".b"] }]);
  });

  it("refuses empty/whitespace-only name or command (invalid)", async () => {
    const { deps, files } = makeDeps();
    expect(
      await handleLspCustomUpsert(deps, { scope: "user", entry: { name: "   ", command: "x", extensions: [".x"] } }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await handleLspCustomUpsert(deps, { scope: "user", entry: { name: "x", command: "  ", extensions: [".x"] } }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(files[USER_CONFIG]).toBeUndefined();
  });

  it("refuses a dangerous name (invalid) — never a phantom success", async () => {
    const { deps } = makeDeps();
    const result = await handleLspCustomUpsert(deps, {
      scope: "user",
      entry: { name: "__proto__", command: "x", extensions: [".x"] },
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses empty extensions and extra keys (invalid, .strict() both levels)", async () => {
    const { deps } = makeDeps();
    expect(
      await handleLspCustomUpsert(deps, { scope: "user", entry: { name: "x", command: "y", extensions: [] } }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await handleLspCustomUpsert(deps, {
        scope: "user",
        entry: { name: "x", command: "y", extensions: [".x"], initializationOptions: { evil: true } },
      } as never),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("project scope with no workspace => no_workspace", async () => {
    const { deps } = makeDeps({}, { noTab: true });
    const result = await handleLspCustomUpsert(deps, { tabId: "ghost", scope: "project", entry: { name: "x", command: "y", extensions: [".x"] } });
    expect(result).toEqual({ ok: false, reason: "no_workspace" });
  });
});

// ---------------------------------------------------------------------------
// helpers

describe("normalizeLspExtension", () => {
  it("lowercases and dot-prefixes", () => {
    expect(normalizeLspExtension("TS")).toBe(".ts");
    expect(normalizeLspExtension(".TS")).toBe(".ts");
    expect(normalizeLspExtension(".ts")).toBe(".ts");
    expect(normalizeLspExtension(" ts ")).toBe(".ts");
  });
});
