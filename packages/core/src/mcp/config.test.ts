/**
 * loadMcpServerSpecs (design slice-3.2-cut.md §4.4, test matrix §5.2 item 6):
 * source precedence (project > user > compat .mcp.json, whole-record-per-name,
 * never merged), ${env:VAR} substitution (present/absent), enabled:false,
 * malformed-JSON/schema fail-soft, stdio env assembly (minimal base vs
 * inheritEnv ANYCODE_* scrub), and the zero-cost empty-config path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMcpServerSpecs } from "./config.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpHttpServerSpec, McpStdioServerSpec } from "../ports/mcp.js";

const WORKSPACE = "/proj";
const HOME = "/home/u";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";
const COMPAT_CONFIG = "/proj/.mcp.json";

function makeFs(files: Record<string, string>): { fs: FileSystemPort; reads: string[] } {
  const reads: string[] = [];
  const fs: FileSystemPort = {
    readFile: async (path) => {
      reads.push(path);
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
  return { fs, reads };
}

function asStdio(spec: unknown): McpStdioServerSpec {
  return spec as McpStdioServerSpec;
}
function asHttp(spec: unknown): McpHttpServerSpec {
  return spec as McpHttpServerSpec;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Empty / absent config

describe("loadMcpServerSpecs — empty config", () => {
  it("returns zero specs and zero problems, at zero fs-read cost, when no source file exists", async () => {
    const { fs, reads } = makeFs({});
    const result = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(result).toEqual({ specs: [], problems: [] });
    expect(reads).toEqual([]);
  });

  it("treats a config file with no mcpServers section as empty", async () => {
    const { fs } = makeFs({ [PROJECT_CONFIG]: JSON.stringify({}) });
    const result = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(result).toEqual({ specs: [], problems: [] });
  });
});

// ---------------------------------------------------------------------------


describe("loadMcpServerSpecs — precedence", () => {
  it("project wins over user for the same server name (records not merged)", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "project-cmd", args: ["--project"] } },
      }),
      [USER_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "user-cmd", args: ["--user"] } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(problems).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(asStdio(specs[0]).command).toBe("project-cmd");
    expect(asStdio(specs[0]).args).toEqual(["--project"]);
  });

  it("user wins over the compat .mcp.json for the same server name", async () => {
    const { fs } = makeFs({
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "user-cmd" } } }),
      [COMPAT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "compat-cmd" } } }),
    });
    const { specs } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toHaveLength(1);
    expect(asStdio(specs[0]).command).toBe("user-cmd");
  });

  it("project wins over the compat .mcp.json directly", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "project-cmd" } } }),
      [COMPAT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "compat-cmd" } } }),
    });
    const { specs } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toHaveLength(1);
    expect(asStdio(specs[0]).command).toBe("project-cmd");
  });

  it("merges distinct names across all three sources (no name collision)", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { a: { command: "cmd-a" } } }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { b: { command: "cmd-b" } } }),
      [COMPAT_CONFIG]: JSON.stringify({ mcpServers: { c: { command: "cmd-c" } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(problems).toEqual([]);
    expect(specs.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not double-read when workspace and home resolve to the same project config path", async () => {
    const { fs, reads } = makeFs({
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "cmd" } } }),
    });
    const { specs } = await loadMcpServerSpecs(fs, HOME, HOME);
    expect(specs).toHaveLength(1);
    expect(reads.filter((p) => p === USER_CONFIG)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------


describe("loadMcpServerSpecs — ${env:VAR} substitution", () => {
  it("substitutes a present env var inside an env value", async () => {
    vi.stubEnv("MY_TOKEN", "shh-secret");
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "node", env: { TOKEN: "${env:MY_TOKEN}" } } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(problems).toEqual([]);
    expect(asStdio(specs[0]).env.TOKEN).toBe("shh-secret");
  });

  it("substitutes inside a larger string (e.g. an Authorization header)", async () => {
    vi.stubEnv("MY_TOKEN", "abc123");
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${env:MY_TOKEN}" } },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(problems).toEqual([]);
    expect(asHttp(specs[0]).headers).toEqual({ Authorization: "Bearer abc123" });
  });

  it("skips the server (fail-closed) and records a problem when the referenced var is absent", async () => {
    vi.stubEnv("MY_TOKEN", undefined);
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          missingVar: { command: "node", env: { TOKEN: "${env:MY_TOKEN}" } },
          fine: { command: "node" },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["fine"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/missingVar/);
    expect(problems[0]).toMatch(/MY_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// enabled:false

describe("loadMcpServerSpecs — enabled:false", () => {
  it("skips a disabled server silently (no problem)", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          off: { command: "node", enabled: false },
          on: { command: "node" },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["on"]);
    expect(problems).toEqual([]);
  });

  it("a disabled server claims its name — a lower-priority source is NOT consulted as a fallback", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node", enabled: false } } }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toEqual([]);
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fail-soft: malformed JSON / malformed schema

describe("loadMcpServerSpecs — fail-soft malformed sources", () => {
  it("records a problem and continues (no throw) on invalid JSON, other sources still load", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: "{ not json",
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["srv"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Invalid JSON in MCP config \/proj\/\.anycode\/config\.json/);
  });

  it("records a problem and skips ALL servers of a source that fails schema validation", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          bad: { command: "node", env: { KEY: 123 } },
          alsoDropped: { command: "node" },
        },
      }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["srv"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Invalid MCP config \/proj\/\.anycode\/config\.json/);
  });

  it("records a problem when an entry has neither command nor url", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { enabled: true } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toEqual([]);
    expect(problems[0]).toMatch(/exactly one of/);
  });

  it("records a problem when an entry has BOTH command and url", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "node", url: "https://example.com" } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toEqual([]);
    expect(problems[0]).toMatch(/exactly one of/);
  });
});

// ---------------------------------------------------------------------------


describe("loadMcpServerSpecs — stdio env assembly", () => {
  it("builds an explicit minimal base {PATH,HOME,LANG} by default — an ambient secret is not leaked", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/home/u");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("ANYCODE_API_KEY", "super-secret");

    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "node", args: ["server.js"], env: { EXTRA: "1" } } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(problems).toEqual([]);
    const env = asStdio(specs[0]).env;
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", EXTRA: "1" });
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env).not.toBe(process.env);
  });

  it("inheritEnv:true inherits process.env minus every ANYCODE_* key; config env still overrides on top", async () => {
    const savedEnv = process.env;
    process.env = {
      PATH: "/usr/bin",
      ANYCODE_API_KEY: "super-secret",
      ANYCODE_DB_PATH: "/db",
      CUSTOM_VAR: "keep-me",
    } as NodeJS.ProcessEnv;
    try {
      const { fs } = makeFs({
        [PROJECT_CONFIG]: JSON.stringify({
          mcpServers: { srv: { command: "node", inheritEnv: true, env: { EXTRA: "1", PATH: "/override" } } },
        }),
      });
      const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
      expect(problems).toEqual([]);
      const env = asStdio(specs[0]).env;
      expect(env).toEqual({ PATH: "/override", CUSTOM_VAR: "keep-me", EXTRA: "1" });
      expect(env.ANYCODE_API_KEY).toBeUndefined();
      expect(env.ANYCODE_DB_PATH).toBeUndefined();
    } finally {
      process.env = savedEnv;
    }
  });

  it("without inheritEnv, an unset minimal-base key is simply omitted (never an empty string)", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", undefined);
    vi.stubEnv("LANG", undefined);
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const { specs } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    const env = asStdio(specs[0]).env;
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("http specs carry no env field at all", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { url: "https://example.com/mcp" } } }),
    });
    const { specs } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs[0]!.kind).toBe("http");
    expect((specs[0] as unknown as { env?: unknown }).env).toBeUndefined();
  });
});
