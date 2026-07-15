/**
 * Unit tests for the TabHostManager's pure breaker/accounting logic (design

 *
 * No real process is ever spawned: the manager takes an injected `fork`, so
 * tests drive a fake UtilityProcess. A "dying" fork schedules a rapid boot-time
 * exit (uptime ~0 < minHealthyUptimeMs) to simulate a crash-loop; a "live" fork
 * never exits. The exit chain runs on the microtask queue and is bounded by the
 * breakers, so a single macrotask flush drains it.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { CREDENTIAL_REQUEST_TYPE, CREDENTIAL_RESPONSE_TYPE } from "../shared/credentials.js";
import { PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { TERMINAL_INIT_MESSAGE_TYPE, TERMINAL_PORT_ENVELOPE_TYPE } from "../shared/terminal.js";
import {
  DEFAULT_BREAKER_LIMITS,
  TabHostManager,
  createPinReservations,
  decideRespawn,
  type HostForkFn,
  type TabHostManagerDeps,
  type TabLogger,
  type WindowLike,
} from "./tabs.js";

const silentLogger: TabLogger = { log() {}, warn() {}, error() {} };

let pidSeq = 0;

/** Minimal fake UtilityProcess: EventEmitter + no-op postMessage/kill/pid. */
class FakeHost extends EventEmitter {
  readonly pid = ++pidSeq;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

interface ForkRig {
  fork: HostForkFn;
  hosts: FakeHost[];
}

/** A fork that dies rapidly on boot (crash-loop simulation). */
function dyingForkRig(): ForkRig {
  const hosts: FakeHost[] = [];
  const fork: HostForkFn = () => {
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
    queueMicrotask(() => host.emit("exit", 1));
    return host as unknown as UtilityProcess;
  };
  return { fork, hosts };
}

/** A fork that stays up (never exits). */
function liveForkRig(): ForkRig {
  const hosts: FakeHost[] = [];
  const fork: HostForkFn = () => {
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
    return host as unknown as UtilityProcess;
  };
  return { fork, hosts };
}

interface PostedMessage {
  channel: string;
  payload: unknown;
  ports?: MessagePortMain[];
}

interface WindowRig {
  window: WindowLike;
  hostExited: string[];
  /** Every webContents.postMessage call (both the UI and the term channel). */
  posted: PostedMessage[];
}

function windowRig(): WindowRig {
  const hostExited: string[] = [];
  const posted: PostedMessage[] = [];
  const window: WindowLike = {
    isDestroyed: () => false,
    webContents: {
      postMessage: (channel: string, payload: unknown, ports?: MessagePortMain[]) => {
        posted.push({ channel, payload, ports });
      },
      send: (_channel: string, payload: unknown) => {
        hostExited.push((payload as { tabId: string }).tabId);
      },
    },
  };
  return { window, hostExited, posted };
}

function fakeChannel() {
  return {
    port1: {} as unknown as MessagePortMain,
    port2: {} as unknown as MessagePortMain,
  };
}

function makeManager(fork: HostForkFn, window: WindowLike, limits = {}) {
  return new TabHostManager({
    fork,
    hostEntry: "/fake/host.js",
    createChannel: fakeChannel,
    getWindow: () => window,
    env: () => ({}),
    logger: silentLogger,
    limits,
  });
}

/** A manager whose non-core engine is available (the default gate only admits core). */
function codexManager(fork: HostForkFn) {
  return new TabHostManager({
    fork,
    hostEntry: "/fake/host.js",
    createChannel: fakeChannel,
    getWindow: () => windowRig().window,
    env: () => ({}),
    engineReady: () => true,
    logger: silentLogger,
    limits: {},
  });
}

/** Drains the microtask exit-chain (bounded by the breakers). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("decideRespawn — pure breaker accounting", () => {
  it("a healthy run always respawns and clears both counters", () => {
    const d = decideRespawn({ uptimeMs: 5000, rapidRespawns: 4, stormForks: 9 });
    expect(d).toEqual({ action: "respawn", rapidRespawns: 0, resetStorm: true });
  });

  it("a rapid crash increments the per-tab counter and respawns below the cap", () => {
    const d = decideRespawn({ uptimeMs: 10, rapidRespawns: 2, stormForks: 3 });
    expect(d).toEqual({ action: "respawn", rapidRespawns: 3, resetStorm: false });
  });

  it("gives up on the per-tab breaker once rapid crashes exceed MAX_RAPID_RESPAWNS", () => {
    const d = decideRespawn({ uptimeMs: 10, rapidRespawns: 5, stormForks: 6 });
    expect(d.action).toBe("give_up");
    expect(d).toMatchObject({ reason: "per_tab_crash_loop", rapidRespawns: 6 });
  });

  it("gives up on the global storm breaker once the storm window is full", () => {
    const d = decideRespawn({ uptimeMs: 10, rapidRespawns: 1, stormForks: 12 });
    expect(d.action).toBe("give_up");
    expect(d).toMatchObject({ reason: "global_storm" });
  });

  it("the per-tab breaker takes precedence over the global one", () => {
    const d = decideRespawn({ uptimeMs: 10, rapidRespawns: 5, stormForks: 12 });
    expect(d).toMatchObject({ action: "give_up", reason: "per_tab_crash_loop" });
  });
});

describe("createPinReservations — in-flight pin refcount (W10-FIX F3, layer a)", () => {
  it("holds while ANY reservation is outstanding and drops only at zero", () => {
    const r = createPinReservations();
    expect(r.has("A")).toBe(false);
    r.reserve("A");
    r.reserve("A"); // two concurrent resumes of the same pin
    expect(r.has("A")).toBe(true);
    r.release("A");
    // guard still holds — one release does not clear a doubly-reserved pin
    expect(r.has("A")).toBe(true);
    r.release("A");
    expect(r.has("A")).toBe(false);
  });

  it("never underflows on over-release", () => {
    const r = createPinReservations();
    r.reserve("B");
    r.release("B");
    r.release("B"); // extra release must not wedge a stuck-negative count
    expect(r.has("B")).toBe(false);
    r.reserve("B");
    expect(r.has("B")).toBe(true);
  });

  it("tracks distinct pins independently", () => {
    const r = createPinReservations();
    r.reserve("A");
    expect(r.has("A")).toBe(true);
    expect(r.has("B")).toBe(false);
  });
});

describe("TabHostManager — per-tab circuit breaker", () => {
  it("stops respawning a single crash-looping tab after MAX_RAPID_RESPAWNS", async () => {
    const { fork, hosts } = dyingForkRig();
    const { window, hostExited } = windowRig();
    const manager = makeManager(fork, window);

    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(created.ok).toBe(true);

    await flush();

    // 1 initial + MAX_RAPID_RESPAWNS respawns = 6 forks, then give up.
    expect(hosts).toHaveLength(DEFAULT_BREAKER_LIMITS.maxRapidRespawns + 1);
    const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
    expect(tab?.state).toBe("crash_looped");
    // A host-exited banner for every crash.
    expect(hostExited.length).toBe(DEFAULT_BREAKER_LIMITS.maxRapidRespawns + 1);
    expect(new Set(hostExited)).toEqual(new Set([created.ok ? created.tab.tabId : ""]));
  });

  it("passes the session-bearing argv: --session on first spawn, --resume on respawn", async () => {
    const forkSpy = vi.fn<HostForkFn>();
    const { hosts } = dyingForkRig();
    let i = 0;
    forkSpy.mockImplementation(() => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("exit", 1));
      i++;
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = makeManager(forkSpy, window);
    manager.createTab({ workspace: "/ws", sessionId: "sess-A", resume: false });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual(["--session", "sess-A"]);

    expect(forkSpy.mock.calls[1]?.[1]).toEqual(["--resume", "sess-A"]);
    expect(i).toBeGreaterThan(1);
  });

  it("a resumed tab spawns with --resume on the very first fork", async () => {
    const { hosts } = liveForkRig();
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = makeManager(forkSpy, window);
    manager.createTab({ workspace: "/ws", sessionId: "sess-R", resume: true });
    await flush();
    expect(forkSpy.mock.calls[0]?.[1]).toEqual(["--resume", "sess-R"]);
  });

  // TASK.39: the draft (pre-session) engine model/preset choice.
  it("carries the draft engine model/preset on the spawn that CREATES the session — and never again", async () => {
    const forkSpy = vi.fn<HostForkFn>();
    const { hosts } = dyingForkRig();
    forkSpy.mockImplementation(() => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("exit", 1));
      return host as unknown as UtilityProcess;
    });
    const manager = codexManager(forkSpy);
    manager.createTab({
      workspace: "/ws",
      sessionId: "sess-D",
      resume: false,
      engine: "codex",
      engineModel: "gpt-5.6-sol",
      enginePreset: "read-only",
    });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual([
      "--session",
      "sess-D",
      "--engine-model",
      "gpt-5.6-sol",
      "--engine-preset",
      "read-only",
    ]);
    // A respawn resumes the persisted session: replaying the draft here would
    // silently undo a mid-session model/preset change the user made.
    expect(forkSpy.mock.calls[1]?.[1]).toEqual(["--resume", "sess-D"]);
  });

  // Main holds no catalog and no preset table, so it makes no policy decision: it
  // only refuses values that could not be an id AT ALL (empty/whitespace/oversized).
  // Anything else rides argv as an opaque string and is refused by the HOST — the
  // single validation authority (a raw-config string is just an unknown preset id
  // there, and degrades to the default posture; see codex-engine.test.ts).
  it("drops a draft value that could not be an id, instead of putting junk on argv", async () => {
    const { hosts } = liveForkRig();
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const manager = codexManager(forkSpy);
    manager.createTab({
      workspace: "/ws",
      sessionId: "sess-J",
      resume: false,
      engine: "codex",
      engineModel: "  ",
      enginePreset: "x".repeat(200),
    });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual(["--session", "sess-J"]);
  });
});

describe("TabHostManager — engine identity and process ownership", () => {
  it("retains an engine-specific env overlay across respawn", () => {
    const { hosts } = liveForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    const manager = new TabHostManager({
      fork: (_entry, _args, opts) => {
        envs.push(opts.env);
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({ PATH: "/base" }),
      engineReady: () => true,
      engineEnv: (engine) => ({ ANYCODE_ENGINE: engine }),
      logger: silentLogger,
    });

    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, engine: "codex" });
    expect(created.ok).toBe(true);
    const tab = created.ok ? created.tab : undefined;
    hosts[0]!.emit("exit", 1);

    expect(tab?.engine).toBe("codex");
    expect(envs).toEqual([
      { PATH: "/base", ANYCODE_ENGINE: "codex" },
      { PATH: "/base", ANYCODE_ENGINE: "codex" },
    ]);
  });

  it("threads the monotonic host generation into each engine env overlay", () => {
    const { hosts } = liveForkRig();
    const generations: number[] = [];
    const manager = new TabHostManager({
      fork: () => {
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      engineReady: () => true,
      engineEnv: (_engine, generation) => {
        generations.push(generation);
        return { ANYCODE_HOST_GENERATION: String(generation) };
      },
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s-generation", resume: false, engine: "codex" });
    expect(created.ok).toBe(true);
    hosts[0]!.emit("exit", 1);
    expect(generations).toEqual([1, 2]);
  });

  it("reaps only the matching host generation and rejects stale registrations", () => {
    const { hosts } = liveForkRig();
    const reaped: number[] = [];
    const { window } = windowRig();
    const manager = new TabHostManager({
      fork: (_entry, _args, _opts) => {
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      engineReady: () => true,
      reapEngineProcess: (registration) => reaped.push(registration.enginePid),
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, engine: "codex" });
    expect(created.ok).toBe(true);
    const tab = created.ok ? created.tab : undefined;
    const first = hosts[0]!;
    first.emit("message", {
      type: "anycode:engine-process",
      hostPid: first.pid,
      generation: 1,
      enginePid: 501,
      pgid: 501,
    });
    first.emit("exit", 1);
    expect(reaped).toEqual([501]);

    const second = hosts[1]!;
    second.emit("message", {
      type: "anycode:engine-process",
      hostPid: second.pid,
      generation: 2,
      enginePid: 502,
      pgid: 502,
    });
    // A late message from the previous host cannot overwrite the live record.
    first.emit("message", {
      type: "anycode:engine-process",
      hostPid: first.pid,
      generation: 1,
      enginePid: 999,
      pgid: 999,
    });
    expect(tab?.engineProcess?.enginePid).toBe(502);

    second.emit("exit", 1);
    expect(reaped).toEqual([501, 502]);
  });
});

describe("TabHostManager — global storm breaker", () => {
  it("caps total forks at GLOBAL_MAX_RAPID_RESPAWNS across 3 crash-looping tabs", async () => {
    const { fork, hosts } = dyingForkRig();
    const { window, hostExited } = windowRig();
    const manager = makeManager(fork, window);

    const t1 = manager.createTab({ workspace: "/a", sessionId: "s1", resume: false });
    const t2 = manager.createTab({ workspace: "/b", sessionId: "s2", resume: false });
    const t3 = manager.createTab({ workspace: "/c", sessionId: "s3", resume: false });

    await flush();


    expect(hosts.length).toBeLessThanOrEqual(DEFAULT_BREAKER_LIMITS.globalMaxRapidRespawns);
    expect(hosts.length).toBe(DEFAULT_BREAKER_LIMITS.globalMaxRapidRespawns);

    // Every tab ends crash-looped and got at least one host-exited banner.
    for (const created of [t1, t2, t3]) {
      expect(created.ok).toBe(true);
      const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
      expect(tab?.state).toBe("crash_looped");
      expect(created.ok ? hostExited.includes(created.tab.tabId) : false).toBe(true);
    }
  });
});

describe("TabHostManager — session binding (F7) + MAX_TABS (F5)", () => {
  it("refuses to open the same session in a second tab (already_open + focusTabId)", () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);

    const first = manager.createTab({ workspace: "/ws", sessionId: "dup", resume: false });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.tab.tabId : "";

    const second = manager.createTab({ workspace: "/ws", sessionId: "dup", resume: true });
    expect(second).toEqual({ ok: false, reason: "already_open", focusTabId: firstId });
    expect(manager.count()).toBe(1);
  });

  it("enforces MAX_TABS and reports the binding via sessionOpenInTab", () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window, { maxTabs: 3 });

    for (let n = 0; n < 3; n++) {
      const r = manager.createTab({ workspace: "/ws", sessionId: `s${n}`, resume: false });
      expect(r.ok).toBe(true);
    }
    expect(manager.atCapacity()).toBe(true);

    const overflow = manager.createTab({ workspace: "/ws", sessionId: "s3", resume: false });
    expect(overflow).toEqual({ ok: false, reason: "max_tabs" });
    expect(manager.count()).toBe(3);

    // The binding annotation the picker uses (openInTabId).
    const firstBinding = manager.sessionOpenInTab("s0");
    expect(typeof firstBinding).toBe("string");
    expect(manager.sessionOpenInTab("nope")).toBeUndefined();
  });
});

describe("TabHostManager — credential channel (slice 2.5 §3.3)", () => {
  function credentialManager(
    fork: HostForkFn,
    window: WindowLike,
    resolveCredential: TabHostManagerDeps["resolveCredential"],
  ) {
    return new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      resolveCredential,
    });
  }

  it("answers a host credential-request on the SAME process (per-proc routing)", async () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = credentialManager(fork, window, async () => "fresh-access-token");
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    const host = hosts[0]!;
    host.emit("message", { type: CREDENTIAL_REQUEST_TYPE, requestId: "req-1" });
    await flush();
    expect(host.postMessage).toHaveBeenCalledWith({
      type: CREDENTIAL_RESPONSE_TYPE,
      requestId: "req-1",
      apiKey: "fresh-access-token",
    });
  });

  it("routes each tab's request to its own host process", async () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = credentialManager(fork, window, async () => "tok");
    manager.createTab({ workspace: "/a", sessionId: "sa", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false });
    await flush();

    const [h0, h1] = hosts;
    h0!.emit("message", { type: CREDENTIAL_REQUEST_TYPE, requestId: "A" });
    h1!.emit("message", { type: CREDENTIAL_REQUEST_TYPE, requestId: "B" });
    await flush();

    expect(h0!.postMessage).toHaveBeenCalledWith({ type: CREDENTIAL_RESPONSE_TYPE, requestId: "A", apiKey: "tok" });
    expect(h1!.postMessage).toHaveBeenCalledWith({ type: CREDENTIAL_RESPONSE_TYPE, requestId: "B", apiKey: "tok" });
    // h0 never received B's response.
    expect(h0!.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "B" }),
    );
  });

  it("responds without an apiKey when the credential cannot be resolved", async () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = credentialManager(fork, window, async () => undefined);
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    hosts[0]!.emit("message", { type: CREDENTIAL_REQUEST_TYPE, requestId: "req-x" });
    await flush();
    expect(hosts[0]!.postMessage).toHaveBeenCalledWith({ type: CREDENTIAL_RESPONSE_TYPE, requestId: "req-x" });
  });

  it("ignores a non-credential control message", async () => {
    const resolve = vi.fn(async () => "tok");
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = credentialManager(fork, window, resolve);
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    hosts[0]!.emit("message", { type: "not-a-credential-request", requestId: "z" });
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(hosts[0]!.postMessage).not.toHaveBeenCalled();
  });
});

describe("TabHostManager — connection pinning (TASK.45 W10)", () => {
  it("stamps ANYCODE_CONNECTION_ID from the tab's connectionId and keeps it across respawn", () => {
    const { hosts } = liveForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    const manager = new TabHostManager({
      fork: (_entry, _args, opts) => {
        envs.push(opts.env);
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({ PATH: "/base" }),
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-work" });
    expect(created.ok).toBe(true);
    // Respawn (sub-healthy exit still respawns below the per-tab cap).
    hosts[0]!.emit("exit", 1);
    expect(envs).toEqual([
      { PATH: "/base", ANYCODE_CONNECTION_ID: "conn-work" },
      { PATH: "/base", ANYCODE_CONNECTION_ID: "conn-work" },
    ]);
  });

  it("omits ANYCODE_CONNECTION_ID for an unpinned (legacy) tab", () => {
    const { hosts } = liveForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    const manager = new TabHostManager({
      fork: (_entry, _args, opts) => {
        envs.push(opts.env);
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({ PATH: "/base" }),
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(envs[0]).toEqual({ PATH: "/base" });
    expect(envs[0] && "ANYCODE_CONNECTION_ID" in envs[0]).toBe(false);
  });

  it("resolves the fork's base env for the tab's pinned connection id", () => {
    const seen: (string | undefined)[] = [];
    const { hosts } = liveForkRig();
    const manager = new TabHostManager({
      fork: () => {
        const host = new FakeHost();
        hosts.push(host);
        return host as unknown as UtilityProcess;
      },
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: (connectionId?: string) => {
        seen.push(connectionId);
        return { PATH: "/base" };
      },
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-42" });
    expect(seen).toEqual(["conn-42"]);
  });

  it("REFUSES to fork a pinned tab whose connection env is unavailable — never falls back (W10-FIX F3 fail-closed)", () => {
    const { window, hostExited } = windowRig();
    const forkSpy = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      // The pinned connection's per-connection env is gone (deleted mid-resume):
      // undefined must NOT fall back to the active env under this pin's id.
      env: (id?: string) => (id === "conn-gone" ? undefined : { PATH: "/base" }),
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true, connectionId: "conn-gone" });
    expect(created.ok).toBe(true);
    const tabId = created.ok ? created.tab.tabId : "";
    // Custody invariant: the wrong-account fork never happened.
    expect(forkSpy).not.toHaveBeenCalled();
    // Surfaced as a host-exit (renderer replacement flow), terminal — no respawn.
    expect(hostExited).toEqual([tabId]);
    expect(manager.getTab(tabId)?.state).toBe("crash_looped");
  });

  it("still forks a pinned tab whose connection env IS available (fail-closed is miss-only)", () => {
    const { window } = windowRig();
    const forkSpy = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: (id?: string) => (id === "conn-ok" ? { PATH: "/base" } : undefined),
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true, connectionId: "conn-ok" });
    expect(forkSpy).toHaveBeenCalledOnce();
    expect(forkSpy.mock.calls[0]?.[2].env).toEqual({ PATH: "/base", ANYCODE_CONNECTION_ID: "conn-ok" });
  });

  it("resolveCredential receives the tab's pinned connectionId (per-tab oauth routing)", async () => {
    const seen: (string | undefined)[] = [];
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      resolveCredential: async (connectionId?: string) => {
        seen.push(connectionId);
        return "tok";
      },
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-oauth" });
    await flush();
    hosts[0]!.emit("message", { type: CREDENTIAL_REQUEST_TYPE, requestId: "req-1" });
    await flush();
    expect(seen).toEqual(["conn-oauth"]);
  });

  it("pinnedConnectionIds reflects the live tabs' connections", () => {
    const { fork } = liveForkRig();
    const manager = makeManager(fork, windowRig().window);
    manager.createTab({ workspace: "/a", sessionId: "sa", resume: false, connectionId: "conn-a" });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false, connectionId: "conn-b" });
    manager.createTab({ workspace: "/c", sessionId: "sc", resume: false }); // legacy, unpinned
    expect(manager.pinnedConnectionIds()).toEqual(new Set(["conn-a", "conn-b"]));
  });
});

describe("TabHostManager — provider health event binding (TASK.45 W11)", () => {
  it("binds a health event to the PINNED connection of the host that sent it", async () => {
    const { fork, hosts } = liveForkRig();
    const seen: Array<{ connectionId: string; event: ProviderHealthEvent }> = [];
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      logger: silentLogger,
      onProviderHealthEvent: (connectionId, event) => {
        seen.push({ connectionId, event });
      },
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-work" });
    await flush();
    hosts[0]!.emit("message", { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "failure", code: "auth" });
    await flush();
    expect(seen).toEqual([
      { connectionId: "conn-work", event: { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "failure", code: "auth" } },
    ]);
  });

  it("never forwards a health event from an unpinned (legacy) tab — no connection to paint", async () => {
    const { fork, hosts } = liveForkRig();
    const seen: unknown[] = [];
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      logger: silentLogger,
      onProviderHealthEvent: (connectionId, event) => {
        seen.push({ connectionId, event });
      },
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false }); // no connectionId
    await flush();
    hosts[0]!.emit("message", { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "success" });
    await flush();
    expect(seen).toEqual([]);
  });

  it("routes each tab's own event to its OWN connectionId — never a sibling tab's", async () => {
    const { fork, hosts } = liveForkRig();
    const seen: Array<{ connectionId: string; event: ProviderHealthEvent }> = [];
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      logger: silentLogger,
      onProviderHealthEvent: (connectionId, event) => {
        seen.push({ connectionId, event });
      },
    });
    manager.createTab({ workspace: "/a", sessionId: "sa", resume: false, connectionId: "conn-a" });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false, connectionId: "conn-b" });
    await flush();
    hosts[1]!.emit("message", { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "success" });
    await flush();
    expect(seen).toEqual([
      { connectionId: "conn-b", event: { type: PROVIDER_HEALTH_EVENT_TYPE, kind: "success" } },
    ]);
  });
});

describe("TabHostManager — close guards", () => {
  it("refuses to close the last remaining tab and unknown tabs", async () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);

    const only = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(only.ok).toBe(true);

    await expect(manager.closeTab("does-not-exist")).resolves.toEqual({
      ok: false,
      reason: "unknown_tab",
    });
    await expect(manager.closeTab(only.ok ? only.tab.tabId : "")).resolves.toEqual({
      ok: false,
      reason: "last_tab",
    });
    expect(manager.count()).toBe(1);
  });

  it("closes a non-last tab, unbinding its session", async () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);

    const a = manager.createTab({ workspace: "/a", sessionId: "sa", resume: false });
    const b = manager.createTab({ workspace: "/b", sessionId: "sb", resume: false });
    expect(a.ok && b.ok).toBe(true);

    const result = await manager.closeTab(a.ok ? a.tab.tabId : "");
    expect(result).toEqual({ ok: true });
    expect(manager.count()).toBe(1);
    expect(manager.sessionOpenInTab("sa")).toBeUndefined();
    // The freed session may now be opened again.
    expect(manager.sessionOpenInTab("sb")).toBe(b.ok ? b.tab.tabId : "");
  });
});

describe("TabHostManager — dev-only host-kill lever (TASK.33 FIX-A)", () => {
  it("returns ok:false unknown_tab for a missing tab", () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);
    expect(manager.killHost("no-such-tab")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("kills the tab's live host process without marking it closing (unlike shutdownTabHost)", () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
    expect(tab).toBeDefined();

    const result = manager.killHost(tab!.tabId);

    expect(result).toEqual({ ok: true });
    expect(hosts[0]!.kill).toHaveBeenCalledTimes(1);
    // Deliberately NOT "closing" — the exit handler must still run the normal
    // unexpected-exit respawn path below, unlike shutdownTabHost's graceful close.
    expect(tab!.state).toBe("running");
  });

  it("a kill's exit runs the SAME healthy-respawn path a real crash would (fresh port pair, --resume)", async () => {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const { window, posted } = windowRig();
    let ticks = 0;
    const now = () => (ticks += 5000); // each call advances 5s -> uptime >= minHealthyUptimeMs (2000ms)
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      now,
      limits: {},
    });

    const created = manager.createTab({ workspace: "/ws", sessionId: "sess-K", resume: false });
    expect(created.ok).toBe(true);
    const tabId = created.ok ? created.tab.tabId : "";

    const result = manager.killHost(tabId);
    expect(result).toEqual({ ok: true });
    expect(hosts[0]!.kill).toHaveBeenCalledTimes(1);

    // The kill call above doesn't itself fire "exit" (a fake has no real OS
    // process) — emitting it here is what a genuine kill eventually does,
    // and this is the SAME listener spawnTabHost registered up front.
    hosts[0]!.emit("exit", 0);
    await flush();

    expect(forkSpy).toHaveBeenCalledTimes(2);
    expect(forkSpy.mock.calls[1]?.[1]).toEqual(["--resume", "sess-K"]);
    expect(manager.getTab(tabId)?.state).toBe("running");
    expect(hosts).toHaveLength(2);
    expect(hosts[1]!.pid).not.toBe(hosts[0]!.pid);

    manager.deliverTabPort(manager.getTab(tabId)!);
    expect(posted.some((p) => p.channel === PORT_ENVELOPE_TYPE)).toBe(true);
  });
});

describe("TabHostManager — terminal channel delivery (design §3.2, slice 2.4.2)", () => {
  it("deliverTabPort hands out a UI channel AND a disjoint terminal channel", async () => {
    const { fork, hosts } = liveForkRig();
    const { window, posted } = windowRig();
    const manager = makeManager(fork, window);

    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    expect(created.ok).toBe(true);
    await flush();
    const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
    expect(tab).toBeDefined();

    // createTab does not deliver ports itself (design §2.2); the caller (main's
    // create-tab flow, outside this manager) does that once the renderer exists.
    const host = hosts[0]!;
    expect(host.postMessage).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);

    manager.deliverTabPort(tab!);

    // Two distinct control-plane messages went to the host proc: the UI init
    // (unchanged type/shape) and the NEW terminal init, each carrying its own
    // transferred port.
    expect(host.postMessage).toHaveBeenCalledTimes(2);
    const [uiProcCall, termProcCall] = host.postMessage.mock.calls as Array<
      [{ type: string }, MessagePortMain[]]
    >;
    expect(uiProcCall![0].type).not.toBe(TERMINAL_INIT_MESSAGE_TYPE);
    expect(termProcCall![0]).toEqual({ type: TERMINAL_INIT_MESSAGE_TYPE });
    const uiPort1 = uiProcCall![1][0];
    const termPort1 = termProcCall![1][0];
    expect(termPort1).not.toBe(uiPort1);

    // Two distinct envelopes went to the renderer: the UI port envelope
    // (unchanged {tabId, workspace} shape) and the NEW term-port envelope
    // ({tabId} only — no workspace, per §3.1).
    expect(posted).toHaveLength(2);
    const uiEnvelope = posted.find((p) => p.channel === PORT_ENVELOPE_TYPE);
    const termEnvelope = posted.find((p) => p.channel === TERMINAL_PORT_ENVELOPE_TYPE);
    expect(uiEnvelope?.payload).toEqual({ tabId: tab!.tabId, workspace: "/ws" });
    expect(termEnvelope?.payload).toEqual({ tabId: tab!.tabId });
    const uiPort2 = uiEnvelope?.ports?.[0];
    const termPort2 = termEnvelope?.ports?.[0];
    expect(termPort2).not.toBe(uiPort2);
  });

  it("guards: no host proc -> neither channel is delivered", () => {
    const { fork } = liveForkRig();
    const { window, posted } = windowRig();
    const manager = makeManager(fork, window);

    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
    expect(tab).toBeDefined();
    tab!.proc = null;

    manager.deliverTabPort(tab!);

    expect(posted).toHaveLength(0);
  });

  it("guards: no window -> neither channel is delivered (host untouched)", async () => {
    const { fork, hosts } = liveForkRig();
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => null,
      env: () => ({}),
      logger: silentLogger,
    });

    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();
    const tab = created.ok ? manager.getTab(created.tab.tabId) : undefined;
    expect(tab).toBeDefined();

    manager.deliverTabPort(tab!);

    expect(hosts[0]!.postMessage).not.toHaveBeenCalled();
  });

  it("deliverAllTabPorts redelivers BOTH channels to every live tab", async () => {
    const { fork, hosts } = liveForkRig();
    const { window, posted } = windowRig();
    const manager = makeManager(fork, window);

    manager.createTab({ workspace: "/a", sessionId: "sa", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false });
    await flush();

    manager.deliverAllTabPorts();

    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      expect(host.postMessage).toHaveBeenCalledTimes(2);
    }
    // 2 tabs x 2 envelopes (UI + term) each.
    expect(posted.filter((p) => p.channel === PORT_ENVELOPE_TYPE)).toHaveLength(2);
    expect(posted.filter((p) => p.channel === TERMINAL_PORT_ENVELOPE_TYPE)).toHaveLength(2);
  });

  it("respawn redelivers BOTH channels with a fresh port pair (not reused across respawns)", async () => {
    const { fork, hosts } = dyingForkRig();
    const { window, posted } = windowRig();
    // Force exactly one respawn: the first fork is "rapid" (uptime ~0), the
    // breaker allows one respawn before giving up.
    const manager = makeManager(fork, window, { maxRapidRespawns: 1, globalMaxRapidRespawns: 5 });

    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    // 1 initial fork + 1 respawn = 2 hosts; the respawned host got both
    // channels delivered by handleExit's `deliverTabPort` call.
    expect(hosts).toHaveLength(2);
    const respawnedHost = hosts[1]!;
    expect(respawnedHost.postMessage).toHaveBeenCalledTimes(2);
    const termCall = respawnedHost.postMessage.mock.calls.find(
      (call) => (call[0] as { type: string }).type === TERMINAL_INIT_MESSAGE_TYPE,
    );
    expect(termCall).toBeDefined();
    expect(posted.filter((p) => p.channel === TERMINAL_PORT_ENVELOPE_TYPE)).toHaveLength(1);
    expect(posted.filter((p) => p.channel === PORT_ENVELOPE_TYPE)).toHaveLength(1);
  });
});
