/**
 * Workspace trust model (Taskana 4736): project spawn-config collection + hash,
 * the per-folder decision store, and resolveWorkspaceTrust states.
 */

import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { collectProjectSpawnConfig } from "./project-spawn-config.js";
import {
  canonicalWorkspacePath,
  readTrustStore,
  writeTrustDecision,
  defaultTrustStorePath,
} from "./workspace-trust-store.js";
import { resolveWorkspaceTrust } from "./index.js";

const WS = "/proj";
const HOME = "/home/u";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";
const COMPAT = "/proj/.mcp.json";
const PLUGIN_MANIFEST = "/proj/.anycode/plugins/acme/.anycode-plugin/plugin.json";
const STORE = "/home/u/.anycode/workspace-trust.json";

interface FakeFs extends FileSystemPort {
  files: Map<string, string>;
  writes: { path: string; mode?: number }[];
  renames: { from: string; to: string }[];
}

function makeFs(files: Record<string, string>): FakeFs {
  const map = new Map(Object.entries(files));
  const writes: { path: string; mode?: number }[] = [];
  const renames: { from: string; to: string }[] = [];
  const fs: FakeFs = {
    files: map,
    writes,
    renames,
    readFile: async (path) => {
      const content = map.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content, opts) => {
      writes.push({ path, mode: opts?.mode });
      map.set(path, content);
    },
    rename: async (from, to) => {
      renames.push({ from, to });
      const content = map.get(from);
      if (content !== undefined) {
        map.set(to, content);
        map.delete(from);
      }
    },
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
  return fs;
}

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    lint: { command: "node", args: ["lint.js"], env: { TOKEN: "abc" } },
  },
});

const MCP_CONFIG_REORDERED = JSON.stringify({
  mcpServers: {
    lint: { env: { TOKEN: "abc" }, args: ["lint.js"], command: "node" },
  },
});

function projectHash(files: Record<string, string>): Promise<string> {
  return collectProjectSpawnConfig(makeFs(files), WS, HOME).then((r) => r.hash);
}

describe("collectProjectSpawnConfig", () => {
  it("returns no items and an empty hash when nothing project-level spawns", async () => {
    const result = await collectProjectSpawnConfig(makeFs({}), WS, HOME);
    expect(result.items).toEqual([]);
    expect(result.hash).toBe("");
  });

  it("produces the same hash regardless of JSON key order", async () => {
    const a = await projectHash({ [PROJECT_CONFIG]: MCP_CONFIG });
    const b = await projectHash({ [PROJECT_CONFIG]: MCP_CONFIG_REORDERED });
    expect(a).not.toBe("");
    expect(a).toBe(b);
  });

  it("changes when a stdio command, arg, or env value changes", async () => {
    const base = await projectHash({ [PROJECT_CONFIG]: MCP_CONFIG });
    const cmd = await projectHash({
      [PROJECT_CONFIG]: MCP_CONFIG.replace('"node"', '"bash"'),
    });
    const arg = await projectHash({
      [PROJECT_CONFIG]: MCP_CONFIG.replace("lint.js", "other.js"),
    });
    const env = await projectHash({
      [PROJECT_CONFIG]: MCP_CONFIG.replace("abc", "xyz"),
    });
    expect(cmd).not.toBe(base);
    expect(arg).not.toBe(base);
    expect(env).not.toBe(base);
  });

  it("changes when a project hook command changes", async () => {
    const hook = (command: string) =>
      JSON.stringify({ hooks: { PreToolUse: [{ command }] } });
    const a = await projectHash({ [PROJECT_CONFIG]: hook("echo a") });
    const b = await projectHash({ [PROJECT_CONFIG]: hook("echo b") });
    expect(a).not.toBe(b);
  });

  it("changes when a project lsp server command changes", async () => {
    const lsp = (command: string) =>
      JSON.stringify({
        lspServers: [{ name: "ts", command, extensions: [".ts"] }],
      });
    const a = await projectHash({ [PROJECT_CONFIG]: lsp("tsserver") });
    const b = await projectHash({ [PROJECT_CONFIG]: lsp("evil") });
    expect(a).not.toBe(b);
  });

  it("changes when a project-tier plugin MCP server changes", async () => {
    const manifest = (command: string) =>
      JSON.stringify({ name: "acme", mcpServers: { srv: { command } } });
    const a = await projectHash({ [PLUGIN_MANIFEST]: manifest("node") });
    const b = await projectHash({ [PLUGIN_MANIFEST]: manifest("sh") });
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });

  it("ignores disabled (enabled:false) MCP entries", async () => {
    const enabled = JSON.stringify({ mcpServers: { a: { command: "node" } } });
    const withDisabled = JSON.stringify({
      mcpServers: { a: { command: "node" }, off: { command: "rm", enabled: false } },
    });
    expect(await projectHash({ [PROJECT_CONFIG]: withDisabled })).toBe(
      await projectHash({ [PROJECT_CONFIG]: enabled }),
    );
  });

  it("never includes user-level config", async () => {
    const result = await collectProjectSpawnConfig(
      makeFs({ [USER_CONFIG]: MCP_CONFIG, [COMPAT]: MCP_CONFIG }),
      WS,
      HOME,
    );
    expect(result.items.map((i) => i.source)).toEqual([COMPAT]);
  });

  it("exposes env KEY names but never env values in displayable items", async () => {
    const result = await collectProjectSpawnConfig(
      makeFs({ [PROJECT_CONFIG]: MCP_CONFIG }),
      WS,
      HOME,
    );
    const [item] = result.items;
    expect(item?.envKeys).toEqual(["TOKEN"]);
    expect(item?.commandLine).toBe("node lint.js");
    expect(JSON.stringify(result.items)).not.toContain("abc");
  });

  it("treats workspace === home as user config (never gated)", async () => {
    const result = await collectProjectSpawnConfig(
      makeFs({ [USER_CONFIG]: MCP_CONFIG }),
      HOME,
      HOME,
    );
    expect(result.items).toEqual([]);
    expect(result.hash).toBe("");
  });
});

describe("workspace trust store", () => {
  it("is fail-soft: a corrupt store trusts nothing", async () => {
    const fs = makeFs({ [STORE]: "{not json" });
    const store = await readTrustStore(fs, STORE);
    expect(store.folders).toEqual({});
  });

  it("canonicalises folder keys (trailing separator, relative segments)", () => {
    expect(canonicalWorkspacePath("/proj/")).toBe(canonicalWorkspacePath("/proj"));
    expect(canonicalWorkspacePath("/proj/./sub/..")).toBe("/proj");
  });

  it("writes atomically (tmp + rename) with private mode", async () => {
    const fs = makeFs({});
    await writeTrustDecision(fs, STORE, WS, "trusted", "h1", "2026-10-25T00:00:00.000Z");
    expect(fs.writes.length).toBe(1);
    expect(fs.writes[0]!.path).not.toBe(STORE);
    expect(fs.writes[0]!.mode).toBe(0o600);
    expect(fs.renames.map((r) => r.to)).toEqual([STORE]);
    const store = await readTrustStore(fs, STORE);
    expect(store.folders[canonicalWorkspacePath(WS)]).toEqual({
      decision: "trusted",
      hash: "h1",
      decidedAt: "2026-10-25T00:00:00.000Z",
    });
  });

  it("defaults to ~/.anycode/workspace-trust.json", () => {
    expect(defaultTrustStorePath(HOME)).toBe(STORE);
  });
});

describe("resolveWorkspaceTrust", () => {
  const storePath = STORE;

  it("is 'none' with no project spawn config (nothing to gate)", async () => {
    const r = await resolveWorkspaceTrust(makeFs({}), { workspace: WS, home: HOME, storePath });
    expect(r.state).toBe("none");
    expect(r.projectTrusted).toBe(true);
  });

  it("is 'unknown' for a never-decided folder and does not trust it", async () => {
    const r = await resolveWorkspaceTrust(
      makeFs({ [PROJECT_CONFIG]: MCP_CONFIG }),
      { workspace: WS, home: HOME, storePath },
    );
    expect(r.state).toBe("unknown");
    expect(r.projectTrusted).toBe(false);
    expect(r.items).toHaveLength(1);
  });

  it("is 'trusted' when the stored trusted hash matches", async () => {
    const files: Record<string, string> = { [PROJECT_CONFIG]: MCP_CONFIG };
    const fs = makeFs(files);
    const { hash } = await collectProjectSpawnConfig(fs, WS, HOME);
    await writeTrustDecision(fs, storePath, WS, "trusted", hash, "t");
    const r = await resolveWorkspaceTrust(fs, { workspace: WS, home: HOME, storePath });
    expect(r.state).toBe("trusted");
    expect(r.projectTrusted).toBe(true);
  });

  it("is 'denied' when the stored denial matches and stays silent until the config changes", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: MCP_CONFIG });
    const { hash } = await collectProjectSpawnConfig(fs, WS, HOME);
    await writeTrustDecision(fs, storePath, WS, "denied", hash, "t");
    const r = await resolveWorkspaceTrust(fs, { workspace: WS, home: HOME, storePath });
    expect(r.state).toBe("denied");
    expect(r.projectTrusted).toBe(false);
  });

  it("is 'changed' when the stored decision's hash no longer matches (trusted or denied)", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: MCP_CONFIG });
    await writeTrustDecision(fs, storePath, WS, "trusted", "stale-hash", "t");
    const trusted = await resolveWorkspaceTrust(fs, { workspace: WS, home: HOME, storePath });
    expect(trusted.state).toBe("changed");
    expect(trusted.projectTrusted).toBe(false);

    await writeTrustDecision(fs, storePath, WS, "denied", "stale-hash", "t");
    const denied = await resolveWorkspaceTrust(fs, { workspace: WS, home: HOME, storePath });
    expect(denied.state).toBe("changed");
  });

  it("'Trust once' (onceHash) trusts this run without persisting anything", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: MCP_CONFIG });
    const { hash } = await collectProjectSpawnConfig(fs, WS, HOME);
    const r = await resolveWorkspaceTrust(fs, {
      workspace: WS,
      home: HOME,
      storePath,
      onceHash: hash,
    });
    expect(r.state).toBe("trusted");
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(storePath)).toBe(false);
  });

  it("a 'once' hash for an older config does not trust a changed config", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: MCP_CONFIG });
    const r = await resolveWorkspaceTrust(fs, {
      workspace: WS,
      home: HOME,
      storePath,
      onceHash: "some-old-hash",
    });
    expect(r.state).toBe("unknown");
  });

  it("workspace === home is never gated", async () => {
    const r = await resolveWorkspaceTrust(makeFs({ [USER_CONFIG]: MCP_CONFIG }), {
      workspace: HOME,
      home: HOME,
      storePath,
    });
    expect(r.state).toBe("none");
    expect(r.projectTrusted).toBe(true);
  });
});
