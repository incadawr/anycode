/**
 * client.test.ts (slice 6.1 B7): LspClient against the REAL fake-lsp-server
 * fixture via NodeExecutionAdapter.spawnPersistent — the exact spawn path the
 * manager uses. Covers the initialize/didOpen/waitForPublish happy path, the
 * clean-file empty publish, the bounded init handshake (short-deadline proof of
 * the init-timeout mechanism), URI-encoding round-trip (§6#9), no-shell argv
 * injection (§6#10), version-preferred stale-publish (§6#11), protocol-error
 * death on garbage, teardown reaping incl. SIGKILL escalation and grandchild
 * pgid-reap (§6#1/#2), and death-settles-a-pending-waiter.
 *
 * NOTE: importing NodeExecutionAdapter here is the test harness, not a

 * themselves, which spawn only through the injected ExecutionPort.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { LspClient, pathToFileUri } from "./client.js";
import { encodeMessage } from "./jsonrpc.js";
import { LSP_SHUTDOWN_GRACE_MS, SIGKILL_GRACE_MS } from "../types/config.js";
import type { PersistentChildHandle } from "../ports/execution.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp-server.cjs", import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function waitPidDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

interface Spawned {
  client: LspClient;
  handle: PersistentChildHandle;
  protocolErrors: Error[];
  exited: () => boolean;
}

describe("LspClient (fixture integration)", () => {
  const adapter = new NodeExecutionAdapter();
  const handles: PersistentChildHandle[] = [];
  let tmpDir: string;

  afterEach(async () => {
    await Promise.all(handles.map((h) => h.kill()));
    handles.length = 0;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  function spawnClient(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Spawned {
    const protocolErrors: Error[] = [];
    let exitedFlag = false;
    let client!: LspClient;
    const handle = adapter.spawnPersistent!({
      file: process.execPath,
      args: [FIXTURE, ...args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      onStdout: (chunk) => client.receive(chunk),
      onStderr: () => {},
      onExit: () => {
        exitedFlag = true;
        client.handleExit();
      },
    });
    handles.push(handle);
    client = new LspClient(handle, {
      rootPath: opts.cwd ?? process.cwd(),
      processId: process.pid,
      onProtocolError: (error) => protocolErrors.push(error),
    });
    return { client, handle, protocolErrors, exited: () => exitedFlag };
  }

  it(
    "initializes, opens a document with a DIAG marker, and reports an error diagnostic at the right line",
    async () => {
      const { client } = spawnClient([]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);

      const uri = pathToFileUri("/proj/sample.ts");
      const sent = client.didOpen(uri, "typescript", "clean line\nDIAG:boom here\nanother\n");
      const diags = await client.waitForPublish(uri, {
        afterSeq: sent.seq,
        preferVersion: sent.version,
        deadline: Date.now() + 3000,
      });
      expect(diags).not.toBeNull();
      expect(diags).toHaveLength(1);
      expect(diags![0]!.severity).toBe("error");
      expect(diags![0]!.line).toBe(2); // DIAG on the 2nd line (1-based)
      expect(diags![0]!.message).toBe("boom here");
      expect(diags![0]!.source).toBe("fake-lsp");
    },
    15_000,
  );

  it(
    "reports an empty publish for clean text (the 'file is clean' signal)",
    async () => {
      const { client } = spawnClient([]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      const uri = pathToFileUri("/proj/clean.ts");
      const first = client.didOpen(uri, "typescript", "DIAG:has error\n");
      const withErr = await client.waitForPublish(uri, {
        afterSeq: first.seq,
        preferVersion: first.version,
        deadline: Date.now() + 3000,
      });
      expect(withErr).toHaveLength(1);

      const cleaned = client.didChange(uri, "no markers now\njust code\n");
      const diags = await client.waitForPublish(uri, {
        afterSeq: cleaned.seq,
        preferVersion: cleaned.version,
        deadline: Date.now() + 3000,
      });
      expect(diags).toEqual([]);
    },
    15_000,
  );

  it(
    "bounds the initialize handshake: a non-replying server fails fast at the deadline (not 15s)",
    async () => {
      const { client } = spawnClient(["--no-init-reply"]);
      const t0 = Date.now();
      expect(await client.initialize(Date.now() + 400)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2500);
    },
    10_000,
  );

  it(
    "attributes a publish through a URI with a space and non-ASCII characters (percent-encoding round-trip, §6#9)",
    async () => {
      const { client } = spawnClient([]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      // Path the fixture echoes back verbatim; normalizeUri must round-trip it.
      const uri = pathToFileUri("/proj/a dir/café DIAG note.ts");
      const sent = client.didOpen(uri, "typescript", "line0\nDIAG:unicode-ok\n");
      const diags = await client.waitForPublish(uri, {
        afterSeq: sent.seq,
        preferVersion: sent.version,
        deadline: Date.now() + 3000,
      });
      expect(diags).not.toBeNull();
      expect(diags).toHaveLength(1);
      expect(diags![0]!.message).toBe("unicode-ok");
    },
    15_000,
  );

  it(
    "prefers the current version over a stale publish in the same window (§6#11)",
    async () => {
      const { client } = spawnClient(["--stale-then-current"]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      const uri = pathToFileUri("/proj/staged.ts");
      const sent = client.didOpen(uri, "typescript", "irrelevant\n");
      const diags = await client.waitForPublish(uri, {
        afterSeq: sent.seq,
        preferVersion: sent.version,
        deadline: Date.now() + 3000,
      });
      expect(diags).not.toBeNull();
      expect(diags).toHaveLength(1);
      // STALE is at line 1, CURRENT at line 2 — version-preference must pick CURRENT.
      expect(diags![0]!.message).toBe("CURRENT");
      expect(diags![0]!.line).toBe(2);
    },
    15_000,
  );

  it(
    "passes injection-shaped argv verbatim (no shell): metacharacter args create no files (§6#10)",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-lsp-inj-"));
      const argvFile = join(tmpDir, "argv.json");
      const pwnedMarker = join(tmpDir, "pwned");
      const xFile = join(tmpDir, "x");
      writeFileSync(xFile, "keep-me");
      const injection1 = `; rm -rf ${xFile}`;
      const injection2 = `$(touch ${pwnedMarker})`;

      const { handle } = spawnClient(["--echo-argv", injection1, injection2], {
        env: { FIXTURE_ARGV_FILE: argvFile },
      });

      expect(await waitFor(() => existsSync(argvFile), 5000)).toBe(true);
      const argv = JSON.parse(readFileSync(argvFile, "utf-8"));
      expect(argv).toEqual(["--echo-argv", injection1, injection2]);
      // A shell would have deleted x and created pwned; execve got literal bytes.
      expect(existsSync(pwnedMarker)).toBe(false);
      expect(existsSync(xFile)).toBe(true);
      await handle.kill();
    },
    15_000,
  );

  it(
    "surfaces a protocol error and dies on a garbage stream (init rejected, client dead)",
    async () => {
      const { client, protocolErrors } = spawnClient(["--garbage"]);
      expect(await client.initialize(Date.now() + 3000)).toBe(false);
      expect(await waitFor(() => protocolErrors.length > 0, 3000)).toBe(true);
      expect(client.isDead).toBe(true);
    },
    10_000,
  );

  it(
    "shutdownAndExit reaps a compliant server politely (pid ESRCH, bounded)",
    async () => {
      const { client, handle } = spawnClient([]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      const pid = handle.pid!;
      expect(isPidAlive(pid)).toBe(true);
      await client.shutdownAndExit(Date.now() + LSP_SHUTDOWN_GRACE_MS);
      expect(await waitPidDead(pid, 5000)).toBe(true);
    },
    15_000,
  );

  it(
    "shutdownAndExit escalates to SIGKILL for a teardown-hostile server (§6#1)",
    async () => {
      const { client, handle } = spawnClient(["--ignore-term"]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      const pid = handle.pid!;
      const t0 = Date.now();
      await client.shutdownAndExit(Date.now() + LSP_SHUTDOWN_GRACE_MS);
      expect(await waitPidDead(pid, 5000)).toBe(true);
      // Polite shutdown grace elapsed, then SIGKILL escalation reaped it.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS - 100);
    },
    15_000,
  );

  it(
    "reaps a grandchild via the process group on teardown (§6#2)",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-lsp-grand-"));
      const selfPidFile = join(tmpDir, "self.pid");
      const grandPidFile = join(tmpDir, "grand.pid");
      const { client, handle } = spawnClient(["--ignore-term", "--spawn-grandchild"], {
        env: { FIXTURE_SELF_PIDFILE: selfPidFile, FIXTURE_GRAND_PIDFILE: grandPidFile },
      });
      const childPid = handle.pid!;
      expect(await waitFor(() => existsSync(grandPidFile), 5000)).toBe(true);
      const grandPid = Number(readFileSync(grandPidFile, "utf-8").trim());
      expect(Number.isNaN(grandPid)).toBe(false);

      await client.shutdownAndExit(Date.now() + LSP_SHUTDOWN_GRACE_MS);
      expect(await waitPidDead(childPid, 5000)).toBe(true);
      expect(await waitPidDead(grandPid, 5000)).toBe(true);
    },
    15_000,
  );

  it(
    "settles a pending waitForPublish with null when the server exits (bounded on death, not the deadline)",
    async () => {
      const { client, handle } = spawnClient([]);
      expect(await client.initialize(Date.now() + 5000)).toBe(true);
      const uri = pathToFileUri("/proj/never-published.ts");
      // Far-future deadline: only the death path can settle this promptly.
      const pending = client.waitForPublish(uri, {
        afterSeq: 0,
        preferVersion: 1,
        deadline: Date.now() + 60_000,
      });
      await handle.kill();
      expect(await pending).toBeNull();
    },
    15_000,
  );
});

/**

 * number of distinct URIs a server has ever published. A configured server that
 * volunteers project-wide diagnostics for many DISTINCT files we never edited
 * must not accumulate a buffer key per URI. Driven deterministically by feeding
 * framed notifications straight into receive() — no process, no sleeps.
 */
describe("LspClient publishBuffer distinct-key bound (R12)", () => {
  function inertClient(): { client: LspClient } {
    const handle: PersistentChildHandle = {
      pid: undefined,
      exited: false,
      write: () => {},
      kill: async () => {},
    };
    const client = new LspClient(handle, {
      rootPath: "/proj",
      processId: process.pid,
      onProtocolError: () => {},
    });
    return { client };
  }

  function feedPublish(client: LspClient, uri: string, version: number, diagnostics: unknown[]): void {
    client.receive(
      encodeMessage({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, version, diagnostics },
      }),
    );
  }

  it("does not accumulate a buffer key per volunteered (unopened, unawaited) URI", async () => {
    const { client } = inertClient();

    // One document we actually edited — its publish legitimately buffers.
    const openedUri = pathToFileUri("/proj/edited.ts");
    const sent = client.didOpen(openedUri, "typescript", "x\n");

    // A server volunteering diagnostics for many DISTINCT URIs we never opened
    // and are not awaiting (the exact shape of the leak PoC).
    const N = 5000;
    for (let i = 0; i < N; i++) {
      feedPublish(client, pathToFileUri(`/proj/volunteered/file-${i}.ts`), 1, []);
    }

    // The buffer holds ONLY the open/awaited URIs. Pre-fix this would be N+ keys
    // (one per volunteered URI); post-fix it is bounded by the open docs.
    expect(client.publishBufferKeyCount).toBe(0);

    // A publish that races ahead of waitForPublish for the URI we edited is still
    // buffered (the transient race the buffer exists for) — proving the bound did
    // not weaken race-catching.
    feedPublish(client, openedUri, sent.version, []);
    expect(client.publishBufferKeyCount).toBe(1);

    const diags = await client.waitForPublish(openedUri, {
      afterSeq: sent.seq,
      preferVersion: sent.version,
      deadline: Date.now() + 1000,
    });
    expect(diags).toEqual([]);
  });

  it("buffers a publish for an actively-awaited but unopened URI (listener present) but not for others", async () => {
    const { client } = inertClient();

    // Await a URI we never opened; a live listener is registered for it.
    const awaitedUri = pathToFileUri("/proj/awaited.ts");
    const pending = client.waitForPublish(awaitedUri, {
      afterSeq: 0,
      preferVersion: 1,
      deadline: Date.now() + 1000,
    });

    // A foreign URI that is neither open nor awaited must not create a key.
    feedPublish(client, pathToFileUri("/proj/foreign.ts"), 1, []);
    expect(client.publishBufferKeyCount).toBe(0);

    // The awaited URI's publish is delivered live and resolves the wait.
    feedPublish(client, awaitedUri, 1, []);
    expect(await pending).toEqual([]);
    // Only the awaited URI ever held a buffer key — still bounded by 1.
    expect(client.publishBufferKeyCount).toBe(1);
  });
});
