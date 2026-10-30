import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpStdioServerSpec } from "@anycode/core";
import { describe, expect, it } from "vitest";
import {
  MCP_SPAWN_PROBE_TIMEOUT_MS,
  formatMcpSpawnProbeFailure,
  probeMcpServerSpawn,
  stderrTail,
} from "./mcp-spawn-probe.js";

function stdio(name: string, extra: Partial<McpStdioServerSpec> = {}): McpStdioServerSpec {
  return { kind: "stdio", name, command: "launcher", args: [], env: {}, ...extra };
}

describe("probeMcpServerSpawn — the definitive cause for a Claude-side MCP failure (GitHub #3)", () => {
  it("reports a spawn error for a launcher that does not exist", async () => {
    const outcome = await probeMcpServerSpawn(stdio("ghost", { command: "anycode-no-such-launcher" }), { timeoutMs: 2000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/probe could not run the server command:.*anycode-no-such-launcher/);
  });

  it("reports exit code and a stderr tail for a launcher that dies immediately", async () => {
    const outcome = await probeMcpServerSpawn(
      stdio("crashy", { command: process.execPath, args: ["-e", "console.error('boom from server'); process.exit(3)"] }),
      { timeoutMs: 2000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("exited with code 3");
    expect(outcome.detail).toContain("boom from server");
  });

  it("reports the signal for a launcher killed by one", async () => {
    const outcome = await probeMcpServerSpawn(
      stdio("signalled", { command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"] }),
      { timeoutMs: 2000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("signal SIGTERM");
  });

  it("treats a still-running launcher as ok with no detail (the command runs)", async () => {
    const outcome = await probeMcpServerSpawn(stdio("healthy", { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }), {
      timeoutMs: 300,
    });
    expect(outcome).toEqual({ ok: true });
    expect(outcome.detail).toBeUndefined();
  });

  it("runs the launcher through the login PATH and the spec env", async () => {
    // A shell script in a probe-only directory, NOT on the default PATH: the
    // probe must find it via loginPath and see the spec's env var.
    const dir = mkdtempSync(join(tmpdir(), "mcp-probe-bin-"));
    try {
      const script = join(dir, "anycode-probe-only-launcher");
      writeFileSync(script, `#!/bin/sh\nif [ "$ANYCODE_PROBE_ENV" = "yes" ]; then\n  echo "env ok" >&2\nfi\nexit 7\n`);
      chmodSync(script, 0o755);
      const outcome = await probeMcpServerSpawn(
        stdio("pathfind", { command: "anycode-probe-only-launcher", env: { ANYCODE_PROBE_ENV: "yes" } }),
        { loginPath: dir, timeoutMs: 2000 },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("exited with code 7");
      expect(outcome.detail).toContain("env ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts the spec's secret values out of the stderr tail", async () => {
    const outcome = await probeMcpServerSpawn(
      stdio("leaky", {
        command: process.execPath,
        args: ["-e", "console.error('token=hunter2secret'); process.exit(1)"],
        secretValues: ["hunter2secret"],
      }),
      { timeoutMs: 2000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("token=[redacted]");
    expect(outcome.detail).not.toContain("hunter2secret");
  });

  it("exposes the default timeout as a bounded constant", () => {
    expect(MCP_SPAWN_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("formatMcpSpawnProbeFailure / stderrTail — pure shaping", () => {
  it("bounds the tail to the last few non-empty lines", () => {
    const many = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
    const tail = stderrTail(many);
    expect(tail.split("\n")).toHaveLength(8);
    expect(tail).toContain("line-49");
    expect(tail).not.toContain("line-0");
  });

  it("keeps a spawn-error message even with empty stderr", () => {
    expect(formatMcpSpawnProbeFailure({ kind: "spawn-error", message: "ENOENT" }, "", [])).toBe(
      "probe could not run the server command: ENOENT",
    );
  });
});
