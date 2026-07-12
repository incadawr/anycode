/**
 * scanHarnessConfigs (design slice-P7.19-cut.md §4 W1): per-harness readers
 * (claude.json top-level + per-project, .claude/settings*.json, .mcp.json compat,
 * codex TOML, zcode JSON), fail-soft parsing, per-entry schema validation, the
 * fixed allowlist (path safety), and the CUSTODY sentinel (env KEY names surface,
 * values live only on entry.env for main-side apply — never stripped here).
 */

import { describe, expect, it } from "vitest";
import { scanHarnessConfigs, type HarnessImportCandidate } from "./harness-import.js";
import type { FileSystemPort } from "../ports/file-system.js";

const HOME = "/home/u";
const WORKSPACE = "/proj";

const CLAUDE_JSON = "/home/u/.claude.json";
const CLAUDE_SETTINGS = "/proj/.claude/settings.json";
const CLAUDE_SETTINGS_LOCAL = "/proj/.claude/settings.local.json";
const MCP_JSON = "/proj/.mcp.json";
const CODEX_TOML = "/home/u/.codex/config.toml";
const ZCODE_JSON = "/home/u/.zcode/cli/config.json";

const SENTINEL = "SENTINEL_MCP_SECRET_93F1";

function makeFs(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

function byName(candidates: HarnessImportCandidate[], name: string): HarnessImportCandidate | undefined {
  return candidates.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Empty / absent

describe("scanHarnessConfigs — empty", () => {
  it("returns no candidates and no problems when nothing exists (silent no-op)", async () => {
    const result = await scanHarnessConfigs(makeFs({}), HOME, WORKSPACE);
    expect(result).toEqual({ candidates: [], problems: [] });
  });
});

// ---------------------------------------------------------------------------
// Claude reader: top-level + per-project

describe("scanHarnessConfigs — claude.json", () => {
  it("merges top-level mcpServers (claude) with projects[workspace].mcpServers (claude-project)", async () => {
    const fs = makeFs({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: {
          globalSrv: { command: "node", args: ["global.js"], type: "stdio" },
        },
        projects: {
          [WORKSPACE]: {
            mcpServers: { projSrv: { command: "node", args: ["proj.js"] } },
          },
          "/other": {
            mcpServers: { otherSrv: { command: "node" } },
          },
        },
      }),
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(problems).toEqual([]);
    const global = byName(candidates, "globalSrv");
    const proj = byName(candidates, "projSrv");
    expect(global?.harness).toBe("claude");
    expect(proj?.harness).toBe("claude-project");
    // Unknown key `type` stripped by the schema; only mapped fields survive.
    expect(global?.entry).toEqual({ command: "node", args: ["global.js"] });
    // Only THIS workspace's project block is read (path safety).
    expect(byName(candidates, "otherSrv")).toBeUndefined();
  });

  it("records a problem and skips an invalid entry, keeping siblings", async () => {
    const fs = makeFs({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: {
          bad: { command: "node", url: "https://x" }, // both command+url
          good: { command: "node" },
        },
      }),
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates.map((c) => c.name)).toEqual(["good"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bad/);
    expect(problems[0]).toMatch(/exactly one of/);
  });

  it("records a problem on invalid JSON and continues with other harnesses", async () => {
    const fs = makeFs({
      [CLAUDE_JSON]: "{ not json",
      [ZCODE_JSON]: JSON.stringify({ mcp: { servers: { z: { command: "node" } } } }),
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates.map((c) => c.name)).toEqual(["z"]);
    expect(problems).toHaveLength(1);
    // W5-FIX (finding 1): content-free, no raw parser message concatenated.
    expect(problems[0]).toMatch(/Failed to parse Claude config .* \(malformed JSON\)/);
  });
});

// ---------------------------------------------------------------------------
// .claude/settings*.json

describe("scanHarnessConfigs — .claude/settings*.json", () => {
  it("reads an mcpServers key when present, badged claude-project", async () => {
    const fs = makeFs({
      [CLAUDE_SETTINGS]: JSON.stringify({ mcpServers: { s1: { command: "node" } } }),
      [CLAUDE_SETTINGS_LOCAL]: JSON.stringify({ mcpServers: { s2: { url: "https://x/mcp" } } }),
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(problems).toEqual([]);
    expect(candidates.map((c) => c.name).sort()).toEqual(["s1", "s2"]);
    expect(byName(candidates, "s1")?.harness).toBe("claude-project");
  });

  it("a settings file without an mcpServers key is a silent no-op", async () => {
    const fs = makeFs({ [CLAUDE_SETTINGS]: JSON.stringify({ permissions: {} }) });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates).toEqual([]);
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// .mcp.json compat

describe("scanHarnessConfigs — .mcp.json compat", () => {
  it("badges candidates alreadyActiveViaCompat", async () => {
    const fs = makeFs({
      [MCP_JSON]: JSON.stringify({ mcpServers: { compatSrv: { command: "node" } } }),
    });
    const { candidates } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    const c = byName(candidates, "compatSrv");
    expect(c?.harness).toBe("mcp-json");
    expect(c?.alreadyActiveViaCompat).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Codex TOML

describe("scanHarnessConfigs — codex config.toml", () => {
  it("parses [mcp_servers.<name>] tables and drops unknown keys with a note", async () => {
    const toml = [
      "[mcp_servers.ctx7]",
      'command = "npx"',
      'args = ["-y", "ctx7"]',
      'cwd = "/tmp/ctx7"',
      "enabled = true",
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.ctx7.env]",
      'API_HOST = "example.com"',
    ].join("\n");
    const fs = makeFs({ [CODEX_TOML]: toml });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    const c = byName(candidates, "ctx7");
    expect(c?.harness).toBe("codex");
    expect(c?.entry).toEqual({
      command: "npx",
      args: ["-y", "ctx7"],
      cwd: "/tmp/ctx7",
      enabled: true,
      env: { API_HOST: "example.com" },
    });
    expect(c?.envKeys).toEqual(["API_HOST"]);
    expect(problems.some((p) => /dropped unsupported keys: startup_timeout_sec/.test(p))).toBe(true);
  });

  it("records a problem on malformed TOML", async () => {
    const fs = makeFs({ [CODEX_TOML]: "this = = = broken" });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates).toEqual([]);
    // W5-FIX (finding 1): content-free, no raw smol-toml message concatenated.
    expect(problems[0]).toMatch(/Failed to parse Codex config .* \(malformed TOML\)/);
  });

  it("W5-FIX (finding 1 — CRITICAL): a TOML parse error whose message would quote a secret-bearing line never leaks the secret into problems", async () => {
    // An unterminated string forces smol-toml to throw a syntax error whose
    // message quotes the offending source line — which here carries the
    // sentinel secret VALUE. The content-free problem must not echo it.
    const leaky = [
      `[mcp_servers.leaky]`,
      `command = "node"`,
      `token = "${SENTINEL}`, // unterminated string on a secret-bearing line
    ].join("\n");
    const fs = makeFs({ [CODEX_TOML]: leaky });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems.join("\n")).not.toContain(SENTINEL);
    expect(problems[0]).toMatch(/Failed to parse Codex config .* \(malformed TOML\)/);
  });

  it("W5-FIX (finding 7): a foreign server named with a reserved prototype key is skipped, not read", async () => {
    // A raw JSON string so `__proto__` is a real OWN key (JSON.parse creates it
    // as a data property; an object literal would set the prototype instead).
    const fs = makeFs({
      [CLAUDE_JSON]: '{"mcpServers":{"__proto__":{"command":"node"},"ok":{"command":"node"}}}',
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(candidates.map((c) => c.name)).toEqual(["ok"]);
    expect(problems.some((pr) => /reserved unsafe name/.test(pr))).toBe(true);
    // Prototype not polluted by the read.
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// zcode JSON

describe("scanHarnessConfigs — zcode config.json", () => {
  it("maps mcp.servers.<name>", async () => {
    const fs = makeFs({
      [ZCODE_JSON]: JSON.stringify({
        mcp: { servers: { ozon: { command: "node", args: ["ozon.js"] } } },
      }),
    });
    const { candidates, problems } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    expect(problems).toEqual([]);
    const c = byName(candidates, "ozon");
    expect(c?.harness).toBe("zcode");
    expect(c?.entry).toEqual({ command: "node", args: ["ozon.js"] });
  });
});

// ---------------------------------------------------------------------------
// CUSTODY sentinel: env KEY names surface; the VALUE stays on entry.env (needed
// main-side by import-apply) and is NOT stripped by the reader.

describe("scanHarnessConfigs — custody (sentinel)", () => {
  it("exposes env KEY names via envKeys and keeps the value only inside entry.env", async () => {
    const fs = makeFs({
      [CLAUDE_JSON]: JSON.stringify({
        mcpServers: {
          secretSrv: { command: "node", env: { API_TOKEN: SENTINEL } },
        },
      }),
    });
    const { candidates } = await scanHarnessConfigs(fs, HOME, WORKSPACE);
    const c = byName(candidates, "secretSrv");
    expect(c?.envKeys).toEqual(["API_TOKEN"]);

    const serialized = JSON.stringify(candidates);
    // KEY name always visible for masked display.
    expect(serialized).toContain("API_TOKEN");
    // The VALUE lives ONLY on entry.env (import-apply consumes it main-side).
    expect(c?.entry.env).toEqual({ API_TOKEN: SENTINEL });
  });
});
