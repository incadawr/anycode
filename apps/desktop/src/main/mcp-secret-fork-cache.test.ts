/**
 * McpSecretForkCache (Taskana 4752, part C): main-side preparation of the
 * ANYCODE_MCP_SECRETS fork value. In-memory fakes only: no real vault, no real
 * config files. Covers the referenced-only rule (C-19) and the no-leak rule.
 */
import { describe, expect, it, vi } from "vitest";
import { McpSecretForkCache, type McpSecretForkCacheFs } from "./mcp-secret-fork-cache.js";

const HOME = "/home/u";
const WS = "/proj";

/** A fake config store keyed by absolute path. */
function fakeFs(files: Record<string, string>): McpSecretForkCacheFs {
  return {
    exists: async (path) => path in files,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
  };
}

function fakeVault(values: Record<string, string>) {
  return {
    listMcpSecretNames: async () => Object.keys(values).sort(),
    getMcpSecretValues: vi.fn(async (names: readonly string[]) => {
      const out: Record<string, string> = {};
      for (const name of names) if (values[name] !== undefined) out[name] = values[name];
      return out;
    }),
  };
}

const PROJECT = `${WS}/.anycode/config.json`;
const USER = `${HOME}/.anycode/config.json`;
const COMPAT = `${WS}/.mcp.json`;

describe("McpSecretForkCache — referenced-only hand-off (Taskana 4752, C-19)", () => {
  it("C-19: with secrets A and B in the vault but only A referenced, the fork value is {A} only", async () => {
    const vault = fakeVault({ A: "value-of-a", B: "value-of-b" });
    const cache = new McpSecretForkCache({
      vault,
      fs: fakeFs({
        [PROJECT]: JSON.stringify({
          mcpServers: { gh: { url: "https://x", headers: { Authorization: "Bearer ${secret:A}" } } },
        }),
      }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(JSON.parse(cache.get(WS)!)).toEqual({ A: "value-of-a" });
    expect(vault.getMcpSecretValues).toHaveBeenCalledWith(["A"]);
  });

  it("C-19: nothing referenced => get() is undefined (the var is not set at all)", async () => {
    const cache = new McpSecretForkCache({
      vault: fakeVault({ A: "value-of-a" }),
      fs: fakeFs({ [PROJECT]: JSON.stringify({ mcpServers: { plain: { command: "node" } } }) }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(cache.get(WS)).toBeUndefined();
  });

  it("C-19: referenced but not set in the vault => get() is undefined", async () => {
    const cache = new McpSecretForkCache({
      vault: fakeVault({}),
      fs: fakeFs({
        [PROJECT]: JSON.stringify({ mcpServers: { gh: { command: "node", env: { T: "${secret:NOPE}" } } } }),
      }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(cache.get(WS)).toBeUndefined();
  });

  it("references from user and compat .mcp.json files count too, deduplicated", async () => {
    const vault = fakeVault({ A: "a-value", B: "b-value" });
    const cache = new McpSecretForkCache({
      vault,
      fs: fakeFs({
        [USER]: JSON.stringify({ mcpServers: { u: { command: "n", env: { X: "${secret:B}" } } } }),
        [COMPAT]: JSON.stringify({ mcpServers: { c: { command: "n", env: { X: "${secret:A}${secret:B}" } } } }),
      }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(JSON.parse(cache.get(WS)!)).toEqual({ A: "a-value", B: "b-value" });
    expect(vault.getMcpSecretValues).toHaveBeenCalledWith(["A", "B"]);
  });

  it("a config file that is not valid JSON contributes no references and does not throw", async () => {
    const cache = new McpSecretForkCache({
      vault: fakeVault({ A: "a-value" }),
      fs: fakeFs({ [PROJECT]: "{not json" }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(cache.get(WS)).toBeUndefined();
  });
});

describe("McpSecretForkCache — refresh and no-leak (Taskana 4752, C-19/C-23)", () => {
  it("refreshAll re-primes every workspace seen so far (a secret change reaches the next spawn)", async () => {
    let values: Record<string, string> = { A: "old" };
    const vault = {
      listMcpSecretNames: async () => Object.keys(values),
      getMcpSecretValues: async (names: readonly string[]) =>
        Object.fromEntries(names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]!])),
    };
    const cache = new McpSecretForkCache({
      vault,
      fs: fakeFs({ [PROJECT]: JSON.stringify({ mcpServers: { g: { command: "n", env: { T: "${secret:A}" } } } }) }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(JSON.parse(cache.get(WS)!)).toEqual({ A: "old" });
    values = { A: "new" };
    await cache.refreshAll();
    expect(JSON.parse(cache.get(WS)!)).toEqual({ A: "new" });
  });

  it("refreshAll drops the entry when the referenced secret is deleted", async () => {
    let values: Record<string, string> = { A: "x-value" };
    const cache = new McpSecretForkCache({
      vault: {
        listMcpSecretNames: async () => Object.keys(values),
        getMcpSecretValues: async (names: readonly string[]) =>
          Object.fromEntries(names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]!])),
      },
      fs: fakeFs({ [PROJECT]: JSON.stringify({ mcpServers: { g: { command: "n", env: { T: "${secret:A}" } } } }) }),
      home: () => HOME,
    });
    await cache.prime(WS);
    expect(cache.get(WS)).toBeDefined();
    values = {};
    await cache.refreshAll();
    expect(cache.get(WS)).toBeUndefined();
  });

  it("C-19/C-23: a failing read logs one fixed line and never a secret value", async () => {
    const SECRET = "very-secret-value-777";
    const logged: string[] = [];
    const cache = new McpSecretForkCache({
      vault: {
        listMcpSecretNames: async () => ["A"],
        getMcpSecretValues: async () => {
          throw new Error("vault decrypt failed");
        },
      },
      fs: fakeFs({ [PROJECT]: JSON.stringify({ mcpServers: { g: { command: "n", env: { T: "${secret:A}" } } } }) }),
      home: () => HOME,
      logger: (line) => logged.push(line),
    });
    await cache.prime(WS);
    expect(cache.get(WS)).toBeUndefined();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET);
    expect(logged[0]).toMatch(/fork secrets/);
  });
});
