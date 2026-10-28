/**
 * loadMcpServerSpecs (design slice-3.2-cut.md §4.4, test matrix §5.2 item 6):
 * source precedence (project > user > compat .mcp.json, whole-record-per-name,
 * never merged), ${env:VAR} substitution (present/absent), enabled:false,
 * malformed-JSON/schema fail-soft, stdio env assembly (minimal base vs
 * inheritEnv ANYCODE_* scrub), and the zero-cost empty-config path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectSecretRefs, loadMcpServerSpecs } from "./config.js";
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
  it("reports a disabled server", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          off: { command: "node", enabled: false },
          on: { command: "node" },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { reportDisabled: true });
    expect(specs.map((s) => s.name)).toEqual(["on"]);
    expect(problems[0]).toMatch(/off.*disabled/);
  });

  it("a disabled server claims its name — a lower-priority source is NOT consulted as a fallback", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node", enabled: false } } }),
      [USER_CONFIG]: JSON.stringify({ mcpServers: { srv: { command: "node" } } }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { reportDisabled: true });
    expect(specs).toEqual([]);
    expect(problems[0]).toMatch(/srv.*disabled/);
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

  it("reports a malformed entry and loads its valid sibling", async () => {
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
    expect(specs.map((s) => s.name)).toEqual(["alsoDropped", "srv"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bad.*invalid entry/);
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

  it("inheritEnv:true scrubs a credentialed proxy and hands the relay env to the server instead (TASK.135 follow-up)", async () => {
    const savedEnv = process.env;
    const RELAY = "http://127.0.0.1:47557";
    const relayModule = await import("../adapters/node/proxy-relay.js");
    // Taskana 4685 rework: the per-value relay lookup (a minted relay URL
    // would carry `anycode:<token>@` userinfo — the one @ the scrub permits).
    const relayUrlSpy = vi.spyOn(relayModule, "proxyRelayLookup").mockReturnValue(() => RELAY);
    process.env = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://user:s3cret@proxy.corp:3128",
      https_proxy: "http://user:s3cret@proxy.corp:3128",
      NO_PROXY: "localhost",
      ANYCODE_CLAUDE_PROXY_URL: "direct",
      CUSTOM_VAR: "keep-me",
    } as NodeJS.ProcessEnv;
    try {
      const { fs } = makeFs({
        [PROJECT_CONFIG]: JSON.stringify({
          mcpServers: { srv: { command: "node", inheritEnv: true } },
        }),
      });
      const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
      expect(problems).toEqual([]);
      const env = asStdio(specs[0]).env!;
      // The relay env REPLACES the credentialed family (both cases), never
      // carries an @ anywhere, and keeps NO_PROXY as-is.
      expect(env.HTTPS_PROXY).toBe(RELAY);
      expect(env.https_proxy).toBe(RELAY);
      expect(env.NO_PROXY).toBe("localhost");
      expect(env.CUSTOM_VAR).toBe("keep-me");
      expect(env.ANYCODE_CLAUDE_PROXY_URL).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("@");
      expect(JSON.stringify(env)).not.toContain("s3cret");
    } finally {
      relayUrlSpy.mockRestore();
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

// ---------------------------------------------------------------------------
// Taskana 4752 part C: ${secret:NAME} in MCP env/headers (core resolver).

describe("loadMcpServerSpecs — ${secret:NAME} substitution (Taskana 4752, part C)", () => {
  const secretsFrom = (values: Record<string, string>) => (name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;

  it("C-1: resolves ${secret:NAME} inside an env value from the injected resolver", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "node", env: { TOKEN: "${secret:GH_TOKEN}" } } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, {
      secrets: secretsFrom({ GH_TOKEN: "ghp_live" }),
    });
    expect(problems).toEqual([]);
    expect(asStdio(specs[0]).env.TOKEN).toBe("ghp_live");
  });

  it("C-2: resolves inside an HTTP header (Bearer example)", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${secret:GITHUB_TOKEN}" } },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, {
      secrets: secretsFrom({ GITHUB_TOKEN: "gho_abc" }),
    });
    expect(problems).toEqual([]);
    expect(asHttp(specs[0]).headers).toEqual({ Authorization: "Bearer gho_abc" });
  });

  it("C-3: an unset secret skips the server; the problem names the secret only", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          needsSecret: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${secret:GH_TOKEN}" } },
          fine: { command: "node" },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { secrets: secretsFrom({}) });
    expect(specs.map((s) => s.name)).toEqual(["fine"]);
    expect(problems).toEqual([
      `MCP server 'needsSecret' in ${PROJECT_CONFIG}: secret 'GH_TOKEN' is not set — add it in Settings → MCP → Secrets — server skipped`,
    ]);
  });

  it("C-4: with no resolver supplied, a ${secret:} reference is skipped with the same message", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: { srv: { command: "node", env: { TOKEN: "${secret:GH_TOKEN}" } } },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/secret 'GH_TOKEN' is not set/);
  });

  it("C-5: mixed ${env:A} and ${secret:B} in one value both resolve", async () => {
    vi.stubEnv("MCP_TEST_HOST", "api.example.com");
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: { url: "https://x", headers: { "X-Auth": "${env:MCP_TEST_HOST}:${secret:API_KEY}" } },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, {
      secrets: secretsFrom({ API_KEY: "k-123" }),
    });
    expect(problems).toEqual([]);
    expect(asHttp(specs[0]).headers).toEqual({ "X-Auth": "api.example.com:k-123" });
  });

  it("C-6: a secret VALUE that looks like ${env:HOME} or ${secret:Y} stays literal (no re-scan)", async () => {
    vi.stubEnv("HOME", "/should/not/leak");
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: { url: "https://x", headers: { "X-A": "${secret:A}", "X-B": "${secret:B}" } },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, {
      secrets: secretsFrom({ A: "${env:HOME}", B: "${secret:Y}" }),
    });
    expect(problems).toEqual([]);
    expect(asHttp(specs[0]).headers).toEqual({ "X-A": "${env:HOME}", "X-B": "${secret:Y}" });
  });

  it("C-7: ${secret:} in command, args, cwd and url is left untouched (never substituted)", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: {
            command: "run-${secret:A}",
            args: ["${secret:A}"],
            cwd: "/tmp/${secret:A}",
          },
          web: { url: "https://h/${secret:A}" },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { secrets: secretsFrom({ A: "xyz" }) });
    expect(problems).toEqual([]);
    const stdio = asStdio(specs.find((s) => s.name === "srv"));
    expect(stdio.command).toBe("run-${secret:A}");
    expect(stdio.args).toEqual(["${secret:A}"]);
    expect(stdio.cwd).toBe("/tmp/${secret:A}");
    expect(asHttp(specs.find((s) => s.name === "web")).url).toBe("https://h/${secret:A}");
  });

  it("C-8: an invalid secret name (a-b, 1x, over 64 chars) is left literal, not an error", async () => {
    const tooLong = "a".repeat(65);
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: {
            url: "https://x",
            headers: {
              "X-1": "${secret:a-b}",
              "X-2": "${secret:1x}",
              "X-3": `\${secret:${tooLong}}`,
            },
          },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { secrets: secretsFrom({}) });
    expect(problems).toEqual([]);
    expect(asHttp(specs[0]).headers).toEqual({
      "X-1": "${secret:a-b}",
      "X-2": "${secret:1x}",
      "X-3": `\${secret:${tooLong}}`,
    });
  });

  it("C-10: a name that is an Object.prototype key is never resolved through the resolver's prototype", async () => {
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          proto: { url: "https://x", headers: { A: "${secret:__proto__}" } },
          ctor: { url: "https://x", headers: { A: "${secret:constructor}" } },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { secrets: secretsFrom({}) });
    expect(specs).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/secret '__proto__' is not set/);
    expect(problems.join("\n")).toMatch(/secret 'constructor' is not set/);
  });

  it("C-11: problems never contain a resolved value, even when another env var in the same entry is missing", async () => {
    vi.stubEnv("MISSING_ENV_NAME", undefined);
    const { fs } = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        mcpServers: {
          srv: {
            command: "node",
            env: { A: "${secret:S_OK}", B: "${env:MISSING_ENV_NAME}" },
          },
        },
      }),
    });
    const { specs, problems } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, {
      secrets: secretsFrom({ S_OK: "super-secret-value-123" }),
    });
    expect(specs).toEqual([]);
    expect(problems.join("\n")).not.toContain("super-secret-value-123");
    expect(problems.join("\n")).toMatch(/MISSING_ENV_NAME/);
  });
});

describe("collectSecretRefs (Taskana 4752, C-9)", () => {
  it("returns sorted unique names across env and headers, ignoring env refs and other fields", () => {
    const entries = {
      a: { command: "node", env: { X: "${secret:ZED}", Y: "${secret:ALPHA}", Z: "${env:HOME}" } },
      b: { url: "https://x", headers: { Authorization: "Bearer ${secret:ALPHA}", Other: "${secret:MID}" } },
      c: { command: "run-${secret:NOT_COUNTED}", args: ["${secret:NOT_COUNTED}"] },
    };
    expect(collectSecretRefs(entries)).toEqual(["ALPHA", "MID", "ZED"]);
  });

  it("returns an empty list when nothing is referenced", () => {
    expect(collectSecretRefs({ a: { command: "node", env: { X: "plain" } } })).toEqual([]);
  });
});

it("uses the discovered login PATH without inheriting unrelated environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-path-"));
  writeFileSync(join(dir, "launcher"), "#!/bin/sh\nprintf ok\n");
  chmodSync(join(dir, "launcher"), 0o755);
  vi.stubEnv("PATH", "/usr/bin:/bin");
  vi.stubEnv("MCP_PRIVATE_TEST", "private-value");
  const { fs } = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ mcpServers: { tool: { command: "launcher" } } }) });
  const { specs } = await loadMcpServerSpecs(fs, WORKSPACE, HOME, { loginPath: `${dir}:/usr/bin:/bin` });
  expect(asStdio(specs[0]).env.PATH).toBe(`${dir}:/usr/bin:/bin`);
  expect(spawnSync("launcher", [], { env: asStdio(specs[0]).env, encoding: "utf8" }).stdout).toBe("ok");
  rmSync(dir, { recursive: true, force: true });
  expect(asStdio(specs[0]).env.MCP_PRIVATE_TEST).toBeUndefined();
});
