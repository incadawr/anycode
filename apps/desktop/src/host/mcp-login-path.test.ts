import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSpec, McpStdioServerSpec } from "@anycode/core";
import { describe, expect, it } from "vitest";
import {
  claudeMcpStatuses,
  codexMcpStatus,
  discoverLoginPath,
  forwardProblemStatuses,
  mcpProblemStatuses,
} from "./mcp-login-path.js";

function stdio(name: string, extra: Partial<McpStdioServerSpec> = {}): McpStdioServerSpec {
  return { kind: "stdio", name, command: "launcher", args: [], env: {}, ...extra };
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mcp-path-home-"));
}

describe("discoverLoginPath — GitHub #3 (a launcher outside the minimal GUI PATH)", () => {
  it.skipIf(process.platform === "win32")("reads a directory added by shell startup, not just the inherited PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-shell-"));
    try {
      writeFileSync(join(dir, ".zshrc"), 'export PATH="/startup-only/bin:$PATH"\n');
      const path = await discoverLoginPath({
        ...process.env,
        SHELL: "/bin/zsh",
        ZDOTDIR: dir,
        PATH: "/usr/bin:/bin",
      });
      expect(path?.split(":")).toContain("/startup-only/bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Pre-fix `discoverLoginPath` returned `undefined` outright when `SHELL` was
  // unset — which is exactly the Dock/Finder case (a GUI app inherits no SHELL).
  it("still resolves a PATH when SHELL is absent", async () => {
    const path = await discoverLoginPath({ HOME: process.env.HOME, PATH: "/usr/bin:/bin" });
    expect(typeof path).toBe("string");
    expect(path).not.toBe("");
  });

  // Pre-fix `discoverLoginPath` returned `undefined` whenever the shell could
  // not be run, so the loader fell back to the very minimal PATH that caused
  // the report: npx/uvx/node in a Homebrew/nvm/volta/asdf location stayed
  // unresolvable for every Dock-launched session.
  it("falls back to the conventional launcher directories when the shell cannot run", async () => {
    const home = freshHome();
    try {
      mkdirSync(join(home, ".nvm", "versions", "node", "v9.11.2", "bin"), { recursive: true });
      mkdirSync(join(home, ".nvm", "versions", "node", "v20.11.0", "bin"), { recursive: true });
      const path = await discoverLoginPath({
        SHELL: "/missing/shell",
        HOME: home,
        PATH: "/usr/bin:/bin",
      });
      const entries = path?.split(":") ?? [];
      expect(entries).toContain("/usr/bin");
      expect(entries).toContain("/opt/homebrew/bin");
      expect(entries).toContain(join(home, ".local/bin"));
      expect(entries).toContain(join(home, ".nvm", "versions", "node", "v20.11.0", "bin"));
      // Newest first: a later nvm version must win the PATH lookup.
      expect(entries.indexOf(join(home, ".nvm", "versions", "node", "v20.11.0", "bin"))).toBeLessThan(
        entries.indexOf(join(home, ".nvm", "versions", "node", "v9.11.2", "bin")),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("codexMcpStatus — Codex sessions surface forwarded-server failures (GitHub #3)", () => {
  const notification = (params: Record<string, unknown>) => ({ method: "mcpServer/startupStatus/updated", params });

  it("maps the protocol state onto a pane status row", () => {
    const specs = [stdio("docs")];
    expect(codexMcpStatus(notification({ name: "docs", status: "starting" }), specs)).toMatchObject({
      name: "docs",
      state: "connecting",
    });
    expect(codexMcpStatus(notification({ name: "docs", status: "ready" }), specs)).toMatchObject({
      name: "docs",
      state: "connected",
    });
    expect(codexMcpStatus(notification({ name: "docs", status: "cancelled" }), specs)).toMatchObject({
      name: "docs",
      state: "failed",
    });
  });

  it("redacts a secret the child printed in its startup error", () => {
    const specs = [stdio("broken", { secretValues: ["token123"] })];
    expect(
      codexMcpStatus(notification({ name: "broken", status: "failed", error: "spawn token123" }), specs),
    ).toMatchObject({ state: "failed", error: "spawn [redacted]" });
  });

  it("names re-authentication and falls back to a fixed reason", () => {
    const specs = [stdio("auth")];
    expect(codexMcpStatus(notification({ name: "auth", status: "failed", failureReason: "reauthenticationRequired" }), specs))
      .toMatchObject({ state: "failed", error: "the server needs re-authentication" });
    expect(codexMcpStatus(notification({ name: "auth", status: "failed" }), specs)).toMatchObject({
      state: "failed",
      error: "server startup failed",
    });
  });

  it("ignores other notifications and servers this host did not forward", () => {
    const specs = [stdio("docs")];
    expect(codexMcpStatus({ method: "account/updated", params: { name: "docs", status: "failed" } }, specs)).toBeUndefined();
    expect(codexMcpStatus(notification({ name: "foreign", status: "failed" }), specs)).toBeUndefined();
    expect(codexMcpStatus(notification({ status: "failed" }), specs)).toBeUndefined();
  });
});

describe("claudeMcpStatuses — Claude sessions surface forwarded-server failures (GitHub #3)", () => {
  it("maps reported statuses, including the failures Claude names", () => {
    const specs: McpServerSpec[] = [
      stdio("docs"),
      stdio("remote"),
      { kind: "http", name: "api", url: "https://example.test/mcp" },
    ];
    expect(
      claudeMcpStatuses(
        [
          { name: "docs", status: "connected" },
          { name: "remote", status: "failed" },
          { name: "api", status: "needs-auth" },
          { name: "unknown", status: null },
        ],
        [],
        specs,
      ),
    ).toEqual([
      { name: "docs", transport: "stdio", state: "connected", toolCount: 0, toolsTruncated: false },
      {
        name: "remote",
        transport: "stdio",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: "Claude reported this server as failed",
      },
      {
        name: "api",
        transport: "http",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: "Claude needs authentication for this server",
      },
      { name: "unknown", transport: "stdio", state: "connecting", toolCount: 0, toolsTruncated: false },
    ]);
  });

  // Pre-fix the CLI's silent omission of a server it could not start produced
  // no row at all.
  it("reports a forwarded server the CLI never mentions as failed", () => {
    expect(claudeMcpStatuses([], ["silent"], [stdio("silent")])).toEqual([
      {
        name: "silent",
        transport: "stdio",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: "Claude did not report this server",
      },
    ]);
  });
});

describe("mcpProblemStatuses — skipped config entries become visible rows (GitHub #3 gap 2)", () => {
  it("names the entry the loader skipped", () => {
    expect(mcpProblemStatuses(["MCP server 'broken' in config: invalid entry"])).toMatchObject([
      { name: "broken", state: "failed", error: expect.stringContaining("invalid entry") },
    ]);
  });

  it("keeps a file-level problem (bad JSON, untrusted folder) as its own row", () => {
    expect(mcpProblemStatuses(["Invalid JSON in MCP config /ws/.anycode/config.json"])).toMatchObject([
      { name: "MCP config", state: "failed", error: "Invalid JSON in MCP config /ws/.anycode/config.json" },
    ]);
  });
});

describe("forwardProblemStatuses — a serializer skip is visible too (GitHub #3)", () => {
  it("uses the controlled template, never a raw parser message", () => {
    expect(forwardProblemStatuses([{ kind: "unusable-entry", server: "odd" }])).toEqual([
      {
        name: "odd",
        transport: "stdio",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: 'MCP server "odd" is not a usable stdio or http server configuration and was skipped.',
      },
    ]);
  });
});
