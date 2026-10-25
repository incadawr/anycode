/**
 * Service supervisor tests (Taskana 4750a). The supervisor is driven through
 * a hand-rolled fake clock and a fake spawn, so no real process is ever
 * started. Every timer is ours: `advance(ms)` runs due timers in order and
 * `flush()` lets the supervisor's promise queue settle.
 */

import { describe, expect, it } from "vitest";
import {
  SERVICE_BACKOFF_MAX_MS,
  SERVICE_CRASH_LOOP_WINDOW_MS,
  SERVICE_LOG_LINE_MAX_CHARS,
  SERVICE_LOG_MAX_BYTES,
  SERVICE_LOG_MAX_LINES,
  SERVICE_STOP_ALL_DEADLINE_MS,
  createServiceSupervisor,
  serviceBackoffDelay,
  type ServiceCandidate,
  type ServiceProcess,
  type ServiceSpawnSpec,
} from "./service-supervisor.js";

// ── harness ──

interface FakeProc extends ServiceProcess {
  killCalls: boolean[];
  exit(code: number | null, signal: string | null): void;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  fail(error: Error): void;
}

let pidSeq = 4000;

function fakeProc(opts: { ignoreKill?: boolean } = {}): FakeProc {
  let out: ((c: string) => void) | undefined;
  let err: ((c: string) => void) | undefined;
  let exitCb: ((code: number | null, signal: string | null) => void) | undefined;
  let errCb: ((e: Error) => void) | undefined;
  const proc: FakeProc = {
    pid: ++pidSeq,
    killCalls: [],
    onStdout: (cb) => {
      out = cb;
    },
    onStderr: (cb) => {
      err = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: (cb) => {
      errCb = cb;
    },
    kill(tree: boolean) {
      this.killCalls.push(tree);
      if (!opts.ignoreKill) this.exit(null, "SIGTERM");
    },
    exit(code, signal) {
      const cb = exitCb;
      exitCb = undefined;
      cb?.(code, signal);
    },
    emitStdout: (chunk) => out?.(chunk),
    emitStderr: (chunk) => err?.(chunk),
    fail: (error) => errCb?.(error),
  };
  return proc;
}

const cand = (over: Partial<Omit<ServiceCandidate, "service">> & { service?: Partial<ServiceCandidate["service"]> } = {}): ServiceCandidate => {
  const { service, ...rest } = over;
  return {
    plugin: "bridge",
    tier: "third-party",
    root: "/plugins/bridge",
    enabled: true,
    consented: true,
    trusted: true,
    ...rest,
    service: { name: "relay", command: "node", args: ["./relay.js"], env: { LOG_LEVEL: "debug" }, ...service },
  };
};

function harness(opts: { inherited?: Record<string, string | undefined>; spawnThrowsFirst?: boolean } = {}) {
  let now = 0;
  let candidates: ServiceCandidate[] = [];
  let discovery: string | undefined;
  let throwNext = opts.spawnThrowsFirst === true;
  const spawns: { spec: ServiceSpawnSpec; proc: FakeProc }[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerSeq = 0;
  const warnings: unknown[] = [];

  const sup = createServiceSupervisor({
    listCandidates: async () => candidates,
    spawn: (spec) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("spawn EACCES");
      }
      const proc = fakeProc({ ignoreKill: ignoreKillNext });
      ignoreKillNext = false;
      spawns.push({ spec, proc });
      return proc;
    },
    discoveryFile: () => discovery,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    env: opts.inherited ?? { PATH: "/usr/bin", HOME: "/home/u", AWS_SECRET: "aws-secret-xyz", ANYCODE_TOKEN_LEAK: "tok-123" },
    platform: "darwin",
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
  });

  let ignoreKillNext = false;

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }

  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await flush();
    }
    now = target;
    await flush();
  }

  return {
    sup,
    spawns,
    warnings,
    flush,
    advance,
    setCandidates: (list: ServiceCandidate[]) => {
      candidates = list;
    },
    setDiscovery: (path: string | undefined) => {
      discovery = path;
    },
    ignoreNextKill: () => {
      ignoreKillNext = true;
    },
    timerCount: () => timers.size,
  };
}

// ── tests ──

describe("service supervisor — start / gating", () => {
  it("starts an eligible service once and passes cwd and shell false", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(1);
    const spec = h.spawns[0]!.spec;
    expect(spec.cwd).toBe("/plugins/bridge");
    expect(spec.shell).toBe(false);
    expect(spec.windowsHide).toBe(true);
    expect(spec.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spec.command).toBe("node");
    expect(spec.args).toEqual(["./relay.js"]);
    expect(spec.detached).toBe(true);
    expect(h.sup.snapshot()).toEqual([{ plugin: "bridge", name: "relay", state: "running", pid: h.spawns[0]!.proc.pid, restarts: 0 }]);
  });

  it("does not start without consent (blocked no_consent)", async () => {
    const h = harness();
    h.setCandidates([cand({ consented: false })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "no_consent" });
  });

  it("does not start a disabled plugin", async () => {
    const h = harness();
    h.setCandidates([cand({ enabled: false })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "disabled" });
  });

  it("project-tier service blocked until workspace trusted, starts after trust", async () => {
    const h = harness();
    h.setCandidates([cand({ tier: "project", trusted: false })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "untrusted" });
    h.setCandidates([cand({ tier: "project", trusted: true })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(1);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "running" });
  });

  it("reconcile is idempotent and serialised (two concurrent calls spawn once)", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await Promise.all([h.sup.reconcile(), h.sup.reconcile()]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(1);
  });

  it("a relative command escaping the plugin root is refused (blocked bad_command, no spawn)", async () => {
    const h = harness();
    h.setCandidates([cand({ service: { command: "./../../evil.sh" } })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "bad_command" });
    expect(h.sup.logs("bridge", "relay").join("\n")).toContain("escapes the plugin folder");
  });

  it("a ./ command inside the root is spawned from that path", async () => {
    const h = harness();
    h.setCandidates([cand({ service: { command: "./bin/run" } })]);
    await h.sup.reconcile();
    expect(h.spawns[0]!.spec.command).toBe("/plugins/bridge/bin/run");
  });
});

describe("service supervisor — stop / removal / consent change", () => {
  it("stop on disable", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    h.setCandidates([cand({ enabled: false })]);
    await h.sup.reconcile();
    expect(proc.killCalls).toEqual([true]);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "disabled" });
  });

  it("stop on removal (candidate disappears)", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    h.setCandidates([]);
    await h.sup.reconcile();
    expect(proc.killCalls).toEqual([true]);
    expect(h.sup.snapshot()).toEqual([]);
  });

  it("changed servicesHash (consent lost) stops the running service", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    h.setCandidates([cand({ consented: false })]);
    await h.sup.reconcile();
    expect(proc.killCalls).toEqual([true]);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "blocked", reason: "no_consent" });
    // Re-approval of the same definition starts it again.
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(2);
  });

  it("stopAll kills tree and resolves", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    let resolved = false;
    const done = h.sup.stopAll().then(() => {
      resolved = true;
    });
    await h.flush();
    await done;
    expect(resolved).toBe(true);
    expect(proc.killCalls).toEqual([true]);
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "stopped" });
  });

  it("stopAll hard deadline when process ignores kill", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    h.ignoreNextKill();
    await h.sup.reconcile();
    let resolved = false;
    const done = h.sup.stopAll().then(() => {
      resolved = true;
    });
    await h.flush();
    await h.advance(SERVICE_STOP_ALL_DEADLINE_MS - 1);
    expect(resolved).toBe(false);
    await h.advance(1);
    await done;
    expect(resolved).toBe(true);
  });

  it("a reconcile after stopAll starts nothing (quit is final)", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.stopAll();
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
  });
});

describe("service supervisor — restart policy", () => {
  it("restarts after crash with exponential backoff 1s 2s 4s capped at 60s", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    h.spawns[0]!.proc.exit(1, null);
    await h.flush();
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "backoff", restartInSec: 1 });
    await h.advance(999);
    expect(h.spawns).toHaveLength(1);
    await h.advance(1);
    expect(h.spawns).toHaveLength(2);
    h.spawns[1]!.proc.exit(1, null);
    await h.flush();
    await h.advance(1_999);
    expect(h.spawns).toHaveLength(2);
    await h.advance(1);
    expect(h.spawns).toHaveLength(3);
    h.spawns[2]!.proc.exit(1, null);
    await h.flush();
    await h.advance(3_999);
    expect(h.spawns).toHaveLength(3);
    await h.advance(1);
    expect(h.spawns).toHaveLength(4);
    // The schedule itself is capped at 60s.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(serviceBackoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(serviceBackoffDelay(20)).toBe(SERVICE_BACKOFF_MAX_MS);
  });

  it("long run resets backoff", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    // Crash once fast (backoff 1s), then run for a full stable window and die.
    h.spawns[0]!.proc.exit(1, null);
    await h.flush();
    await h.advance(1_000);
    expect(h.spawns).toHaveLength(2);
    await h.advance(60_000);
    h.spawns[1]!.proc.exit(1, null);
    await h.flush();
    // Streak was reset by the stable run: the next delay is the base 1s again.
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "backoff", restartInSec: 1 });
  });

  it("crash loop after 5 failures in 120s stops auto restarts", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    for (let i = 0; i < 4; i++) {
      h.spawns[i]!.proc.exit(1, null);
      await h.flush();
      await h.advance(serviceBackoffDelay(i));
    }
    expect(h.spawns).toHaveLength(5);
    h.spawns[4]!.proc.exit(1, null);
    await h.flush();
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "crash_loop" });
    expect(h.sup.logs("bridge", "relay").join("\n")).toContain("crash loop");
    await h.advance(SERVICE_CRASH_LOOP_WINDOW_MS * 10);
    expect(h.spawns).toHaveLength(5);
  });

  it("manual restart clears crash loop", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    for (let i = 0; i < 5; i++) {
      h.spawns[i]!.proc.exit(1, null);
      await h.flush();
      await h.advance(serviceBackoffDelay(i));
    }
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "crash_loop" });
    await h.sup.restart("bridge", "relay");
    expect(h.spawns).toHaveLength(6);
    // A manual restart resets the automatic-restart counter.
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "running", restarts: 0 });
  });

  it("a manual restart of a service that is no longer eligible does not spawn", async () => {
    const h = harness();
    h.setCandidates([cand({ consented: false })]);
    await h.sup.reconcile();
    await h.sup.restart("bridge", "relay");
    expect(h.spawns).toHaveLength(0);
  });

  it("spawn error becomes backoff not a throw", async () => {
    const h = harness({ spawnThrowsFirst: true });
    h.setCandidates([cand()]);
    await expect(h.sup.reconcile()).resolves.toBeUndefined();
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "backoff", restartInSec: 1 });
    expect(h.sup.logs("bridge", "relay").join("\n")).toContain("spawn failed");
    await h.advance(1_000);
    expect(h.spawns).toHaveLength(1);
  });

  it("an error event from a running child is handled as a failure (backoff), not thrown", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    h.spawns[0]!.proc.fail(new Error("ENOENT"));
    await h.flush();
    expect(h.sup.snapshot()[0]).toMatchObject({ state: "backoff" });
    expect(h.sup.logs("bridge", "relay").join("\n")).toContain("error: ENOENT");
  });
});

describe("service supervisor — environment", () => {
  it("env contains ANYCODE_SESSIONS_DISCOVERY only when the discovery file exists", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    expect(h.spawns[0]!.spec.env).not.toHaveProperty("ANYCODE_SESSIONS_DISCOVERY");

    h.setDiscovery("/home/u/.anycode/sessions.json");
    h.setCandidates([cand({ service: { name: "other" } })]);
    await h.sup.reconcile();
    const other = h.spawns.find((s) => s.spec.env.ANYCODE_SERVICE_NAME === "other")!;
    expect(other.spec.env.ANYCODE_SESSIONS_DISCOVERY).toBe("/home/u/.anycode/sessions.json");
  });

  it("discovery path change restarts running service once", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const first = h.spawns[0]!.proc;
    h.setDiscovery("/home/u/.anycode/sessions.json");
    await h.sup.reconcile();
    expect(first.killCalls).toEqual([true]);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1]!.spec.env.ANYCODE_SESSIONS_DISCOVERY).toBe("/home/u/.anycode/sessions.json");
    // Unchanged discovery path: no further restart.
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(2);
  });

  it("env never contains token or ANYCODE_ vars inherited from the app", async () => {
    const h = harness();
    h.setDiscovery("/home/u/.anycode/sessions.json");
    h.setCandidates([cand({ service: { env: { LOG_LEVEL: "debug" } } })]);
    await h.sup.reconcile();
    const env = h.spawns[0]!.spec.env;
    const anycodeKeys = Object.keys(env).filter((k) => k.startsWith("ANYCODE_")).sort();
    expect(anycodeKeys).toEqual(["ANYCODE_PLUGIN_DIR", "ANYCODE_PLUGIN_NAME", "ANYCODE_SERVICE_NAME", "ANYCODE_SESSIONS_DISCOVERY"]);
    expect(JSON.stringify(env)).not.toContain("tok-123");
    expect(env).not.toHaveProperty("AWS_SECRET");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.ANYCODE_PLUGIN_NAME).toBe("bridge");
    expect(env.ANYCODE_SERVICE_NAME).toBe("relay");
    expect(env.ANYCODE_PLUGIN_DIR).toBe("/plugins/bridge");
  });

  it("the log never contains the env block", async () => {
    const h = harness();
    h.setDiscovery("/home/u/.anycode/sessions.json");
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const text = h.sup.logs("bridge", "relay").join("\n");
    expect(text).not.toContain("tok-123");
    expect(text).not.toContain("aws-secret-xyz");
    expect(text).not.toContain("ANYCODE_SESSIONS_DISCOVERY");
  });
});

describe("service supervisor — logs", () => {
  it("log ring caps lines and bytes and truncates long lines", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    for (let i = 0; i < 300; i++) proc.emitStdout(`line ${i}\n`);
    const lines = h.sup.logs("bridge", "relay");
    expect(lines.length).toBeLessThanOrEqual(SERVICE_LOG_MAX_LINES);
    expect(lines[lines.length - 1]).toBe("line 299");

    const big = "x".repeat(1000);
    for (let i = 0; i < 100; i++) proc.emitStdout(`${big}\n`);
    const bytes = h.sup.logs("bridge", "relay").reduce((sum, l) => sum + Buffer.byteLength(l, "utf8") + 1, 0);
    expect(bytes).toBeLessThanOrEqual(SERVICE_LOG_MAX_BYTES);

    proc.emitStdout(`${"y".repeat(5000)}\n`);
    const last = h.sup.logs("bridge", "relay").at(-1)!;
    expect(last.length).toBeLessThanOrEqual(SERVICE_LOG_LINE_MAX_CHARS);
  });

  it("stderr prefixed and ANSI stripped", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    h.spawns[0]!.proc.emitStderr("\x1b[31mboom\x1b[0m\n");
    const lines = h.sup.logs("bridge", "relay");
    expect(lines).toContain("[err] boom");
    expect(lines.join("\n")).not.toContain("\x1b");
  });

  it("supervisor events are prefixed [sup] and a partial line is flushed on exit", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const proc = h.spawns[0]!.proc;
    proc.emitStdout("no newline yet");
    proc.exit(0, null);
    await h.flush();
    const lines = h.sup.logs("bridge", "relay");
    expect(lines).toContain("no newline yet");
    expect(lines.filter((l) => l.startsWith("[sup] ")).join("|")).toContain("[sup] started pid");
    expect(lines.join("|")).toContain("[sup] exited code 0");
  });
});

describe("service supervisor — misc", () => {
  it("serviceBackoffDelay stays within the documented bounds", () => {
    expect(serviceBackoffDelay(0)).toBe(1000);
    expect(serviceBackoffDelay(100)).toBe(60_000);
  });

  it("an unresolvable candidate scan is logged and keeps the current state", async () => {
    const h = harness();
    h.setCandidates([cand()]);
    await h.sup.reconcile();
    const sup2 = createServiceSupervisor({
      listCandidates: async () => {
        throw new Error("scan down");
      },
      spawn: () => fakeProc(),
      discoveryFile: () => undefined,
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await expect(sup2.reconcile()).resolves.toBeUndefined();
    expect(sup2.snapshot()).toEqual([]);
  });
});

// Taskana 4751 part 0: `${secret:NAME}` in service env (values resolved by the candidate source).

describe("service supervisor — secret refs (Taskana 4751 part 0)", () => {
  const SECRET_VALUE = "SECRET-VALUE-XYZ-9731";

  it("service env resolves secret refs at spawn", async () => {
    const h = harness();
    h.setCandidates([
      cand({
        service: { env: { TOKEN: "${secret:TOK}", MIXED: "a-${secret:TOK}-b", PLAIN: "${env:HOME}" } },
        secretValues: { TOK: SECRET_VALUE },
        missingSecrets: [],
      }),
    ]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(1);
    const env = h.spawns[0]!.spec.env;
    expect(env.TOKEN).toBe(SECRET_VALUE);
    expect(env.MIXED).toBe(`a-${SECRET_VALUE}-b`);
    // `${env:X}` is never interpolated.
    expect(env.PLAIN).toBe("${env:HOME}");
  });

  it("missing secret blocks the service with the secret name only", async () => {
    const h = harness();
    h.setCandidates([cand({ service: { env: { TOKEN: "${secret:TOK}" } }, secretValues: {}, missingSecrets: ["TOK"] })]);
    await h.sup.reconcile();
    expect(h.spawns).toHaveLength(0);
    const view = h.sup.snapshot().find((v) => v.name === "relay")!;
    expect(view.state).toBe("blocked");
    expect(view.reason).toBe("missing_secret");
    expect(view.missingSecrets).toEqual(["TOK"]);
    expect(JSON.stringify(view)).not.toContain(SECRET_VALUE);
  });

  it("secret value never appears in log snapshot or views", async () => {
    const h = harness();
    h.setCandidates([cand({ service: { env: { TOKEN: "${secret:TOK}" } }, secretValues: { TOK: SECRET_VALUE }, missingSecrets: [] })]);
    await h.sup.reconcile();
    h.spawns[0]!.proc.emitStdout("hello\n");
    await h.flush();
    h.spawns[0]!.proc.exit(1, null);
    await h.flush();
    const dump = JSON.stringify({ views: h.sup.snapshot(), logs: h.sup.logs("bridge", "relay") });
    expect(dump).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(h.warnings)).not.toContain(SECRET_VALUE);
  });

  it("saving the missing secret unblocks via reconcile", async () => {
    const h = harness();
    h.setCandidates([cand({ service: { env: { TOKEN: "${secret:TOK}" } }, secretValues: {}, missingSecrets: ["TOK"] })]);
    await h.sup.reconcile();
    expect(h.sup.snapshot()[0]!.state).toBe("blocked");
    // The user saves the secret: the candidate source now resolves it and reconcile runs again.
    h.setCandidates([cand({ service: { env: { TOKEN: "${secret:TOK}" } }, secretValues: { TOK: SECRET_VALUE }, missingSecrets: [] })]);
    await h.sup.reconcile();
    expect(h.sup.snapshot()[0]!.state).toBe("running");
    expect(h.spawns[0]!.spec.env.TOKEN).toBe(SECRET_VALUE);
  });
});
