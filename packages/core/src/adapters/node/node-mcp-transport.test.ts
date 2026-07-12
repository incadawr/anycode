/**
 * Node stdio MCP transport + hermetic fixture child (design slice-3.2-cut.md
 * §5.2 item 4). Proves connect->list->call over a real spawned child, the env
 * scrub (spec.env is verbatim; parent secrets do NOT leak), and — the whole
 * point — ZERO orphans after every child-death path: normal close, cancel
 * mid-call (server survives cancel), close during a live call, SIGTERM->SIGKILL
 * escalation (--ignore-sigterm), and the stdin-EOF residual boundary. Every case
 * asserts the child pid is ACTUALLY dead, not merely that a promise resolved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SIGKILL_GRACE_MS } from "../../types/config.js";
import type { McpStdioServerSpec } from "../../ports/mcp.js";
import { NodeStdioMcpTransport } from "./node-mcp-transport.js";

const FIXTURE = fileURLToPath(new URL("../../mcp/fixtures/fixture-server.mjs", import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function stdioSpec(env: Record<string, string>, extraArgs: string[] = []): McpStdioServerSpec {
  return { kind: "stdio", name: "fixture", command: process.execPath, args: [FIXTURE, ...extraArgs], env };
}

/** Minimal explicit child env (mirrors what config.ts builds in 3.2.3). */
function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
}

describe("NodeStdioMcpTransport + fixture child", () => {
  let openTransport: NodeStdioMcpTransport | undefined;

  afterEach(async () => {
    // Belt-and-suspenders: never leak a child out of a test.
    if (openTransport) {
      try {
        await openTransport.close();
      } catch {
        // ignore
      }
      openTransport = undefined;
    }
  });

  it(
    "connects, lists tools, calls echo, and leaves no orphan after close",
    async () => {
      const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv()));
      openTransport = transport;
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(transport);

      const pid = transport.pid;
      expect(pid).not.toBeNull();
      expect(isPidAlive(pid!)).toBe(true);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["big", "echo", "env_probe", "fail", "schema_rich", "slow"]);

      // schema_rich passes its nested/required/enum schema through verbatim.
      const rich = tools.tools.find((t) => t.name === "schema_rich")!;
      expect(rich.inputSchema.type).toBe("object");
      expect(rich.inputSchema.required).toContain("title");

      const echo = await client.callTool({ name: "echo", arguments: { message: "hi-there" } });
      expect((echo.content as { type: string; text: string }[])[0]!.text).toBe("hi-there");

      await transport.close();
      openTransport = undefined;
      await waitForDead(pid!);
      expect(isPidAlive(pid!)).toBe(false); // ZERO orphan
    },
    20_000,
  );

  it(
    "passes spec.env verbatim: parent ANYCODE_API_KEY is ABSENT in the child, PATH present",
    async () => {
      const prior = process.env.ANYCODE_API_KEY;
      process.env.ANYCODE_API_KEY = "super-secret-should-not-leak";
      try {
        const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv()));
        openTransport = transport;
        const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
        await client.connect(transport);
        const pid = transport.pid!;

        const probe = await client.callTool({ name: "env_probe", arguments: {} });
        const childEnv = JSON.parse((probe.content as { type: string; text: string }[])[0]!.text) as Record<string, string>;

        // The transport must NEVER merge process.env — the ONLY scrub line in the CLI.
        expect(childEnv.ANYCODE_API_KEY).toBeUndefined();
        expect(childEnv.PATH).toBe(process.env.PATH);

        await transport.close();
        openTransport = undefined;
        await waitForDead(pid);
        expect(isPidAlive(pid)).toBe(false);
      } finally {
        if (prior === undefined) delete process.env.ANYCODE_API_KEY;
        else process.env.ANYCODE_API_KEY = prior;
      }
    },
    20_000,
  );

  it(
    "cancels a live slow call via AbortSignal (server SURVIVES cancel; no orphan after close)",
    async () => {
      const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv()));
      openTransport = transport;
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(transport);
      const pid = transport.pid!;

      const controller = new AbortController();
      const callPromise = client.callTool({ name: "slow", arguments: { ms: 60_000 } }, undefined, {
        signal: controller.signal,
      });
      // Let the request reach the server, then cancel it.
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();
      await expect(callPromise).rejects.toBeDefined();

      // Cancel is NOT kill: the server process is still alive after the abort.
      expect(isPidAlive(pid)).toBe(true);

      await transport.close();
      openTransport = undefined;
      await waitForDead(pid);
      expect(isPidAlive(pid)).toBe(false);
    },
    20_000,
  );

  it(
    "close during a live slow call reaps the child within the deadline (no orphan)",
    async () => {
      const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv()));
      openTransport = transport;
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(transport);
      const pid = transport.pid!;

      // Fire a long call and DO NOT await it; then close while it is in flight.
      void client.callTool({ name: "slow", arguments: { ms: 60_000 } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));

      const started = Date.now();
      await transport.close();
      openTransport = undefined;
      await waitForDead(pid);
      expect(isPidAlive(pid)).toBe(false);
      // SIGTERM is honored by the default fixture -> well under the 2s dispose deadline.
      expect(Date.now() - started).toBeLessThan(2_000);
    },
    20_000,
  );

  it(
    "escalates SIGTERM->SIGKILL for a --ignore-sigterm child and confirms the pid is dead",
    async () => {
      const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv(), ["--ignore-sigterm"]));
      openTransport = transport;
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await client.connect(transport);
      const pid = transport.pid!;
      expect(isPidAlive(pid)).toBe(true);

      const started = Date.now();
      await transport.close();
      openTransport = undefined;
      await waitForDead(pid);
      const elapsed = Date.now() - started;

      expect(isPidAlive(pid)).toBe(false); // SIGKILL reaped the stubborn child
      // Evidence the escalation actually ran: SIGTERM was ignored, so close could
      // only return after waiting out the SIGKILL grace period.
      expect(elapsed).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS - 100);
    },
    20_000,
  );

  it(
    "residual boundary: the fixture exits on stdin EOF with no signal delivered",
    async () => {
      // Spawn directly (NOT through the transport) so NO SIGTERM/SIGKILL is sent —
      // only the stdin pipe is closed. Proves the SDK-server-exits-on-EOF

      const child = spawn(process.execPath, [FIXTURE], {
        env: baseEnv(),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pid = child.pid!;
      await new Promise<void>((resolve, reject) => {
        child.on("spawn", () => resolve());
        child.on("error", reject);
      });
      expect(isPidAlive(pid)).toBe(true);

      const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      child.stdin!.end(); // EOF, no signal
      const code = await Promise.race([
        closed,
        new Promise<number | null>((_, reject) => setTimeout(() => reject(new Error("did not exit on stdin EOF")), 5_000)),
      ]);
      expect(code).toBe(0);
      await waitForDead(pid);
      expect(isPidAlive(pid)).toBe(false);
    },
    20_000,
  );

  it("rejects a double start()", async () => {
    const transport = new NodeStdioMcpTransport(stdioSpec(baseEnv()));
    openTransport = transport;
    await transport.start();
    await expect(transport.start()).rejects.toThrow(/already started/);
  });
});
