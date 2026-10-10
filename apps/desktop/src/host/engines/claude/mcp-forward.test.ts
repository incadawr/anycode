/**
 * TASK.182 / Taskana 4136 — MCP forward serializer + diagnostic tests.
 * Pins the grammar and skip rules for BOTH engine serializers against
 * core-resolved specs (stdio+http, env/headers, disabled entries and project
 * shadowing are exercised end-to-end through the real core loader in
 * mcp-forward-boot.test.ts; here the RESOLVED values are pinned directly).
 */
import { describe, expect, it } from "vitest";
import type { McpHttpServerSpec, McpServerSpec, McpStdioServerSpec } from "@anycode/core";
import { buildClaudeMcpForwardDocument } from "./mcp-forward.js";
import { buildCodexThreadMcpServers } from "../codex/mcp-thread-config.js";
import { mcpForwardLoaderNotices, mcpForwardProblemNotice } from "../mcp-forward-diagnostic.js";

type NoticeEvent = Extract<import("@anycode/core").AgentEvent, { type: "engine_notice" }>;
function noticeMessage(event: import("@anycode/core").AgentEvent): string {
  return (event as NoticeEvent).message;
}

function stdio(name: string, overrides: Partial<McpStdioServerSpec> = {}): McpStdioServerSpec {
  return { kind: "stdio", name, command: "npx", args: ["-y", `${name}-server`], env: { A: `${name}-a` }, ...overrides };
}

function http(name: string, overrides: Partial<McpHttpServerSpec> = {}): McpHttpServerSpec {
  return { kind: "http", name, url: `https://${name}.example/mcp`, ...overrides };
}

describe("buildClaudeMcpForwardDocument", () => {
  it("serializes stdio as {command,args,env} with resolved env verbatim (including inherited keys)", () => {
    const env = { PATH: "/bin", ANYCODE_FLAG: "carried-by-file", SECRET_TOKEN: "s3cret" };
    const result = buildClaudeMcpForwardDocument([stdio("alpha", { env })]);
    expect(result.names).toEqual(["alpha"]);
    const doc = JSON.parse(result.json!) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers.alpha).toEqual({ command: "npx", args: ["-y", "alpha-server"], env });
  });

  it("serializes http as {type:'http',url,headers?} without stdio keys", () => {
    const result = buildClaudeMcpForwardDocument([http("beta", { headers: { Authorization: "Bearer tok" } })]);
    const doc = JSON.parse(result.json!) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers.beta).toEqual({ type: "http", url: "https://beta.example/mcp", headers: { Authorization: "Bearer tok" } });
  });

  it("skips a stdio server with configured cwd with a controlled notice (Claude ignores MCP cwd)", () => {
    const result = buildClaudeMcpForwardDocument([stdio("cwid", { cwd: "/elsewhere" }), stdio("ok")]);
    expect(result.names).toEqual(["ok"]);
    expect(result.problems).toEqual([{ kind: "claude-cwd-unsupported", server: "cwid" }]);
  });

  it("skips the reserved anycode name with a notice", () => {
    const result = buildClaudeMcpForwardDocument([stdio("anycode"), http("kept")]);
    expect(result.names).toEqual(["kept"]);
    expect(result.problems).toEqual([{ kind: "reserved-name", server: "anycode" }]);
  });

  it("skips dangerous object keys (__proto__ server name or env key) with notices", () => {
    // A literal `{__proto__: "x"}` sets the PROTOTYPE, not an own key — V8
    // never surfaces it to Object.keys. Reflect.defineProperty with
    // enumerable:true makes it a REAL own key the serializer must refuse.
    const forcedEnv = JSON.parse('{"A":"1"}') as Record<string, string>;
    Reflect.defineProperty(forcedEnv, "__proto__", { value: "x", enumerable: true });
    expect(Object.keys(forcedEnv)).toContain("__proto__");
    const result = buildClaudeMcpForwardDocument([
      stdio("__proto__"),
      stdio("badenv", { env: forcedEnv }),
      http("fine"),
    ]);
    expect(result.names).toEqual(["fine"]);
    expect(result.problems.every((problem) => problem.kind === "dangerous-key")).toBe(true);
    expect(result.problems).toHaveLength(2);
  });

  it("returns null json when every server was skipped or the input is empty", () => {
    expect(buildClaudeMcpForwardDocument([]).json).toBeNull();
    expect(buildClaudeMcpForwardDocument([stdio("anycode")]).json).toBeNull();
    expect(buildClaudeMcpForwardDocument([stdio("anycode")]).names).toEqual([]);
  });
});

describe("buildCodexThreadMcpServers", () => {
  it("maps stdio to {command,args,env,cwd?} preserving resolved env and cwd", () => {
    const result = buildCodexThreadMcpServers([stdio("alpha", { cwd: "/srv/alpha", env: { TOKEN: "t", INHERITED: "yes" } })]);
    expect(result.servers).toEqual({
      alpha: { command: "npx", args: ["-y", "alpha-server"], env: { TOKEN: "t", INHERITED: "yes" }, cwd: "/srv/alpha" },
    });
    expect(result.names).toEqual(["alpha"]);
  });

  it("maps http to {url,http_headers?} — RENAMES core headers to http_headers", () => {
    const result = buildCodexThreadMcpServers([http("beta", { headers: { Authorization: "Bearer tok" } }), http("bare")]);
    expect(result.servers).toEqual({
      beta: { url: "https://beta.example/mcp", http_headers: { Authorization: "Bearer tok" } },
      bare: { url: "https://bare.example/mcp" },
    });
  });

  it("never emits a top-level headers key for http servers", () => {
    const result = buildCodexThreadMcpServers([http("beta", { headers: { H: "v" } })]);
    expect(Object.keys(result.servers!.beta!)).not.toContain("headers");
  });

  it("skips dangerous map keys with notices; empty survivors return null", () => {
    const forcedEnv = JSON.parse('{"A":"1"}') as Record<string, string>;
    Reflect.defineProperty(forcedEnv, "__proto__", { value: "x", enumerable: true });
    const all = buildCodexThreadMcpServers([
      stdio("__proto__"),
      stdio("badenv", { env: forcedEnv }),
    ]);
    expect(all.servers).toBeNull();
    expect(all.problems.every((problem) => problem.kind === "dangerous-key")).toBe(true);
    expect(buildCodexThreadMcpServers([]).servers).toBeNull();
  });

  it("keeps notices even when the map is empty (all-skipped case)", () => {
    const result = buildCodexThreadMcpServers([stdio("constructor")]);
    expect(result.servers).toBeNull();
    expect(result.problems).toHaveLength(1);
    const notices = result.problems.map(mcpForwardProblemNotice);
    expect(notices.every((notice) => notice.type === "engine_notice" && notice.level === "warning")).toBe(true);
  });
});

describe("mcp-forward-diagnostic — controlled templates only", () => {
  it("loader failures collapse to ONE fixed generic warning, never quoting loader strings", () => {
    const notices = mcpForwardLoaderNotices({ problemCount: 3 });
    expect(notices).toHaveLength(1);
    expect(noticeMessage(notices[0]!)).toBe("Some configured MCP servers could not be loaded and were skipped (3 problems).");
    expect(mcpForwardLoaderNotices({ problemCount: 0 })).toEqual([]);
    expect(mcpForwardLoaderNotices(null)).toEqual([]);
  });

  it("serializer warnings name server and field/reason only — no values, no paths", () => {
    const notice = mcpForwardProblemNotice({ kind: "claude-cwd-unsupported", server: "alpha" });
    expect(noticeMessage(notice)).toContain("alpha");
    expect(noticeMessage(notice)).not.toContain("/elsewhere");
    expect(noticeMessage(notice)).not.toContain("log");
    expect(noticeMessage(notice)).not.toMatch(/\/(home|Users|tmp)\//);
  });

  it("problem notices never embed config values from any category", () => {
    for (const problem of [
      { kind: "reserved-name", server: "anycode" },
      { kind: "dangerous-key", server: "alpha" },
      { kind: "unusable-entry", server: "alpha" },
      { kind: "claude-cwd-unsupported", server: "alpha" },
    ] as const) {
      const notice = mcpForwardProblemNotice(problem);
      expect(notice.type).toBe("engine_notice");
      expect(noticeMessage(notice)).not.toMatch(/token|secret|Bearer|s3cret/i);
    }
  });
});
