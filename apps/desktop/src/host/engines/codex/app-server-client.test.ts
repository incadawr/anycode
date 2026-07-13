import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AppServerClient,
  AppServerClientError,
  buildCodexChildEnv,
} from "./app-server-client.js";
import { EngineVersionError } from "./protocol.js";

const childPath = fileURLToPath(new URL("./test-child.mjs", import.meta.url));
const fixtureDir = mkdtempSync(join(tmpdir(), "anycode-codex-test-"));
const basicFixture = join(fixtureDir, "basic.jsonl");
writeFileSync(
  basicFixture,
  [
    { method: "turn/started", params: { threadId: "synthetic-thread", turn: { id: "synthetic-turn" } } },
    { method: "item/agentMessage/delta", params: { threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "message", delta: "SYNTHETIC_TEXT_OK" } },
    { method: "turn/completed", params: { threadId: "synthetic-thread", turn: { id: "synthetic-turn", status: "completed" } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n",
);

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function makeClient(args: string[] = [], overrides: Partial<ConstructorParameters<typeof AppServerClient>[0]> = {}) {
  return new AppServerClient({
    binaryPath: process.execPath,
    binaryArgs: [childPath, ...args],
    cwd: process.cwd(),
    sourceEnv: { HOME: "/home/test", PATH: process.env.PATH, CODEX_HOME: "/codex-home" },
    ...overrides,
  });
}

async function nextNotification(client: AppServerClient) {
  const iterator = client.notifications()[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done) throw new Error("notification stream closed unexpectedly");
  return result.value;
}

describe("AppServerClient", () => {
  it("preflights the pinned version and correlates JSON-RPC responses", async () => {
    const client = makeClient();
    try {
      await client.start();
      await expect(client.request("echo", { value: 7 })).resolves.toEqual({ value: 7 });
      expect(client.pid).toEqual(expect.any(Number));
    } finally {
      await client.close();
    }
  });

  it("fails closed for an unsupported or timed-out version", async () => {
    await expect(makeClient(["--bad-version"]).start()).rejects.toBeInstanceOf(EngineVersionError);
    await expect(makeClient(["--hang-version"], { versionTimeoutMs: 150 }).start()).rejects.toBeInstanceOf(EngineVersionError);
  });

  it("uses a safe JSON-RPC error for an unhandled server request", async () => {
    const client = makeClient();
    try {
      await client.start();
      client.notify("emit-server-request");
      const response = await nextNotification(client);
      expect(response).toMatchObject({
        method: "test/server-response",
        params: { id: 88, error: { code: -32001 } },
      });
    } finally {
      await client.close();
    }
  });

  it("does not leave a server request parked when a handler returns unsettled", async () => {
    const client = makeClient([], { onServerRequest: () => {} });
    try {
      await client.start();
      client.notify("emit-server-request");
      await expect(nextNotification(client)).resolves.toMatchObject({
        method: "test/server-response",
        params: { id: 88, error: { code: -32001 } },
      });
    } finally {
      await client.close();
    }
  });

  it("recognizes and safely settles a server request with a string JSON-RPC id", async () => {
    const client = makeClient();
    try {
      await client.start();
      client.notify("emit-server-request-string");
      await expect(nextNotification(client)).resolves.toMatchObject({
        method: "test/server-response",
        params: { id: "request-88", error: { code: -32001 } },
      });
    } finally {
      await client.close();
    }
  });

  it("keeps a server responder open until an async handler settles", async () => {
    let release!: () => void;
    const decision = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = makeClient([], {
      onServerRequest: async (_request, respond) => {
        await decision;
        respond.result({ decision: "accept" });
      },
    });
    try {
      await client.start();
      client.notify("emit-server-request");
      const pendingResponse = nextNotification(client);
      await Promise.resolve();
      release();
      await expect(pendingResponse).resolves.toMatchObject({
        method: "test/server-response",
        params: { id: 88, result: { decision: "accept" } },
      });
    } finally {
      await client.close();
    }
  });

  it("enforces pending-request and malformed/oversized-frame bounds", async () => {
    const pending = makeClient([], { maxPendingRequests: 2 });
    try {
      await pending.start();
      void pending.request("never-replied").catch(() => {});
      void pending.request("never-replied").catch(() => {});
      await expect(pending.request("never-replied")).rejects.toBeInstanceOf(AppServerClientError);
    } finally {
      await pending.close();
    }

    for (const args of [["--malformed"], ["--oversize"]]) {
      const client = makeClient(args, { maxLineBytes: 1_024 });
      try {
        await client.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(client.request("echo", {})).rejects.toBeInstanceOf(AppServerClientError);
      } finally {
        await client.close();
      }
    }
  });

  it("replays synthetic JSONL notifications without interpreting them", async () => {
    const client = makeClient([`--fixture=${basicFixture}`]);
    try {
      await client.start();
      const iterator = client.notifications()[Symbol.asyncIterator]();
      let text = "";
      let completed = false;
      for (let i = 0; i < 40 && !completed; i += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.method === "item/agentMessage/delta") {
          text += (next.value.params as { delta: string }).delta;
        }
        completed = next.value.method === "turn/completed";
      }
      expect(text).toBe("SYNTHETIC_TEXT_OK");
      expect(completed).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("passes only the explicit Codex environment allowlist", async () => {
    const env = buildCodexChildEnv({
      HOME: "/home/test",
      PATH: "/bin",
      CODEX_HOME: "/codex",
      HTTPS_PROXY: "https://proxy",
      SSL_CERT_FILE: "/cert.pem",
      ANYCODE_API_KEY: "must-not-pass",
      UNRELATED_SECRET: "must-not-pass",
    });
    expect(env).toMatchObject({ HOME: "/home/test", PATH: "/bin", CODEX_HOME: "/codex", HTTPS_PROXY: "https://proxy" });
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBeUndefined();

    const client = makeClient(["--env"], { sourceEnv: env });
    try {
      await client.start();
      const notification = await nextNotification(client);
      const childEnv = notification.params as NodeJS.ProcessEnv;
      expect(childEnv.CODEX_HOME).toBe("/codex");
      expect(childEnv.ANYCODE_API_KEY).toBeUndefined();
      expect(childEnv.UNRELATED_SECRET).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("adopts direct-child disposal before the caller can initialize", async () => {
    const bootstrap = { id: "core" as const, adopt: vi.fn(), dispose: vi.fn(async () => {}) };
    const client = makeClient([], { bootstrap });
    try {
      await client.start();
      expect(bootstrap.adopt).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  });

  it("reports only the dedicated POSIX app-server group with host generation proof", async () => {
    const report = vi.fn();
    const client = makeClient([], { processOwnership: { hostPid: 4242, generation: 7, report } });
    try {
      await client.start();
      if (process.platform === "win32") {
        expect(report).not.toHaveBeenCalled();
      } else {
        expect(report).toHaveBeenCalledWith(expect.objectContaining({
          type: "anycode:engine-process",
          hostPid: 4242,
          generation: 7,
          enginePid: client.pid,
          pgid: client.pid,
        }));
      }
    } finally {
      await client.close();
    }
  });

  // W2-review High: a live Codex process that closes fd 0 makes the NEXT write
  // raise an asynchronous EPIPE on the parent's stdin socket. With no `error`
  // listener on that stream, Node escalates it to an unhandled stream error and
  // terminates the HOST process. Pre-fix this test kills the vitest worker with
  // an unhandled EPIPE; post-fix the dead pipe is just a bounded RPC failure.
  it("survives a child that closes stdin while a request is in flight", async () => {
    const client = makeClient(["--close-stdin"]);
    try {
      await client.start();
      const marker = await nextNotification(client);
      expect(marker.method).toBe("test/stdin-closed");

      await expect(client.request("echo", { ping: true }, { timeoutMs: 2_000 })).rejects.toThrow(AppServerClientError);
      // The failure must be the pipe itself, not the request deadline quietly
      // expiring while the process dies underneath it.
      await expect(client.request("echo", { ping: true }, { timeoutMs: 2_000 })).rejects.toThrow(/stdin/i);
    } finally {
      await client.close();
    }
  });

  // W2-review High: preflight runs BEFORE any long-lived client exists, so a
  // grandchild it strands can never be reaped by the client's later group
  // teardown. It must own a process group of its own.
  it.skipIf(process.platform === "win32")("version preflight group-kills a wrapper's grandchild on timeout", async () => {
    const pidFile = join(fixtureDir, `preflight-${Date.now()}.pid`);
    const client = makeClient(["--version-grandchild", `--pid-file=${pidFile}`], { versionTimeoutMs: 500 });

    await expect(client.start()).rejects.toThrow(EngineVersionError);

    await waitForFile(pidFile);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    // Settle window (cut §2(l)): an instantaneous check catches the grandchild
    // mid-reap and flakes; "0 survivors" is asserted at the END of the window.
    const end = Date.now() + 5_000;
    while (alive(grandchildPid) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(alive(grandchildPid)).toBe(false);
  }, 15_000);

  it.skipIf(process.platform === "win32")("SIGKILL escalation reaps a stubborn dedicated child group", async () => {
    const pidFile = join(fixtureDir, `stubborn-${Date.now()}.pid`);
    const client = makeClient(["--stubborn-group", `--pid-file=${pidFile}`]);
    await client.start();
    await waitForFile(pidFile);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchildPid)).toBe(true);

    await client.close();
    const end = Date.now() + 1_500;
    while (alive(grandchildPid) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive(grandchildPid)).toBe(false);
  });
});
