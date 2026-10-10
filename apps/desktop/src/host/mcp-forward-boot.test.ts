/**
 * TASK.182 / Taskana 4136 — boot helper tests. Drives the REAL core loader
 * (loadMcpServerSpecs) over an in-memory FileSystemPort with sample
 * project/user/.mcp.json configs: stdio+http, ${env:VAR} substitutions,
 * headers, disabled entries, project shadowing — proving core-resolved
 * values reach BOTH serializers, two workspaces produce disjoint winners,
 * disabled/empty sets create no file, and malformed JSON / invalid schema
 * with SENTINEL secrets produce visible generic notices with the secret in
 * NEITHER the notices NOR the captured console output.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystemPort } from "@anycode/core";
import { makeTrustedScratchDir } from "../shared/test-scratch.js";
import { prepareEngineMcpForward } from "./engines/mcp-forward-boot.js";

type NoticeEvent = Extract<import("@anycode/core").AgentEvent, { type: "engine_notice" }>;
function noticeMessage(event: import("@anycode/core").AgentEvent): string {
  return (event as NoticeEvent).message;
}
import { mcpForwardFileMode } from "./engines/claude/mcp-forward-file.js";

const scratchDir = makeTrustedScratchDir("mcp-forward-boot");
const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function freshTmp(): string {
  const dir = mkdtempSync(join(scratchDir, "tmp-"));
  tmpDirs.push(dir);
  return dir;
}

/** In-memory FileSystemPort over a path → content map (missing path = absent file). */
function memFs(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: async () => {},
    stat: async () => { throw new Error("ENOENT"); },
    exists: async (path) => files[path] !== undefined,
    mkdir: async () => {},
    readdir: async () => [],
    rm: async () => {},
  };
}

function stdioEntry(command: string, env: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command, args: ["--serve"], env, ...extra };
}

const SECRET = "SUPER_SECRET_SENTINEL_XYZ";

describe("prepareEngineMcpForward — resolved values reach both serializers", () => {
  it("stdio+http with ${env:} substitution, headers, disabled entries, project shadowing", async () => {
    process.env.MCP_TEST_TOKEN = SECRET;
    const workspace = "/ws-a";
    const home = "/home/u";
    const files: Record<string, string> = {
      "/ws-a/.anycode/config.json": JSON.stringify({
        mcpServers: {
          // project stdio with env substitution — shadows the user's alpha
          alpha: stdioEntry("npx", { TOKEN: "${env:MCP_TEST_TOKEN}" }),
          // disabled project entry — winner, therefore disabled everywhere
          muted: { ...stdioEntry("npx", {}), enabled: false },
          // http with header substitution
          remote: { url: "https://remote.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
        },
      }),
      "/home/u/.anycode/config.json": JSON.stringify({
        mcpServers: {
          // SHADOWED by project alpha (different command) — must NOT win
          alpha: stdioEntry("shadowed-command", { MARKER: "user-layer" }),
          useronly: stdioEntry("node", { USER_VAR: "uv" }),
        },
      }),
      "/ws-a/.mcp.json": JSON.stringify({ mcpServers: {} }),
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace, home, tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    delete process.env.MCP_TEST_TOKEN;

    expect(prepared.claudeNames).toEqual(["alpha", "remote", "useronly"]);
    expect(prepared.codexNames).toEqual(["alpha", "remote", "useronly"]);

    // Claude: private file with the resolved token verbatim; muted absent.
    expect(prepared.claudeConfigPath).not.toBeNull();
    const doc = JSON.parse(readFileSync(prepared.claudeConfigPath!, "utf8")) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string>; cwd?: string }>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["alpha", "remote", "useronly"]);
    expect(doc.mcpServers.alpha!.command).toBe("npx"); // project won the shadow
    expect(doc.mcpServers.alpha!.env!.TOKEN).toBe(SECRET);
    expect(doc.mcpServers.remote).toEqual({ type: "http", url: "https://remote.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(doc.mcpServers.alpha!.cwd).toBeUndefined();
    expect(mcpForwardFileMode(prepared.claudeConfigPath!)).toBe(0o600);

    // Codex: same winners; headers renamed to http_headers.
    expect(prepared.codexServers).toMatchObject({
      remote: { url: "https://remote.example/mcp", http_headers: { Authorization: `Bearer ${SECRET}` } },
      useronly: { command: "node" },
    });

    // cleanupFile removes the file exactly once (idempotent).
    prepared.cleanupFile();
    prepared.cleanupFile();
    expect(existsSync(prepared.claudeConfigPath!)).toBe(false);
  });

  it("explicitly inherited env (inheritEnv:true) reaches both serializers verbatim", async () => {
    process.env.MCP_TEST_TOKEN = SECRET;
    const files: Record<string, string> = {
      "/ws-b/.anycode/config.json": JSON.stringify({
        mcpServers: { inherit: { ...stdioEntry("npx", { EXPLICIT: "yes" }), inheritEnv: true } },
      }),
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace: "/ws-b", home: "/home/u2", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    delete process.env.MCP_TEST_TOKEN;
    const doc = JSON.parse(readFileSync(prepared.claudeConfigPath!, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(doc.mcpServers.inherit!.env.MCP_TEST_TOKEN).toBe(SECRET); // inherited, resolved
    expect(doc.mcpServers.inherit!.env.EXPLICIT).toBe("yes");
    expect((prepared.codexServers!.inherit as { env: Record<string, string> }).env.MCP_TEST_TOKEN).toBe(SECRET);
  });

  it("two workspaces produce disjoint winners with no contamination", async () => {
    const mk = (ws: string, name: string): Record<string, string> => ({
      [`${ws}/.anycode/config.json`]: JSON.stringify({ mcpServers: { [name]: stdioEntry("npx", {}) } }),
    });
    const a = await prepareEngineMcpForward({ fs: memFs(mk("/ws-c", "only-c")), workspace: "/ws-c", home: "/home/u3", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"] });
    const b = await prepareEngineMcpForward({ fs: memFs(mk("/ws-d", "only-d")), workspace: "/ws-d", home: "/home/u3", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"] });
    expect(a.claudeNames).toEqual(["only-c"]);
    expect(b.claudeNames).toEqual(["only-d"]);
    expect(a.codexNames).toEqual(["only-c"]);
    expect(b.codexNames).toEqual(["only-d"]);
  });
});

describe("prepareEngineMcpForward — empty/disabled sets and controlled failures", () => {
  it("disabled and empty configs create no file and no config", async () => {
    const files: Record<string, string> = {
      "/ws-e/.anycode/config.json": JSON.stringify({ mcpServers: { off: { ...stdioEntry("npx", {}), enabled: false } } }),
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace: "/ws-e", home: "/home/u4", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    expect(prepared.claudeJson).toBeNull();
    expect(prepared.claudeConfigPath).toBeNull();
    expect(prepared.codexServers).toBeNull();
    expect(prepared.notices).toEqual([]); // disabled is silent by design
    prepared.cleanupFile(); // no-op, never throws
  });

  it("malformed JSON with a sentinel secret yields a generic notice with the secret in NO notice and NO console line", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files: Record<string, string> = {
      "/ws-f/.anycode/config.json": `{ "mcpServers": { "broken": "${SECRET}"`,
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace: "/ws-f", home: "/home/u5", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    expect(prepared.notices.length).toBeGreaterThanOrEqual(1);
    for (const notice of prepared.notices) {
      expect(noticeMessage(notice)).not.toContain(SECRET);
    }
    const captured = [...consoleSpy.mock.calls, ...consoleWarnSpy.mock.calls].flat().join(" ");
    expect(captured).not.toContain(SECRET);
  });

  it("invalid schema quoting a sentinel secret is likewise collapsed (no secret in notices)", async () => {
    const files: Record<string, string> = {
      "/ws-g/.anycode/config.json": JSON.stringify({ mcpServers: { broken: { command: "", args: "not-an-array", env: { X: SECRET } } } }),
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace: "/ws-g", home: "/home/u6", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    expect(prepared.claudeJson).toBeNull();
    expect(prepared.codexServers).toBeNull();
    // Loader problems surface even though every server was skipped/disabled.
    expect(prepared.notices.some((notice) => noticeMessage(notice).includes("could not be loaded"))).toBe(true);
    for (const notice of prepared.notices) {
      expect(noticeMessage(notice)).not.toContain(SECRET);
      expect(noticeMessage(notice)).not.toContain("zod");
    }
  });

  it("all-skipped Codex cases retain notices (cwd is fine for codex; reserved-ish names still notice for claude)", async () => {
    const files: Record<string, string> = {
      "/ws-h/.anycode/config.json": JSON.stringify({
        mcpServers: {
          anycode: stdioEntry("npx", {}), // reserved for claude; forwarded to codex
        },
      }),
    };
    const prepared = await prepareEngineMcpForward({
      fs: memFs(files), workspace: "/ws-h", home: "/home/u7", tmpDir: freshTmp(), pid: process.pid, engines: ["claude", "codex"],
    });
    expect(prepared.claudeJson).toBeNull(); // claude skipped the reserved name…
    expect(prepared.notices.some((notice) => noticeMessage(notice).includes("anycode"))).toBe(true); // …with a notice
    expect(prepared.codexServers).not.toBeNull(); // …while codex still got it
    expect(prepared.codexNames).toEqual(["anycode"]);
  });
});

// ── TASK.182 defect-3 fix: first-init reconciliation seam ──

describe("missingForwardedMcpServerNames (TASK.182 reconciliation)", () => {
  it("expects anycode when a bridge exists, and flags it missing when the CLI did not report it", async () => {
    const { missingForwardedMcpServerNames } = await import("./engines/mcp-forward-boot.js");
    // Bridge present, CLI reported only the forwarded server -> anycode missing.
    expect(missingForwardedMcpServerNames(["alpha"], ["alpha"], true)).toEqual(["anycode"]);
    // Bridge present, CLI reported both -> nothing missing.
    expect(missingForwardedMcpServerNames(["alpha", "anycode"], ["alpha"], true)).toEqual([]);
  });

  it("never expects anycode for a bridge-less boot (child), even when the CLI reports it", async () => {
    const { missingForwardedMcpServerNames } = await import("./engines/mcp-forward-boot.js");
    expect(missingForwardedMcpServerNames(["alpha"], ["alpha"], false)).toEqual([]);
    expect(missingForwardedMcpServerNames(["alpha", "anycode"], ["alpha"], false)).toEqual([]);
  });

  it("flags forwarded servers the CLI failed to start, by NAME only", async () => {
    const { missingForwardedMcpServerNames } = await import("./engines/mcp-forward-boot.js");
    expect(missingForwardedMcpServerNames(["beta"], ["alpha", "beta"], true)).toEqual(["alpha", "anycode"]);
    expect(missingForwardedMcpServerNames([], [], false)).toEqual([]);
  });
});
