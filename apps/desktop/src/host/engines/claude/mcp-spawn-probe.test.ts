import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpStdioServerSpec } from "@anycode/core";
import { describe, expect, it } from "vitest";
import {
  MCP_SPAWN_PROBE_KILL_GRACE_MS,
  MCP_SPAWN_PROBE_TIMEOUT_MS,
  createMcpSpawnProbeScheduler,
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

  it("redacts sensitive-named env values inherited from the host environment", async () => {
    // A crashing wrapper that dumps its environment: the inherited
    // MY_SERVICE_API_TOKEN was never in the spec's secretValues (the spec
    // only carries its own resolved ${...} values), yet it must not reach a
    // status row — the probe child receives the full host env.
    const previous = process.env.MY_SERVICE_API_TOKEN;
    process.env.MY_SERVICE_API_TOKEN = "host-inherited-token-value";
    try {
      const outcome = await probeMcpServerSpawn(
        stdio("envdump", {
          command: process.execPath,
          args: ["-e", "console.error(`dump token=${process.env.MY_SERVICE_API_TOKEN}`); process.exit(1)"],
        }),
        { timeoutMs: 2000 },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("token=[redacted]");
      expect(outcome.detail).not.toContain("host-inherited-token-value");
    } finally {
      if (previous === undefined) delete process.env.MY_SERVICE_API_TOKEN;
      else process.env.MY_SERVICE_API_TOKEN = previous;
    }
  });

  it("shuts a still-running launcher down with SIGTERM before SIGKILL", async () => {
    // The launcher traps SIGTERM, notes it, exits cleanly: a hard SIGKILL
    // would skip the trap and lose the marker file (and any mid-write state
    // a real server might own).
    const dir = mkdtempSync(join(tmpdir(), "mcp-probe-grace-"));
    const marker = join(dir, "terminated-gracefully");
    try {
      const outcome = await probeMcpServerSpawn(
        stdio("trapper", {
          command: process.execPath,
          args: [
            "-e",
            `const { writeFileSync } = require("node:fs");
             process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "yes"); process.exit(0); });
             setInterval(() => {}, 1000);`,
          ],
        }),
        { timeoutMs: 300 },
      );
      expect(outcome).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, MCP_SPAWN_PROBE_KILL_GRACE_MS + 300));
      expect(readFileSync(marker, "utf8")).toBe("yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes the default timeout as a bounded constant", () => {
    expect(MCP_SPAWN_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});

describe("createMcpSpawnProbeScheduler — once per boot, never overlapping (real path: two inits in a row)", () => {
  function deferredProbe() {
    let calls = 0;
    let release: (() => void) | undefined;
    const probe = (spec: McpStdioServerSpec): Promise<{ ok: boolean; detail?: string }> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ ok: false, detail: `probe-detail-for-${spec.name}` });
      });
    };
    return { probe, getCalls: () => calls, release: () => release!() };
  }

  it("probes a persistently failed server exactly once across repeated inits", async () => {
    const { probe, getCalls, release } = deferredProbe();
    const scheduler = createMcpSpawnProbeScheduler(probe);
    const spec = stdio("flaky");
    const details: string[] = [];
    // init 1..3 turn after turn, all reporting the same server as failed —
    // and init 2/3 fire BEFORE the first probe settled (overlapping inits).
    for (let i = 0; i < 3; i += 1) {
      scheduler.probe(spec, (outcome) => {
        if (!outcome.ok && outcome.detail !== undefined) details.push(outcome.detail);
      });
    }
    expect(getCalls()).toBe(1); // exactly one spawn across the three inits
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(details).toEqual(["probe-detail-for-flaky"]);
    // A LATER init after the probe settled must not re-probe either.
    scheduler.probe(spec, () => {});
    expect(getCalls()).toBe(1);
  });

  it("probes two different failed servers independently", async () => {
    const { probe, getCalls, release } = deferredProbe();
    const scheduler = createMcpSpawnProbeScheduler(probe);
    scheduler.probe(stdio("a"), () => {});
    scheduler.probe(stdio("b"), () => {});
    expect(getCalls()).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("a throwing probe run reports ok instead of manufacturing a cause", async () => {
    let calls = 0;
    const scheduler = createMcpSpawnProbeScheduler(() => {
      calls += 1;
      return Promise.reject(new Error("probe internals broke"));
    });
    const outcomes: boolean[] = [];
    scheduler.probe(stdio("broken"), (outcome) => outcomes.push(outcome.ok));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcomes).toEqual([true]);
    expect(calls).toBe(1);
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
