/**
 * TerminalManager tests (design slice-2.4-cut.md §5, task 2.4.3). Two layers:
 *
 *  - Fake-pty unit suite (default): an injected `PtySpawner` / `LoadPty` drives
 *    the full lifecycle over a fake `WirePort` with zero real shells —
 *    open/reattach/ring-cap/resize/input/kill/exit/junk/import-fail/dispose.
 *  - LIVE suite (skipped where node-pty ships no prebuild): a REAL shell proves
 *    the echo round-trip AND the secret-scrub invariant (`$ANYCODE_API_KEY`
 *    empty in the spawned shell). Generous timeouts, deterministic markers.
 */

import { platform } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WirePort } from "../shared/protocol.js";
import {
  TERM_DEFAULT_COLS,
  TERM_DEFAULT_ROWS,
  TERM_NAME,
  TERM_REPLAY_MAX_BYTES,
  type TermToUiMessage,
} from "../shared/terminal.js";
import { scrubSecretEnv } from "./boot.js";
import {
  type LoadPty,
  type PtyLike,
  type PtySpawnConfig,
  type PtySpawner,
  TerminalManager,
  resolveDefaultShell,
} from "./terminal.js";

// ── fakes ──

class FakePty implements PtyLike {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly resized: Array<[number, number]> = [];
  killed = false;
  killSignal: string | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignal = signal;
  }

  // ── test drivers ──
  emitData(data: string): void {
    for (const l of [...this.dataListeners]) {
      l(data);
    }
  }
  emitExit(exitCode: number, signal?: number): void {
    for (const l of [...this.exitListeners]) {
      l({ exitCode, signal });
    }
  }
  get dataListenerCount(): number {
    return this.dataListeners.size;
  }
}

interface FakeChannel {
  port: WirePort;
  posted: TermToUiMessage[];
  send(raw: unknown): void;
  close(): void;
}

function makeChannel(): FakeChannel {
  const posted: TermToUiMessage[] = [];
  let onMessage: ((raw: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const port: WirePort = {
    post(message: unknown): void {
      posted.push(message as TermToUiMessage);
    },
    onMessage(cb: (raw: unknown) => void): void {
      onMessage = cb;
    },
    onClose(cb: () => void): void {
      onClose = cb;
    },
  };
  return {
    port,
    posted,
    send: (raw) => onMessage?.(raw),
    close: () => onClose?.(),
  };
}

interface Spawned {
  spawns: PtySpawnConfig[];
  ptys: FakePty[];
  loadPty: LoadPty;
  loadCount: () => number;
}

function makeSpawner(): Spawned {
  const spawns: PtySpawnConfig[] = [];
  const ptys: FakePty[] = [];
  let loads = 0;
  const spawner: PtySpawner = (config) => {
    spawns.push(config);
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const loadPty: LoadPty = async () => {
    loads++;
    return spawner;
  };
  return { spawns, ptys, loadPty, loadCount: () => loads };
}

/** Drains pending microtasks so an async `open()` (one `await import`) settles. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const typeOf = (m: TermToUiMessage): string => m.type;

describe("resolveDefaultShell (§7-U1)", () => {
  it("uses $SHELL when set, with -l on darwin", () => {
    expect(resolveDefaultShell({ SHELL: "/usr/bin/fish" }, "darwin")).toEqual({
      file: "/usr/bin/fish",
      args: ["-l"],
    });
  });
  it("falls back to /bin/zsh -l on darwin when $SHELL is unset/blank", () => {
    expect(resolveDefaultShell({}, "darwin")).toEqual({ file: "/bin/zsh", args: ["-l"] });
    expect(resolveDefaultShell({ SHELL: "  " }, "darwin")).toEqual({ file: "/bin/zsh", args: ["-l"] });
  });
  it("falls back to /bin/bash without -l on linux", () => {
    expect(resolveDefaultShell({}, "linux")).toEqual({ file: "/bin/bash", args: [] });
  });
  it("uses %COMSPEC%/cmd.exe on win32", () => {
    expect(resolveDefaultShell({ COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
    expect(resolveDefaultShell({}, "win32")).toEqual({ file: "cmd.exe", args: [] });
  });
});

describe("TerminalManager — fake pty", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("term_open spawns a fresh shell and replies term_opened{reattached:false, replay:''}", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({
      workspace: "/ws",
      env: { PATH: "/bin", FOO: "bar" },
      loadPty: s.loadPty,
      resolveShell: () => ({ file: "/bin/zsh", args: ["-l"] }),
    });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 100, rows: 40 });
    await flush();

    expect(s.spawns).toHaveLength(1);
    expect(s.spawns[0]).toMatchObject({
      file: "/bin/zsh",
      args: ["-l"],
      cols: 100,
      rows: 40,
      cwd: "/ws",
      name: TERM_NAME,
    });
    expect(ch.posted).toEqual([{ type: "term_opened", reattached: false, replay: "" }]);
  });

  it("uses the LIVE env at spawn time (post-scrub) — the shell never sees ANYCODE_API_KEY", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    // Simulate boot(): a key was present, then scrubbed before spawn.
    const env: NodeJS.ProcessEnv = { PATH: "/bin", ANYCODE_API_KEY: "leaked-secret" };
    scrubSecretEnv(env);
    const mgr = new TerminalManager({ workspace: "/ws", env, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: TERM_DEFAULT_COLS, rows: TERM_DEFAULT_ROWS });
    await flush();

    expect(s.spawns[0]?.env.ANYCODE_API_KEY).toBeUndefined();
    expect(s.spawns[0]?.env.PATH).toBe("/bin");
  });

  it("streams pty output as term_data", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    s.ptys[0]!.emitData("hello ");
    s.ptys[0]!.emitData("world");

    expect(ch.posted.filter((m) => m.type === "term_data")).toEqual([
      { type: "term_data", data: "hello " },
      { type: "term_data", data: "world" },
    ]);
  });

  it("reattaches to a live shell: term_opened{reattached:true, replay:<tail>} + resize", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    s.ptys[0]!.emitData("prior output");

    ch.send({ type: "term_open", cols: 120, rows: 30 });
    await flush();

    // No respawn.
    expect(s.spawns).toHaveLength(1);
    // Geometry updated on the live pty.
    expect(s.ptys[0]!.resized).toContainEqual([120, 30]);
    const reattach = ch.posted.find((m) => m.type === "term_opened" && m.reattached);
    expect(reattach).toEqual({ type: "term_opened", reattached: true, replay: "prior output" });
  });

  it("caps the replay ring at TERM_REPLAY_MAX_BYTES, trimming from the head", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();

    const headLen = 200 * 1024;
    const tailLen = 100 * 1024;
    s.ptys[0]!.emitData("a".repeat(headLen)); // oldest
    s.ptys[0]!.emitData("b".repeat(tailLen)); // newest

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();

    const reattach = ch.posted.find((m) => m.type === "term_opened" && m.reattached) as
      | Extract<TermToUiMessage, { type: "term_opened" }>
      | undefined;
    expect(reattach).toBeDefined();
    const replay = reattach!.replay;
    // Exactly the cap, head trimmed: the whole 'b' tail + the newest 'a' bytes.
    expect(Buffer.byteLength(replay, "utf8")).toBe(TERM_REPLAY_MAX_BYTES);
    expect(replay.endsWith("b".repeat(tailLen))).toBe(true);
    expect(replay.startsWith("a")).toBe(true);
    // Head loss: total was 300KB, cap 256KB -> 44KB of 'a' dropped.
    expect((replay.match(/a/g) ?? []).length).toBe(TERM_REPLAY_MAX_BYTES - tailLen);
  });

  it("forwards term_input and term_resize to the live pty", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    ch.send({ type: "term_input", data: "ls -la\r" });
    ch.send({ type: "term_resize", cols: 132, rows: 43 });

    expect(s.ptys[0]!.written).toEqual(["ls -la\r"]);
    expect(s.ptys[0]!.resized).toContainEqual([132, 43]);
  });

  it("drops input/resize with a warn when there is no live shell (fail-closed)", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_input", data: "x" });
    ch.send({ type: "term_resize", cols: 80, rows: 24 });
    await flush();

    expect(s.spawns).toHaveLength(0);
    expect(ch.posted).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("drops junk on the channel with a warn and never crashes", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: -1, rows: 0 }); // invalid geometry
    ch.send({ type: "nonsense" });
    ch.send(42);
    ch.send({ type: "term_input" }); // missing data
    await flush();

    expect(s.spawns).toHaveLength(0);
    expect(ch.posted).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("term_kill kills the pty; onExit emits term_exited; a later term_open respawns", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    ch.send({ type: "term_kill" });
    expect(s.ptys[0]!.killed).toBe(true);

    // Shell reports its death.
    s.ptys[0]!.emitExit(0, 1);
    expect(ch.posted).toContainEqual({ type: "term_exited", exitCode: 0, signal: 1 });

    // Fresh open spawns a brand-new shell.
    ch.send({ type: "term_open", cols: 90, rows: 25 });
    await flush();
    expect(s.spawns).toHaveLength(2);
    expect(ch.posted.filter((m) => m.type === "term_opened").at(-1)).toEqual({
      type: "term_opened",
      reattached: false,
      replay: "",
    });
  });

  it("pty self-exit without a signal emits term_exited with no signal field", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    s.ptys[0]!.emitExit(3);

    const exited = ch.posted.find((m) => m.type === "term_exited");
    expect(exited).toEqual({ type: "term_exited", exitCode: 3 });
    expect(exited).not.toHaveProperty("signal");
  });

  it("dispose() synchronously kills the pty and disposes listeners (no async work)", async () => {
    const s = makeSpawner();
    const ch = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    const pty = s.ptys[0]!;

    const before = ch.posted.length;
    mgr.dispose(); // synchronous — no await

    expect(pty.killed).toBe(true);
    expect(pty.dataListenerCount).toBe(0);
    // Late output after dispose is not forwarded (listener already gone).
    pty.emitData("late");
    expect(ch.posted.length).toBe(before);
  });

  it("import failure degrades to term_error and keeps the manager alive (retryable)", async () => {
    const ch = makeChannel();
    const failing: LoadPty = () => Promise.reject(new Error("native module broken"));
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: failing });
    mgr.bindPort(ch.port);

    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();

    expect(ch.posted.map(typeOf)).toEqual(["term_error"]);
    expect(ch.posted[0]).toMatchObject({ type: "term_error" });

    // Host stays alive: a subsequent input is dropped (warn), not thrown; and a
    // second open retries the load (opening flag was reset).
    expect(() => ch.send({ type: "term_input", data: "x" })).not.toThrow();
    ch.send({ type: "term_open", cols: 80, rows: 24 });
    await flush();
    expect(ch.posted.map(typeOf)).toEqual(["term_error", "term_error"]);
  });

  it("a redelivered port's close does not clear a newer bound port", async () => {
    const s = makeSpawner();
    const first = makeChannel();
    const second = makeChannel();
    const mgr = new TerminalManager({ workspace: "/ws", env: {}, loadPty: s.loadPty });

    mgr.bindPort(first.port);
    mgr.bindPort(second.port); // renderer reload / respawn redelivery
    first.close(); // old channel finally closes AFTER the new one is bound

    first.send({ type: "term_open", cols: 80, rows: 24 });
    // The manager still posts to the NEWER port.
    await flush();
    expect(second.posted.map(typeOf)).toEqual(["term_opened"]);
    expect(first.posted).toEqual([]);
  });
});

// ── LIVE suite: real node-pty shell (skipped where no prebuild ships) ──

const HAS_PREBUILD = platform === "darwin" || platform === "win32";

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for pty output");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("TerminalManager — live node-pty", () => {
  it.skipIf(!HAS_PREBUILD || platform === "win32")(
    "round-trips a shell command AND never leaks ANYCODE_API_KEY (scrub invariant)",
    async () => {
      const ch = makeChannel();
      // A key that WAS present, then scrubbed before the spawn — exactly boot()'s
      // finally, exercised against the real scrubSecretEnv.
      const env: NodeJS.ProcessEnv = { ...process.env, ANYCODE_API_KEY: "LEAK-abc123-xyz" };
      scrubSecretEnv(env);
      const mgr = new TerminalManager({ workspace: process.cwd(), env }); // real node-pty
      mgr.bindPort(ch.port);

      try {
        ch.send({ type: "term_open", cols: 80, rows: 24 });
        await waitUntil(() => ch.posted.some((m) => m.type === "term_opened"), 12_000);

        // Round-trip marker + secret-expansion marker in one line each.
        ch.send({ type: "term_input", data: "echo RTMARK-98765\r" });
        ch.send({ type: "term_input", data: 'echo "SCRUBMARK_${ANYCODE_API_KEY}_END"\r' });

        const output = (): string =>
          ch.posted
            .filter((m): m is Extract<TermToUiMessage, { type: "term_data" }> => m.type === "term_data")
            .map((m) => m.data)
            .join("");

        await waitUntil(() => output().includes("RTMARK-98765"), 12_000);
        // The empty-expansion RESULT line proves the shell saw NO key.
        await waitUntil(() => output().includes("SCRUBMARK__END"), 12_000);

        const all = output();
        expect(all).toContain("RTMARK-98765");
        expect(all).toContain("SCRUBMARK__END");
        expect(all).not.toContain("LEAK-abc123-xyz");
      } finally {
        mgr.dispose(); // SIGHUP the real shell — no orphan
      }
    },
    30_000,
  );
});
