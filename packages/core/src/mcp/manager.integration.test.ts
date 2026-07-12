/**
 * McpManager + a REAL stdio child (closes a residual orphan-proof gap, design
 * slice-3.2-cut.md §5.2). manager.test.ts proves the manager's logic
 * hermetically over InMemoryTransport.createLinkedPair() — zero real children.
 * adapters/node/node-mcp-transport.test.ts proves zero-orphans at the
 * TRANSPORT layer, but by calling `transport.close()` directly, never through
 * a manager. Neither proves that `McpManager.dispose()` ITSELF reaps a real
 * stdio child end-to-end through the manager's own start()/dispose()
 * lifecycle. This test closes that gap: the REAL `NodeMcpTransportFactory`
 * spawns the REAL `mcp/fixtures/fixture-server.mjs` child, `McpManager.start()`
 * connects it and registers its bridged tools, a live tool call runs against
 * the real process, and `McpManager.dispose()` must leave the child pid
 * ACTUALLY dead (`process.kill(pid, 0)` throws ESRCH) — not merely resolve a
 * promise.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { NodeMcpTransportFactory, NodeStdioMcpTransport } from "../adapters/node/node-mcp-transport.js";
import { ToolRegistry } from "../tools/registry.js";
import type { McpServerSpec, McpTransportFactory, McpWireTransport } from "../ports/mcp.js";
import type { ToolContext } from "../types/tools.js";
import { McpManager } from "./manager.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

// Pid-liveness helpers (mirror adapters/node/node-mcp-transport.test.ts).
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

/** Minimal explicit child env (mirrors what config.ts builds in 3.2.3; never process.env verbatim). */
function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
}

function ctx(): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/tmp",
    ports: {} as ToolContext["ports"],
  };
}

/**
 * Delegates to the REAL `NodeMcpTransportFactory` (the same factory production
 * code wires into the host) and captures the concrete `NodeStdioMcpTransport`
 * it returns, purely so the test can read its `.pid` test hook. The object
 * handed back to the manager is the real transport instance, unwrapped — no
 * delegating proxy is interposed between the SDK Client and the transport.
 */
class CapturingRealFactory implements McpTransportFactory {
  private readonly real = new NodeMcpTransportFactory();
  transport: NodeStdioMcpTransport | undefined;
  create(spec: McpServerSpec): McpWireTransport {
    const transport = this.real.create(spec);
    this.transport = transport as NodeStdioMcpTransport;
    return transport;
  }
}

describe("McpManager + real stdio child (manager-level dispose-reap)", () => {
  let manager: McpManager | undefined;

  afterEach(async () => {
    // Belt-and-suspenders: never leak a child out of a test.
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
  });

  it(
    "start() spawns a live real child; a real tool call succeeds; dispose() reaps it (zero orphans)",
    async () => {
      const registry = new ToolRegistry();
      const factory = new CapturingRealFactory();
      manager = new McpManager({ registry, transports: factory });

      const spec: McpServerSpec = {
        kind: "stdio",
        name: "fixture",
        command: process.execPath,
        args: [FIXTURE],
        env: baseEnv(),
      };
      await manager.start([spec]);

      const pid = factory.transport?.pid;
      expect(pid).toBeTruthy();
      expect(isPidAlive(pid!)).toBe(true);
      expect(manager.status()).toEqual([
        expect.objectContaining({ name: "fixture", state: "connected", toolCount: 6 }),
      ]);

      // The bridged tool actually round-trips through the real child, not a stub.
      const echo = registry.get("mcp__fixture__echo");
      expect(echo).toBeDefined();
      const result = await echo!.handler({ message: "real-child-hello" }, ctx());
      expect(result.ok).toBe(true);
      expect(result.output).toBe("real-child-hello");

      await manager.dispose();
      manager = undefined; // already disposed; afterEach becomes a no-op.

      await waitForDead(pid!);
      expect(isPidAlive(pid!)).toBe(false); // ZERO orphan: the MANAGER itself reaped the real child
    },
    20_000,
  );

  it(
    "bounds a stall-on-tools/list by the connect budget and reaps the stalled child (zero orphans)",
    async () => {
      const registry = new ToolRegistry();
      const factory = new CapturingRealFactory();
      // Shrink the connect budget so the test bounds tools/list in ~400ms instead
      // of the real 10s budget (and never the SDK's silent 60s per-page default).
      manager = new McpManager({ registry, transports: factory, connectTimeoutMs: 400 });

      const spec: McpServerSpec = {
        kind: "stdio",
        name: "staller",
        command: process.execPath,
        args: [FIXTURE, "--stall-list"],
        env: baseEnv(),
      };

      // The child spawns and `initialize` succeeds, then `tools/list` hangs forever;
      // poll the real transport's pid while the child is briefly alive, before the
      // connect-failure path closes the transport (which nulls the pid getter).
      let pid: number | null = null;
      const poll = setInterval(() => {
        const p = factory.transport?.pid;
        if (p != null) pid = p;
      }, 10);
      await manager.start([spec]);
      clearInterval(poll);

      // connect() REJECTED on the tools/list timeout -> server marked failed.
      const status = manager.status();
      expect(status[0]!.state).toBe("failed");
      expect(status[0]!.error).toMatch(/tools\/list timed out/i);
      expect(status[0]!.toolCount).toBe(0);
      expect(registry.list().some((n) => n.startsWith("mcp__staller__"))).toBe(false);

      // ...and the connect-failure path REAPED the stalled child: zero orphans.
      expect(pid).toBeTruthy();
      await waitForDead(pid!);
      expect(isPidAlive(pid!)).toBe(false);
    },
    20_000,
  );
});
