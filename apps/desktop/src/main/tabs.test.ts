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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { CREDENTIAL_REQUEST_TYPE, CREDENTIAL_RESPONSE_TYPE } from "../shared/credentials.js";
import { PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { TERMINAL_INIT_MESSAGE_TYPE, TERMINAL_PORT_ENVELOPE_TYPE } from "../shared/terminal.js";
import {
  PREVIEW_ARTIFACTS_TYPE,
  PREVIEW_REQUEST_TYPE,
  type PreviewArtifactsMessage,
  type PreviewRequestMessage,
} from "../shared/preview.js";
import type { EngineId } from "../shared/engines.js";
import {
  CHILD_PROGRESS_TYPE,
  CHILD_READY_TYPE,
  CHILD_RUNS_GLOBAL_MAX,
  CHILD_RUNS_PER_PARENT_MAX,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  CHILD_START_DEADLINE_MS,
  CHILD_START_TYPE,
  CHILD_TERMINAL_TYPE,
  type ChildRunEvent,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";
import {
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeTransitionMessage,
} from "../shared/worktrees.js";
import { ENV_MODEL } from "./host-env.js";
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

// ── TASK.102 CUT-S2 S2b/B3 fixtures: child-session control-plane messages ──
// Every fixture below is a WELL-FORMED wire message — tests drive the
// manager exclusively via `host.emit("message", ...)` on a fake host's
// process (anti-facade §5.2: never call a private spawn method directly),
// mirroring the credential-channel tests' existing style above.

let requestSeq = 0;

/** A valid ChildSpawnRequest (shared/child-sessions.ts's own shape); each call mints a fresh requestId unless overridden. */
function spawnRequest(overrides: Partial<ChildSpawnRequest> = {}): ChildSpawnRequest {
  requestSeq += 1;
  return {
    type: CHILD_SPAWN_REQUEST_TYPE,
    requestId: `req-${requestSeq}`,
    spawnToolCallId: `call-${requestSeq}`,
    agentType: "general-purpose",
    description: "test child",
    prompt: "do something",
    permissionMode: "build",
    ...overrides,
  };
}

function runCancel(requestId: string) {
  return { type: CHILD_RUN_CANCEL_TYPE, requestId } as const;
}

function childReadyMsg() {
  return { type: CHILD_READY_TYPE } as const;
}

function childTerminalMsg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: CHILD_TERMINAL_TYPE,
    status: "completed",
    finalText: "done",
    truncated: false,
    turns: 1,
    toolCalls: 0,
    durationMs: 50,
    ...overrides,
  };
}

function childActivityMsg(toolName: string, summary: string) {
  return { type: CHILD_PROGRESS_TYPE, kind: "activity", toolName, summary } as const;
}

function childAttentionMsg(waiting: boolean) {
  return { type: CHILD_PROGRESS_TYPE, kind: "attention", waiting } as const;
}

function childProgressMsg(overrides: { turns?: number; toolCalls?: number; lastTool?: string } = {}) {
  return {
    type: CHILD_PROGRESS_TYPE,
    kind: "progress",
    turns: 3,
    toolCalls: 2,
    ...overrides,
  } as const;
}

/** Every ChildRunEvent posted to a fake host, in call order. */
function childRunEvents(host: FakeHost): ChildRunEvent[] {
  return host.postMessage.mock.calls
    .map((call) => call[0] as { type?: unknown })
    .filter((msg): msg is ChildRunEvent => msg.type === CHILD_RUN_EVENT_TYPE);
}

/**
 * A fork whose hosts stay alive indefinitely UNLESS asked to shut down (a
 * `{type:"shutdown"}` postMessage, `shutdownTabHost`'s own signal), in which
 * case they exit on the next microtask — the realistic behavior a graceful
 * `closeTab`/cascade-cancel race depends on, without a real OS process or a
 * real multi-second `exitDeadlineMs` wait. Used as the default rig for the
 * child-session suites below; a test that wants to simulate an UNEXPECTED
 * crash instead just emits `"exit"` directly, bypassing this responder.
 */
function shutdownableForkRig(): ForkRig {
  const hosts: FakeHost[] = [];
  const fork: HostForkFn = () => {
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
    host.postMessage.mockImplementation((msg: unknown) => {
      if ((msg as { type?: unknown }).type === "shutdown") {
        queueMicrotask(() => host.emit("exit", 0));
      }
    });
    return host as unknown as UtilityProcess;
  };
  return { fork, hosts };
}

/** Convenience: a manager whose core engine is ready and every provider resolves 1:1 by name (test default). */
function childManager(fork: HostForkFn, window: WindowLike, overrides: Partial<TabHostManagerDeps> = {}) {
  return new TabHostManager({
    fork,
    hostEntry: "/fake/host.js",
    createChannel: fakeChannel,
    getWindow: () => window,
    env: () => ({ PATH: "/base" }),
    logger: silentLogger,
    limits: {},
    ...overrides,
  });
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

  // Codex-profiles TASK.50 (cut §2.6.4, §3.3): main resolves the picked
  // profile against ITS registry (lane A) and hands tabs.ts READY argv values;
  // tabs.ts only forwards them. Unlike the draft model/preset (whose post-boot
  // authority is the session row), the profile has NO session-row fallback —
  // CODEX_HOME is frozen into the session — so it rides EVERY spawn, respawn
  // included: a respawn without it would resume the thread against the
  // ambient home, i.e. the wrong account.
  it("carries the resolved Codex profile argv on EVERY spawn — respawns included, unlike the draft model", async () => {
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
      sessionId: "sess-P",
      resume: false,
      engine: "codex",
      engineModel: "gpt-5.6-sol",
      codexProfile: { id: "main", authLink: "/Users/x/.codex/auth.json" },
    });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual([
      "--session",
      "sess-P",
      "--engine-model",
      "gpt-5.6-sol",
      "--codex-profile",
      "main",
      "--codex-auth-link",
      "/Users/x/.codex/auth.json",
    ]);
    // The respawn drops the draft model (session row is its authority) but
    // KEEPS the profile (nothing else knows which home this session lives in).
    expect(forkSpy.mock.calls[1]?.[1]).toEqual([
      "--resume",
      "sess-P",
      "--codex-profile",
      "main",
      "--codex-auth-link",
      "/Users/x/.codex/auth.json",
    ]);
  });

  it("a linkedHome profile rides argv as --codex-home (already validated by main's registry)", async () => {
    const { hosts } = liveForkRig();
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const manager = codexManager(forkSpy);
    manager.createTab({
      workspace: "/ws",
      sessionId: "sess-L",
      resume: false,
      engine: "codex",
      codexProfile: { id: "acc2", home: "/Users/x/.codex-accounts/acc2" },
    });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual([
      "--session",
      "sess-L",
      "--codex-profile",
      "acc2",
      "--codex-home",
      "/Users/x/.codex-accounts/acc2",
    ]);
  });

  it("without a profile the argv stays byte-identical to the pre-profiles build (system pseudo-profile)", async () => {
    const { hosts } = liveForkRig();
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const manager = codexManager(forkSpy);
    manager.createTab({ workspace: "/ws", sessionId: "sess-S", resume: false, engine: "codex" });
    await flush();

    expect(forkSpy.mock.calls[0]?.[1]).toEqual(["--session", "sess-S"]);
  });
});

describe("TabHostManager — readiness gate keys on the PICKED Codex profile (S3-1)", () => {
  // The authoritative createTab guard must ask the readiness oracle about the
  // profile the spawn will actually run under, not the active one. Injected
  // oracle: only "ready-x" is ready; the ambient/active answer (undefined) is
  // NOT — so a rollback that keys the gate on the active profile flips these RED.
  function gatedManager(
    engineReady: (engine: EngineId, codexProfileId?: string) => boolean,
    fork: HostForkFn,
  ) {
    return new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      engineReady,
      logger: silentLogger,
      limits: {},
    });
  }

  it('a ready PICK spawns and the gate saw ("codex", pickedId) — not the active undefined', () => {
    const { fork, hosts } = liveForkRig();
    const engineReady = vi.fn((_engine: EngineId, codexProfileId?: string) => codexProfileId === "ready-x");
    const manager = gatedManager(engineReady, fork);

    const created = manager.createTab({
      workspace: "/ws",
      sessionId: "s-ready-pick",
      resume: false,
      engine: "codex",
      codexProfile: { id: "ready-x" },
    });

    expect(created).toMatchObject({ ok: true });
    expect(hosts).toHaveLength(1);
    expect(engineReady).toHaveBeenCalledWith("codex", "ready-x");
  });

  it("negative holds: a PICK the gate reports NOT ready refuses not_ready and never forks", () => {
    const forkSpy = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const engineReady = vi.fn((_engine: EngineId, codexProfileId?: string) => codexProfileId === "ready-x");
    const manager = gatedManager(engineReady, forkSpy);

    const created = manager.createTab({
      workspace: "/ws",
      sessionId: "s-not-ready-pick",
      resume: false,
      engine: "codex",
      codexProfile: { id: "not-ready-y" },
    });

    expect(created).toEqual({ ok: false, reason: "not_ready" });
    expect(engineReady).toHaveBeenCalledWith("codex", "not-ready-y");
    expect(forkSpy).not.toHaveBeenCalled();
  });

  it("an absent pick preserves the active-profile answer (no symmetry): canSpawn defaults the id to undefined", () => {
    const { fork } = liveForkRig();
    const engineReady = vi.fn((_engine: EngineId, codexProfileId?: string) => codexProfileId === undefined);
    const manager = gatedManager(engineReady, fork);

    expect(manager.canSpawn("codex")).toBe(true);
    const lastCall = engineReady.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("codex");
    expect(lastCall?.[1]).toBeUndefined();
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

describe("TabHostManager — imported-session model override (codex-profiles S4-1 arm 2, W4-F1)", () => {
  it("stamps ANYCODE_MODEL from the tab's modelOverride over the base env's model, and keeps it across respawn", () => {
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
      // Base env carries the ACTIVE connection's model; the picked override must win.
      env: () => ({ PATH: "/base", ANYCODE_MODEL: "base-m" }),
      logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true, modelOverride: "pick-x" });
    expect(created.ok).toBe(true);
    // Respawn (sub-healthy exit still respawns below the per-tab cap): the override
    // lives on the tab object, so the picked model rides every fork.
    hosts[0]!.emit("exit", 1);
    expect(envs).toEqual([
      { PATH: "/base", ANYCODE_MODEL: "pick-x" },
      { PATH: "/base", ANYCODE_MODEL: "pick-x" },
    ]);
  });

  it("omits any ANYCODE_MODEL override for a tab with no modelOverride (base env's model untouched)", () => {
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
      env: () => ({ PATH: "/base", ANYCODE_MODEL: "base-m" }),
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true });
    // No override ⇒ the base env's model passes through verbatim (byte-as-today).
    expect(envs[0]).toEqual({ PATH: "/base", ANYCODE_MODEL: "base-m" });
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

  function pinEnvelopeManager(window: WindowLike, describeConnection?: TabHostManagerDeps["describeConnection"]) {
    return new TabHostManager({
      fork: liveForkRig().fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      describeConnection,
      logger: silentLogger,
    });
  }

  it("tab-port envelope carries the PINNED connection's {connectionId, providerId} (W10-FIX F2)", () => {
    const { window, posted } = windowRig();
    const manager = pinEnvelopeManager(window, (id) => (id === "conn-A" ? { providerId: "prov-A" } : undefined));
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true, connectionId: "conn-A" });
    manager.deliverTabPort(manager.getTab(created.ok ? created.tab.tabId : "")!);
    const payload = posted.find((p) => p.channel === PORT_ENVELOPE_TYPE)?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ connectionId: "conn-A", providerId: "prov-A" });
  });

  it("tab-port envelope OMITS pin fields for an unpinned (legacy) tab (W10-FIX F2)", () => {
    const { window, posted } = windowRig();
    const manager = pinEnvelopeManager(window, () => ({ providerId: "prov-A" }));
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    manager.deliverTabPort(manager.getTab(created.ok ? created.tab.tabId : "")!);
    const payload = posted.find((p) => p.channel === PORT_ENVELOPE_TYPE)?.payload as Record<string, unknown>;
    expect("connectionId" in payload).toBe(false);
    expect("providerId" in payload).toBe(false);
  });

  it("tab-port envelope OMITS pin fields when the pinned connection is gone (W10-FIX F2)", () => {
    const { window, posted } = windowRig();
    const manager = pinEnvelopeManager(window, () => undefined); // connection deleted
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: true, connectionId: "conn-gone" });
    manager.deliverTabPort(manager.getTab(created.ok ? created.tab.tabId : "")!);
    const payload = posted.find((p) => p.channel === PORT_ENVELOPE_TYPE)?.payload as Record<string, unknown>;
    expect("connectionId" in payload).toBe(false);
    expect("providerId" in payload).toBe(false);
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

describe("TabHostManager — preview control plane (night-track wave-1 cut §2.3, 96-A)", () => {
  function previewManager(
    fork: HostForkFn,
    window: WindowLike,
    deps: Partial<
      Pick<TabHostManagerDeps, "onPreviewRequest" | "onPreviewArtifacts" | "onTabClosed">
    >,
  ) {
    return new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      ...deps,
    });
  }

  it("routes a PREVIEW_REQUEST_TYPE control message to onPreviewRequest, tabId-scoped", async () => {
    const onPreviewRequest = vi.fn();
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onPreviewRequest });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();
    expect(created.ok).toBe(true);
    const tabId = created.ok ? created.tab.tabId : "";

    const message: PreviewRequestMessage = {
      type: PREVIEW_REQUEST_TYPE,
      requestId: "req-1",
      op: { kind: "screenshot" },
    };
    hosts[0]!.emit("message", message);
    await flush();

    expect(onPreviewRequest).toHaveBeenCalledWith(tabId, message);
  });

  it("routes a PREVIEW_ARTIFACTS_TYPE control message to onPreviewArtifacts, tabId-scoped", async () => {
    const onPreviewArtifacts = vi.fn();
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onPreviewArtifacts });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();
    const tabId = created.ok ? created.tab.tabId : "";

    const message: PreviewArtifactsMessage = { type: PREVIEW_ARTIFACTS_TYPE, paths: ["/ws/out.html"] };
    hosts[0]!.emit("message", message);
    await flush();

    expect(onPreviewArtifacts).toHaveBeenCalledWith(tabId, message);
  });

  it("routes each tab's preview messages to its own binding, never a sibling's", async () => {
    const onPreviewRequest = vi.fn();
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onPreviewRequest });
    const a = manager.createTab({ workspace: "/a", sessionId: "sa", resume: false });
    const b = manager.createTab({ workspace: "/b", sessionId: "sb", resume: false });
    await flush();
    const [h0, h1] = hosts;

    const msgA: PreviewRequestMessage = { type: PREVIEW_REQUEST_TYPE, requestId: "A", op: { kind: "screenshot" } };
    const msgB: PreviewRequestMessage = { type: PREVIEW_REQUEST_TYPE, requestId: "B", op: { kind: "screenshot" } };
    h0!.emit("message", msgA);
    h1!.emit("message", msgB);
    await flush();

    expect(onPreviewRequest).toHaveBeenCalledWith(a.ok ? a.tab.tabId : "", msgA);
    expect(onPreviewRequest).toHaveBeenCalledWith(b.ok ? b.tab.tabId : "", msgB);
  });

  it("fires onTabClosed on a real close, with the closed tab's id", async () => {
    const onTabClosed = vi.fn();
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onTabClosed });
    const a = manager.createTab({ workspace: "/a", sessionId: "sa", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false });
    await flush();

    const tabId = a.ok ? a.tab.tabId : "";
    await manager.closeTab(tabId);

    expect(onTabClosed).toHaveBeenCalledExactlyOnceWith(tabId);
  });

  it("does NOT fire onTabClosed for a refused close (last_tab / unknown_tab)", async () => {
    const onTabClosed = vi.fn();
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onTabClosed });
    const only = manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    await manager.closeTab("does-not-exist");
    await manager.closeTab(only.ok ? only.tab.tabId : "");

    expect(onTabClosed).not.toHaveBeenCalled();
  });

  it("does NOT fire onTabClosed on a crash-triggered respawn (respawn is NOT a close)", async () => {
    const onTabClosed = vi.fn();
    const { fork, hosts } = dyingForkRig();
    const { window } = windowRig();
    const manager = previewManager(fork, window, { onTabClosed });
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();

    // dyingForkRig's fork crash-loops (uptime ~0) until the per-tab breaker gives
    // up — several respawns happen here, none of them a real close.
    expect(hosts.length).toBeGreaterThan(1);
    expect(onTabClosed).not.toHaveBeenCalled();
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

/**
 * SLICE-CC C5 (cut §1.4): the canSpawn flip. CC-A's `if (engine === "claude")
 * return false` is gone, so `claude` now answers from `isEngineReady` — the
 * doctor's confirmed readiness — exactly like every other engine.
 *
 * These replace CC-A's "unconditionally false" block, which asserted the very
 * behaviour this slice removes and could not survive the flip.
 */
describe("TabHostManager — canSpawn(\"claude\") follows doctor readiness (SLICE-CC C5, cut §1.4)", () => {
  function managerWith(engineReady: (engine: EngineId, codexProfileId?: string) => boolean, fork: HostForkFn) {
    return new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      engineReady,
      logger: silentLogger,
      limits: {},
    });
  }

  it("a ready doctor now lets claude spawn — and the readiness oracle is actually consulted", () => {
    const { fork } = liveForkRig();
    const engineReady = vi.fn((_engine: EngineId) => true);
    const manager = managerWith(engineReady, fork);

    expect(manager.canSpawn("claude")).toBe(true);
    // Discriminating against a partial rollback: restoring the CC-A hard block
    // would short-circuit before the oracle is asked, so this call is the proof
    // that claude reaches the shared readiness path rather than a claude-shaped
    // special case that happens to return true.
    expect(engineReady).toHaveBeenCalledWith("claude", undefined);
  });

  it("an unready doctor still refuses — the flip delegates the gate, it does not remove it", () => {
    const { fork } = liveForkRig();
    const manager = managerWith((engine) => engine !== "claude", fork);

    expect(manager.canSpawn("claude")).toBe(false);
    expect(manager.canSpawn("core")).toBe(true);
    expect(manager.canSpawn("codex")).toBe(true);
  });

  it("createTab forks a claude host when ready, and refuses not_ready without forking when not", () => {
    const readyFork = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const ready = managerWith(() => true, readyFork);
    expect(ready.createTab({ workspace: "/ws", sessionId: "s-claude", resume: false, engine: "claude" }).ok).toBe(true);
    expect(readyFork).toHaveBeenCalled();

    const blockedFork = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const blocked = managerWith((engine) => engine !== "claude", blockedFork);
    expect(blocked.createTab({ workspace: "/ws", sessionId: "s-claude-2", resume: false, engine: "claude" })).toEqual({
      ok: false,
      reason: "not_ready",
    });
    expect(blockedFork).not.toHaveBeenCalled();
  });

  it("the ENGINES_LIST projection (tab-ipc.ts) therefore contains claude iff the doctor is ready", () => {
    // The renderer's `availableEngines` is exactly this filter over canSpawn
    // (tab-ipc.ts's ENGINES_LIST handler); StartScreen's
    // `shouldShowClaudeEngineButton` consumes its output, so these two
    // assertions are the two halves of the button's visibility.
    const { fork } = liveForkRig();
    const candidates = ["core", "codex", "claude"] as const;

    const ready = managerWith(() => true, fork);
    expect(candidates.filter((engine) => ready.canSpawn(engine))).toContain("claude");

    const unready = managerWith((engine) => engine !== "claude", fork);
    expect(candidates.filter((engine) => unready.canSpawn(engine))).not.toContain("claude");
  });
});

/**
 * TASK.102 CUT-S2 §2.6.4 / §3 "S2b — B3": main-process admission, quotas,
 * spawn, and cascades for `Agent(tier:"session")` child sessions. Every test
 * below drives the manager exclusively via `host.emit("message", ...)` on a
 * fake host process (never a private method directly — anti-facade §5.2)
 * mirroring the existing credential-channel tests' style above. `hosts` (from
 * `shutdownableForkRig`) accumulates EVERY forked process — root and child
 * alike — in fork-call order, so `hosts[0]` is always the first root, and a
 * spawned child lands at whatever index its fork call landed at.
 */
describe("TabHostManager — child-session admission is ATOMIC (TASK.102 CUT-S2 B3)", () => {
  it("4 synchronous spawns from the SAME parent, no await between them, admit exactly 3 and refuse the 4th limit_parent", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-atomic", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    // Zero awaits between these four emits — the whole point of the test:
    // if admission read the quota BEFORE reserving it across an await, all
    // four could see "0 running" and all four would be admitted.
    rootHost.emit("message", spawnRequest({ requestId: "r1" }));
    rootHost.emit("message", spawnRequest({ requestId: "r2" }));
    rootHost.emit("message", spawnRequest({ requestId: "r3" }));
    rootHost.emit("message", spawnRequest({ requestId: "r4" }));

    const events = childRunEvents(rootHost);
    const accepted = events.filter((e) => e.kind === "accepted");
    const rejected = events.filter((e) => e.kind === "rejected");
    expect(accepted).toHaveLength(CHILD_RUNS_PER_PARENT_MAX);
    expect(accepted.map((e) => e.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(rejected).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "r4",
        kind: "rejected",
        reason: "limit_parent",
        message:
          'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".',
      },
    ]);
    // 1 root + 3 admitted children forked; the 4th never reached fork at all.
    expect(hosts).toHaveLength(1 + CHILD_RUNS_PER_PARENT_MAX);
  });

  it("the 9th global spawn (spread across 3 parents, each under ITS OWN per-parent cap) is refused limit_global", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);

    for (let n = 0; n < 3; n++) {
      const r = manager.createTab({ workspace: "/ws", sessionId: `root-g${n}`, resume: false });
      expect(r.ok).toBe(true);
    }
    const rootHosts = [hosts[0]!, hosts[1]!, hosts[2]!];
    const perParentCounts = [3, 3, 2]; // sums to 8 — the global cap — none tripping limit_parent (max 3)

    for (let p = 0; p < 3; p++) {
      for (let n = 0; n < perParentCounts[p]!; n++) {
        rootHosts[p]!.emit("message", spawnRequest({ requestId: `p${p}-${n}` }));
      }
    }
    for (let p = 0; p < 3; p++) {
      expect(childRunEvents(rootHosts[p]!).filter((e) => e.kind === "accepted")).toHaveLength(perParentCounts[p]!);
    }

    // A 9th spawn from the parent that still has per-parent room (2 of 3 used).
    rootHosts[2]!.emit("message", spawnRequest({ requestId: "p2-overflow" }));
    expect(childRunEvents(rootHosts[2]!).filter((e) => e.requestId === "p2-overflow")).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "p2-overflow",
        kind: "rejected",
        reason: "limit_global",
        message:
          'Agent: application-wide session-subagent limit reached (8 running child sessions). No child was started. Wait for one to finish, or use tier "inline".',
      },
    ]);
    expect(hosts).toHaveLength(3 + 8); // 3 roots + exactly 8 children, the 9th never forked
  });

  it("the core engine being unready refuses not_ready without reserving a slot", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let ready = true;
    const manager = childManager(fork, window, { engineReady: (engine) => engine === "core" && ready });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-notready", resume: false });
    expect(root.ok).toBe(true); // root creation happened while ready
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    ready = false;
    rootHost.emit("message", spawnRequest({ requestId: "engine-down" }));

    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "engine-down",
        kind: "rejected",
        reason: "not_ready",
        message: expect.any(String),
      },
    ]);
    expect(hosts).toHaveLength(hostsBefore); // no fork attempted
  });

  it("an EXPLICIT known provider resolves via resolveProviderConnection — its connectionId (not the parent's) rides the child's fork env", () => {
    const { hosts } = shutdownableForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, opts) => {
      envs.push(opts.env);
      const host = new FakeHost();
      hosts.push(host);
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window, {
      resolveProviderConnection: (provider) => (provider === "known" ? "conn-known" : undefined),
    });
    const root = manager.createTab({
      workspace: "/ws",
      sessionId: "root-provider",
      resume: false,
      connectionId: "conn-parent",
    });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "prov-1", provider: "known" }));

    expect(envs[1]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-known" });
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "prov-1");
    expect(accepted).toMatchObject({ kind: "accepted" });
  });

  it("an UNKNOWN provider is refused not_ready with the exact §2.7 text, and never forks", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { resolveProviderConnection: () => undefined });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-badprovider", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "ghost-provider", provider: "ghost" }));

    expect(hosts).toHaveLength(hostsBefore);
    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "ghost-provider",
        kind: "rejected",
        reason: "not_ready",
        message:
          'Agent: provider connection "ghost" is not available in this host. Omit "provider" to use the parent session\'s connection.',
      },
    ]);
  });

  it("a child WITHOUT an explicit connectionId inherits the ACTUAL parent tab's pinned connection, never a sibling's or a payload value (there is no such field on the wire)", () => {
    const { hosts } = shutdownableForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, opts) => {
      envs.push(opts.env);
      const host = new FakeHost();
      hosts.push(host);
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-conn-a", resume: false, connectionId: "conn-a" });
    const b = manager.createTab({ workspace: "/b", sessionId: "root-conn-b", resume: false, connectionId: "conn-b" });
    expect(a.ok && b.ok).toBe(true);
    const [hostA, hostB] = hosts; // envs[0]=A root fork, envs[1]=B root fork

    hostA!.emit("message", spawnRequest({ requestId: "from-a" }));
    hostB!.emit("message", spawnRequest({ requestId: "from-b" }));

    expect(envs[2]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-a" });
    expect(envs[3]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-b" });
  });

  it("accepted.model is the explicit request model when given, else the resolved connection's own configured model", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { env: () => ({ PATH: "/base", [ENV_MODEL]: "connection-default" }) });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-model", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "explicit-model", model: "gpt-exotic" }));
    rootHost.emit("message", spawnRequest({ requestId: "implicit-model" }));

    const events = childRunEvents(rootHost).filter((e) => e.kind === "accepted");
    expect(events.find((e) => e.requestId === "explicit-model")).toMatchObject({ model: "gpt-exotic" });
    expect(events.find((e) => e.requestId === "implicit-model")).toMatchObject({ model: "connection-default" });
  });

  it("a throwing fork rolls back the reservation — replies spawn_failed, and a LATER spawn is admitted normally (the slot was truly freed, not left dangling)", () => {
    const { hosts } = shutdownableForkRig();
    let calls = 0;
    const forkSpy = vi.fn<HostForkFn>(() => {
      calls++;
      if (calls === 2) {
        throw new Error("boom: OS refused the fork");
      }
      const host = new FakeHost();
      hosts.push(host);
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-throw", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "boom" }));
    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "boom",
        kind: "rejected",
        reason: "spawn_failed",
        message: "Agent: the child session failed to start.",
      },
    ]);

    // The slot was rolled back: the FULL per-parent cap now succeeds.
    rootHost.emit("message", spawnRequest({ requestId: "ok-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "ok-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "ok-3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);
  });

  it("a resolved connection whose env is unavailable ALSO rolls back and replies spawn_failed (the non-throwing W10-FIX F3 fork-failure path)", () => {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window, {
      // The PARENT root's own connection resolves fine; only the CHILD's
      // explicitly-requested provider resolves to a connection whose env is gone.
      env: (connectionId) => (connectionId === "conn-gone" ? undefined : { PATH: "/base" }),
      resolveProviderConnection: () => "conn-gone",
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-envgone", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "env-gone", provider: "anything" }));

    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "env-gone",
        kind: "rejected",
        reason: "spawn_failed",
        message: "Agent: the child session failed to start.",
      },
    ]);
    expect(hosts).toHaveLength(hostsBefore); // spawnTabHost's soft-fail path never reaches fork()
  });

  it("cancelling a run holds its slot until the REAL reap — a 4th spawn stays limit_parent until the cancelled child actually exits, then succeeds", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-cancel-holds", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "hold-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "hold-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "hold-3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);
    const child1Host = hosts[1]!;

    rootHost.emit("message", runCancel("hold-1"));
    expect(child1Host.postMessage).toHaveBeenCalledWith({ type: "shutdown" });

    // Still refused: cancelling still occupies the slot.
    rootHost.emit("message", spawnRequest({ requestId: "too-soon" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "too-soon")).toMatchObject({
      kind: "rejected",
      reason: "limit_parent",
    });

    // The cancelled child ACTUALLY exits now (shutdownableForkRig's auto-responder
    // already queued this on a microtask from the shutdown postMessage above, but
    // emitting explicitly here keeps the test's causality readable and robust to
    // any change in that timing).
    child1Host.emit("exit", 0);

    rootHost.emit("message", spawnRequest({ requestId: "after-reap" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "after-reap")).toMatchObject({ kind: "accepted" });
    const terminalForHold1 = childRunEvents(rootHost).find((e) => e.requestId === "hold-1" && e.kind === "terminal");
    expect(terminalForHold1).toMatchObject({ status: "cancelled" });
  });
});

describe("TabHostManager — non-recursion lock #3: a child cannot spawn its own child (TASK.102 CUT-S2 §0.2)", () => {
  it("a spawn request from a tab that IS a child is rejected recursion, replied to on the CHILD's OWN process — the root never sees it, and nothing is forked", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-recursion", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "legit-child" }));
    const childHost = hosts[1]!;
    const hostsBefore = hosts.length;

    childHost.emit("message", spawnRequest({ requestId: "grandchild-attempt" }));

    expect(childRunEvents(childHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "grandchild-attempt",
        kind: "rejected",
        reason: "recursion",
        message: 'Agent: a child session cannot spawn its own child sessions. Use tier "inline".',
      },
    ]);
    expect(childRunEvents(rootHost).some((e) => e.requestId === "grandchild-attempt")).toBe(false);
    expect(hosts).toHaveLength(hostsBefore); // no grandchild process forked
  });
});

describe("TabHostManager — spawn around a root's close: seal + cascade drain (TASK.102 CUT-S2 §2.6.4/anti-facade §5.8)", () => {
  it("a spawn request that arrives after closeTab's synchronous seal is rejected closing — the seal precedes ANY await inside closeTab", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-seal-a", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "root-seal-b", resume: false }); // 2nd root: close(a) isn't last_tab-refused
    expect(a.ok).toBe(true);
    const rootTabId = a.ok ? a.tab.tabId : "";
    const rootHost = hosts[0]!;

    const closing = manager.closeTab(rootTabId); // seals tab.state="closing" synchronously before this line returns
    rootHost.emit("message", spawnRequest({ requestId: "too-late" }));

    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "too-late",
        kind: "rejected",
        reason: "closing",
        message: "Agent: the child session could not be started (host is closing).",
      },
    ]);
    await closing;
  });

  it("close on a root with a running child cancels it, relays a cancelled terminal, reaps the child, and leaves the child index empty — spawn-before-close is swept by the drain loop", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-cascade-a", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "root-cascade-b", resume: false });
    expect(a.ok).toBe(true);
    const rootTabId = a.ok ? a.tab.tabId : "";
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "cascade-1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "cascade-1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(manager.getTab(childTabId)).toBeDefined();

    const result = await manager.closeTab(rootTabId);

    expect(result).toEqual({ ok: true });
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "cascade-1" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "cancelled" });
    expect(manager.getTab(childTabId)).toBeUndefined();
    expect(manager.getTab(rootTabId)).toBeUndefined();
    expect(manager.listTabs().some((t) => t.childOf !== undefined)).toBe(false);
  });

  it("public closeTab(childTabId) reports unknown_tab — a child is never externally addressable", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-unknown", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "root-unknown-2", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "u1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "u1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";

    await expect(manager.closeTab(childTabId)).resolves.toEqual({ ok: false, reason: "unknown_tab" });
    expect(manager.getTab(childTabId)).toBeDefined(); // untouched by the refused close
  });

  it("last_tab counts ROOTS only, in both directions", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);

    // Direction 1 (children must not falsely UNBLOCK a close): a lone root
    // with 2 children must still refuse close, even though `tabs.size` is 3.
    const solo = manager.createTab({ workspace: "/solo", sessionId: "root-solo", resume: false });
    expect(solo.ok).toBe(true);
    const soloTabId = solo.ok ? solo.tab.tabId : "";
    const soloHost = hosts[0]!;
    soloHost.emit("message", spawnRequest({ requestId: "solo-1" }));
    soloHost.emit("message", spawnRequest({ requestId: "solo-2" }));
    await expect(manager.closeTab(soloTabId)).resolves.toEqual({ ok: false, reason: "last_tab" });

    // Direction 2 (children must not falsely BLOCK a close): with a SECOND
    // root now present, closing the (childless) second root succeeds — the
    // first root's children never counted as extra roots either way.
    const second = manager.createTab({ workspace: "/second", sessionId: "root-second", resume: false });
    expect(second.ok).toBe(true);
    const secondTabId = second.ok ? second.tab.tabId : "";
    await expect(manager.closeTab(secondTabId)).resolves.toEqual({ ok: true });
  });
});

describe("TabHostManager — crashed root cancels its children BEFORE respawning (TASK.102 CUT-S2 §0.6)", () => {
  it("cancellation is synchronously INITIATED before the respawn's fork call", () => {
    const hosts: FakeHost[] = [];
    const order: string[] = [];
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-crash-cascade", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "doomed-child" }));
    expect(hosts).toHaveLength(2); // root + child, both synchronous
    const childHost = hosts[1]!;
    childHost.postMessage.mockImplementation((msg: unknown) => {
      if ((msg as { type?: unknown }).type === "shutdown") order.push("child-cancel-sent");
    });
    forkSpy.mockImplementationOnce(() => {
      order.push("root-respawn-forked");
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });

    rootHost.emit("exit", 1); // unexpected crash (uptime ~0, below the breaker cap -> respawns)

    expect(order).toEqual(["child-cancel-sent", "root-respawn-forked"]);
  });

  it("the crash-cascaded child, once it actually exits, finalizes cancelled and relays to the RESPAWNED root process", () => {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-crash-cascade-2", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "doomed-child-2" }));
    const childHost = hosts[1]!;

    rootHost.emit("exit", 1); // crash -> cascade-cancel the child, then respawn root
    const respawnedRootHost = hosts[2]!;

    childHost.emit("exit", 0); // the child's own (shutdown-triggered) exit lands

    const terminal = childRunEvents(respawnedRootHost).find(
      (e) => e.requestId === "doomed-child-2" && e.kind === "terminal",
    );
    expect(terminal).toMatchObject({ status: "cancelled" });
    // The old (crashed) root process never got this relay — it is dead.
    expect(childRunEvents(rootHost).some((e) => e.requestId === "doomed-child-2" && e.kind === "terminal")).toBe(
      false,
    );
  });
});

describe("TabHostManager — child start-deadline (CHILD_START_DEADLINE_MS, TASK.102 CUT-S2 §2.3/§2.6.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no child-ready within the deadline -> terminal error, quota freed, child's host asked to shut down (reap)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-deadline", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "slow-child" }));
    const childHost = hosts[1]!;

    vi.advanceTimersByTime(CHILD_START_DEADLINE_MS);

    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "slow-child" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "error" });
    expect(childHost.postMessage).toHaveBeenCalledWith({ type: "shutdown" });

    // The quota was freed: a fresh spawn on the same parent succeeds right away.
    rootHost.emit("message", spawnRequest({ requestId: "after-timeout" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "after-timeout")).toMatchObject({ kind: "accepted" });
  });

  it("child-ready before the deadline clears it — no spurious timeout terminal, and the held prompt is released as ChildStart", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-ontime", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "on-time", prompt: "the actual task" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childReadyMsg());
    expect(childHost.postMessage).toHaveBeenCalledWith({ type: CHILD_START_TYPE, prompt: "the actual task" });

    vi.advanceTimersByTime(CHILD_START_DEADLINE_MS);

    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "on-time" && e.kind === "terminal");
    expect(terminal).toBeUndefined();
  });
});

describe("TabHostManager — child terminal + reap (TASK.102 CUT-S2 §0/§2.6.4)", () => {
  it("a normal ChildTerminal relays EXACTLY once, frees the quota, and reaps the child tab; a duplicate terminal is a no-op", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-term", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";

    childHost.emit(
      "message",
      childTerminalMsg({ status: "completed", finalText: "hi", turns: 2, toolCalls: 1, durationMs: 500 }),
    );

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "completed", finalText: "hi", turns: 2, toolCalls: 1, durationMs: 500 });
    expect(manager.getTab(childTabId)).toBeUndefined();

    childHost.emit("message", childTerminalMsg({ status: "error", finalText: "should be ignored" }));
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal")).toHaveLength(1);

    // The quota was freed exactly once: the full per-parent cap succeeds now.
    rootHost.emit("message", spawnRequest({ requestId: "t2" }));
    rootHost.emit("message", spawnRequest({ requestId: "t3" }));
    rootHost.emit("message", spawnRequest({ requestId: "t4" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(1 + 3);
  });

  it("an unexpected child crash (no ChildTerminal ever sent) finalizes terminal error EXACTLY once, frees the quota EXACTLY once, and NEVER respawns the child", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-crash-child", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "c1" }));
    const childHost = hosts[1]!;
    const hostsBefore = hosts.length;

    childHost.emit("exit", 1); // the child process just dies, unprompted

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "c1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      status: "error",
      finalText: "Agent: the child session host exited before completing.",
    });
    expect(hosts).toHaveLength(hostsBefore); // no respawn fork happened for the child

    childHost.emit("exit", 1); // a second exit event cannot double-finalize
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "c1" && e.kind === "terminal")).toHaveLength(1);

    rootHost.emit("message", spawnRequest({ requestId: "c2" }));
    rootHost.emit("message", spawnRequest({ requestId: "c3" }));
    rootHost.emit("message", spawnRequest({ requestId: "c4" }));
    // c1's own (earlier) accepted event is still in the log, plus c2/c3/c4:
    // the quota freed by c1's crash was exactly one slot, refillable exactly once.
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(1 + 3);
  });

  it("progress/activity/attention from a live child relay verbatim to the parent, correlated by requestId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-progress", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "p1" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childActivityMsg("Bash", "ran a command"));
    childHost.emit("message", childAttentionMsg(true));
    childHost.emit("message", childAttentionMsg(false));

    const events = childRunEvents(rootHost).filter((e) => e.requestId === "p1");
    expect(events).toContainEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "p1",
      kind: "activity",
      toolName: "Bash",
      summary: "ran a command",
    });
    expect(events).toContainEqual({ type: CHILD_RUN_EVENT_TYPE, requestId: "p1", kind: "attention", waiting: true });
    expect(events).toContainEqual({ type: CHILD_RUN_EVENT_TYPE, requestId: "p1", kind: "attention", waiting: false });
  });
});

/**
 * The B3 relay-test matrix §10.7 п.6d asks for (a fix-job filling a gap the
 * cut itself flags — §10.7 п.0 — the B3 test list originally shipped with
 * ZERO relay tests): each ChildProgress kind relays to exactly the run's OWN
 * requestId; a sender WITHOUT childOf is ignored; a message arriving after
 * the run's terminal transition is dropped; and ChildTerminal.
 * activitySuppressed is copied verbatim into the terminal ChildRunEvent.
 */
describe("TabHostManager — ChildProgress/ChildTerminal relay matrix (TASK.102 CUT-S2 §10.7 п.6d)", () => {
  it("a `progress` message from a live child with childOf relays EXACTLY one ChildRunEvent{kind:\"progress\"} carrying the run's requestId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-progress", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-progress" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childProgressMsg({ turns: 3, toolCalls: 2, lastTool: "Bash" }));

    expect(childRunEvents(rootHost).filter((e) => e.kind === "progress")).toEqual([
      { type: CHILD_RUN_EVENT_TYPE, requestId: "relay-progress", kind: "progress", turns: 3, toolCalls: 2, lastTool: "Bash" },
    ]);
  });

  it("an `activity` message from a live child with childOf relays EXACTLY one ChildRunEvent{kind:\"activity\"} carrying the run's requestId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-activity", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-activity" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childActivityMsg("Bash", "ran a command"));

    expect(childRunEvents(rootHost).filter((e) => e.kind === "activity")).toEqual([
      { type: CHILD_RUN_EVENT_TYPE, requestId: "relay-activity", kind: "activity", toolName: "Bash", summary: "ran a command" },
    ]);
  });

  it("an `attention` message from a live child with childOf relays EXACTLY one ChildRunEvent{kind:\"attention\"} carrying the run's requestId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-attention", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-attention" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childAttentionMsg(true));

    expect(childRunEvents(rootHost).filter((e) => e.kind === "attention")).toEqual([
      { type: CHILD_RUN_EVENT_TYPE, requestId: "relay-attention", kind: "attention", waiting: true },
    ]);
  });

  it("a ChildProgress message from a tab WITHOUT childOf (the root tab itself) is silently ignored — no relay, no crash, even while a SIBLING child run is genuinely live", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-no-childof", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    // A real child run IS live on `childRuns` at the same moment — this is
    // what makes the case discriminating: without the `childOf === undefined`
    // guard, any correlation strategy that falls back to "the one live run"
    // (rather than genuinely finding nothing to correlate against) would
    // wrongly relay the root's OWN message under the sibling child's requestId.
    rootHost.emit("message", spawnRequest({ requestId: "sibling-live" }));
    const eventsBeforeSelfMessage = childRunEvents(rootHost);

    // The ROOT tab is not itself a child — it carries no `childOf` — so a
    // ChildProgress message arriving on its OWN process must be dropped,
    // not relayed to itself or misattributed to the sibling run above.
    rootHost.emit("message", childProgressMsg());
    rootHost.emit("message", childActivityMsg("Bash", "should never relay"));
    rootHost.emit("message", childAttentionMsg(true));

    expect(childRunEvents(rootHost)).toEqual(eventsBeforeSelfMessage); // byte-identical: nothing new was relayed
  });

  it("ChildProgress arriving AFTER the run's terminal transition (removed from the ledger) is dropped for all three kinds", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-after-terminal", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-after-terminal" }));
    const childHost = hosts[1]!;
    childHost.emit("message", childTerminalMsg({ status: "completed" }));
    const eventsAfterTerminal = childRunEvents(rootHost);
    expect(eventsAfterTerminal.some((e) => e.kind === "terminal")).toBe(true);

    // The run is gone from the ledger now (finalizeChildRun already ran) —
    // any further progress from the same (stale) child process must land
    // on the dropped branch, not resurrect a relay for a finished run.
    childHost.emit("message", childProgressMsg());
    childHost.emit("message", childActivityMsg("Bash", "late activity"));
    childHost.emit("message", childAttentionMsg(true));

    expect(childRunEvents(rootHost)).toEqual(eventsAfterTerminal); // byte-identical: nothing new was relayed
  });

  it("ChildTerminal.activitySuppressed is copied VERBATIM into the terminal ChildRunEvent", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-suppressed", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-suppressed" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childTerminalMsg({ activitySuppressed: 7 }));

    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "relay-suppressed" && e.kind === "terminal");
    expect(terminal).toMatchObject({ activitySuppressed: 7 });
  });

  it("a ChildTerminal WITHOUT activitySuppressed relays a terminal event carrying NO such key (presence-encoded, not a stray 0/undefined)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-no-suppressed", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-no-suppressed" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childTerminalMsg()); // no activitySuppressed override

    const terminal = childRunEvents(rootHost).find(
      (e) => e.requestId === "relay-no-suppressed" && e.kind === "terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal && "activitySuppressed" in terminal).toBe(false);
  });
});

describe("TabHostManager — children are invisible outside the manager (TASK.102 CUT-S2 §2.6.4)", () => {
  it("count() and atCapacity() never see children, only roots", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { limits: { maxTabs: 1 } });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-cap", resume: false });
    expect(root.ok).toBe(true);
    expect(manager.count()).toBe(1);
    expect(manager.atCapacity()).toBe(true); // maxTabs=1, one root already fills it

    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "cap-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "cap-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "cap-3" }));

    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);
    expect(manager.count()).toBe(1); // 3 live children, still exactly 1 root
    expect(manager.atCapacity()).toBe(true);
  });

  it("listTabs() tags a child tab with childOf; a root tab carries no such field", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-list", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "list-1" }));

    const summaries = manager.listTabs();
    const rootSummary = summaries.find((t) => t.tabId === rootTabId);
    const childSummary = summaries.find((t) => t.tabId !== rootTabId);
    expect(rootSummary?.childOf).toBeUndefined();
    expect(childSummary?.childOf).toMatchObject({ parentTabId: rootTabId });
  });

  it("deliverTabPort stamps the child envelope field and SKIPS the terminal channel entirely for a child tab", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window, posted } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-envelope", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "env-1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "env-1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";

    const uiEnvelopes = posted.filter((p) => p.channel === PORT_ENVELOPE_TYPE);
    expect(uiEnvelopes).toHaveLength(1);
    expect(uiEnvelopes[0]?.payload).toMatchObject({
      tabId: childTabId,
      child: { parentTabId: rootTabId, childSessionId },
    });
    expect(posted.filter((p) => p.channel === TERMINAL_PORT_ENVELOPE_TYPE)).toHaveLength(0);
  });
});

describe("TabHostManager — stale-generation child-session messages are ignored (TASK.102 CUT-S2 §2.6.4)", () => {
  it("a spawn request from a root's OLD (already-respawned) process is silently ignored — no reply, no child forked", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-stale", resume: false });
    expect(root.ok).toBe(true);
    const staleHost = hosts[0]!;

    staleHost.emit("exit", 1); // unexpected crash -> respawn, tab.proc becomes a NEW process
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    const freshHost = hosts[1]!;
    expect(manager.getTab(root.ok ? root.tab.tabId : "")?.state).toBe("running");

    staleHost.emit("message", spawnRequest({ requestId: "ghost" })); // from the DEAD process reference

    expect(childRunEvents(staleHost)).toEqual([]);
    expect(childRunEvents(freshHost).some((e) => e.requestId === "ghost")).toBe(false);
    expect(hosts).toHaveLength(2); // no child forked
  });

  it("child-ready/progress/terminal arriving after a child has already been finalized are all no-ops", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-stale-child", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "sc1" }));
    const childHost = hosts[1]!;
    childHost.emit("message", childTerminalMsg());
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "sc1" && e.kind === "terminal")).toHaveLength(1);

    childHost.emit("message", childReadyMsg());
    childHost.emit("message", childActivityMsg("Bash", "late activity"));
    childHost.emit("message", childTerminalMsg({ status: "error" }));

    expect(childRunEvents(rootHost).filter((e) => e.requestId === "sc1" && e.kind === "terminal")).toHaveLength(1);
    expect(childRunEvents(rootHost).some((e) => e.kind === "progress" || e.kind === "activity")).toBe(false);
  });

  it("a child-run-cancel naming an unknown or foreign requestId is silently ignored (no crash, no cross-parent cancellation)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-cancel-a", resume: false });
    const b = manager.createTab({ workspace: "/b", sessionId: "root-cancel-b", resume: false });
    expect(a.ok && b.ok).toBe(true);
    const [hostA, hostB] = hosts;
    hostA!.emit("message", spawnRequest({ requestId: "owned-by-a" }));
    const childOfAHost = hosts[2]!;

    hostA!.emit("message", runCancel("no-such-request"));
    hostB!.emit("message", runCancel("owned-by-a")); // B trying to cancel A's run

    expect(childOfAHost.postMessage).not.toHaveBeenCalledWith({ type: "shutdown" });
    // A's run is still perfectly alive/accepted, unaffected.
    const accepted = childRunEvents(hostA!).find((e) => e.requestId === "owned-by-a");
    expect(accepted).toMatchObject({ kind: "accepted" });
  });
});

describe("TabHostManager — in-flight (parentSessionId, spawnToolCallId) dedup (TASK.102 CUT-S2 §10.5 п.3)", () => {
  const DUPLICATE_SPAWN_MESSAGE =
    "Agent: a session-subagent for this Agent tool call is already running. Wait for it to finish before retrying.";

  it("a second spawn for the SAME (parentSessionId, spawnToolCallId) pair while the first is live is refused spawn_failed — the first run is untouched, and no second process is forked", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-dedup-live", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "r1", spawnToolCallId: "call-dup" }));
    const hostsAfterFirst = hosts.length;
    rootHost.emit("message", spawnRequest({ requestId: "r2", spawnToolCallId: "call-dup" }));

    expect(childRunEvents(rootHost)).toEqual([
      { type: CHILD_RUN_EVENT_TYPE, requestId: "r1", kind: "accepted", childSessionId: expect.any(String), childTabId: expect.any(String), model: expect.any(String) },
      { type: CHILD_RUN_EVENT_TYPE, requestId: "r2", kind: "rejected", reason: "spawn_failed", message: DUPLICATE_SPAWN_MESSAGE },
    ]);
    // No second child process was ever forked for the duplicate.
    expect(hosts).toHaveLength(hostsAfterFirst);
  });

  it("after the first run's happy-path terminal, the SAME pair spawns successfully again (the key was released)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-dedup-terminal", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "r1", spawnToolCallId: "call-reuse" }));
    const childHost = hosts[1]!;
    childHost.emit("message", childTerminalMsg({ status: "completed" }));

    rootHost.emit("message", spawnRequest({ requestId: "r2", spawnToolCallId: "call-reuse" }));

    expect(childRunEvents(rootHost).find((e) => e.requestId === "r2")).toMatchObject({ kind: "accepted" });
  });

  it("after the first run's UNEXPECTED CRASH (no ChildTerminal ever sent), the SAME pair spawns successfully again — the crash path releases the key too, not only the happy path", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-dedup-crash", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "r1", spawnToolCallId: "call-crash" }));
    const childHost = hosts[1]!;
    childHost.emit("exit", 1); // unprompted crash — no ChildTerminal, handleChildExit's fallback finalizes

    rootHost.emit("message", spawnRequest({ requestId: "r2", spawnToolCallId: "call-crash" }));

    expect(childRunEvents(rootHost).find((e) => e.requestId === "r2")).toMatchObject({ kind: "accepted" });
  });

  it("after the first run misses the start-deadline (no child-ready), the SAME pair spawns successfully again — the timeout path releases the key too", () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = shutdownableForkRig();
      const { window } = windowRig();
      const manager = childManager(fork, window);
      const root = manager.createTab({ workspace: "/ws", sessionId: "root-dedup-deadline", resume: false });
      expect(root.ok).toBe(true);
      const rootHost = hosts[0]!;

      rootHost.emit("message", spawnRequest({ requestId: "r1", spawnToolCallId: "call-deadline" }));
      vi.advanceTimersByTime(CHILD_START_DEADLINE_MS); // never sends child-ready -> handleChildStartTimeout finalizes

      rootHost.emit("message", spawnRequest({ requestId: "r2", spawnToolCallId: "call-deadline" }));

      expect(childRunEvents(rootHost).find((e) => e.requestId === "r2")).toMatchObject({ kind: "accepted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the SAME spawnToolCallId from DIFFERENT parents spawns BOTH — the dedup key is the (parentSessionId, spawnToolCallId) pair, not the bare id", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-dedup-pair-a", resume: false });
    const b = manager.createTab({ workspace: "/b", sessionId: "root-dedup-pair-b", resume: false });
    expect(a.ok && b.ok).toBe(true);
    const [hostA, hostB] = hosts;

    hostA!.emit("message", spawnRequest({ requestId: "from-a", spawnToolCallId: "shared-call-id" }));
    hostB!.emit("message", spawnRequest({ requestId: "from-b", spawnToolCallId: "shared-call-id" }));

    expect(childRunEvents(hostA!).find((e) => e.requestId === "from-a")).toMatchObject({ kind: "accepted" });
    expect(childRunEvents(hostB!).find((e) => e.requestId === "from-b")).toMatchObject({ kind: "accepted" });
  });
});

/**
 * TASK.102 CUT-S2 §10.8.2 п.5: four model-visible texts are now VERBATIM-
 * frozen cut members. These pins exist to catch a single wrong character —
 * each asserts the FULL string (`toEqual`/exact `finalText`), not
 * `expect.any(String)` or a substring match, so any drift from the ratified
 * wording (including the two the architect REPLACED, §10.8.2 п.1/п.2) fails
 * loudly rather than silently degrading to a fact-only, actionless message.
 */
describe("TabHostManager — §10.8.2 model-visible text verbatim pins", () => {
  it("a `not_ready` rejection WITHOUT an explicit provider carries EXACTLY the §10.8.2 п.1 ratified text", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let ready = true;
    const manager = childManager(fork, window, { engineReady: (engine) => engine === "core" && ready });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-pin-notready", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    ready = false; // flip AFTER root creation so only the child spawn hits not_ready
    rootHost.emit("message", spawnRequest({ requestId: "pin-notready" }));

    const rejected = childRunEvents(rootHost).find((e) => e.requestId === "pin-notready" && e.kind === "rejected");
    expect(rejected).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "pin-notready",
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: the core engine is not available in this host, so a child session could not be started. Use tier "inline".',
    });
  });

  it("a start-deadline miss's terminal carries EXACTLY the §10.8.2 п.2 ratified text", () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = shutdownableForkRig();
      const { window } = windowRig();
      const manager = childManager(fork, window);
      const root = manager.createTab({ workspace: "/ws", sessionId: "root-pin-deadline", resume: false });
      expect(root.ok).toBe(true);
      const rootHost = hosts[0]!;
      rootHost.emit("message", spawnRequest({ requestId: "pin-deadline" }));

      vi.advanceTimersByTime(CHILD_START_DEADLINE_MS);

      const terminal = childRunEvents(rootHost).find((e) => e.requestId === "pin-deadline" && e.kind === "terminal");
      expect(terminal).toMatchObject({
        status: "error",
        finalText:
          'Agent: the child session did not become ready in time and was shut down; it never started on the task. Retry, or use tier "inline".',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancelled terminal carries EXACTLY the §10.8.2 п.3 text for BOTH an explicit child-run-cancel AND the drain-cascade path", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const CANCELLED_TEXT = "Agent: the child session was cancelled.";

    // Path A: explicit child-run-cancel from the parent, reaped by an exit.
    // hosts[0] = rootA, hosts[1] = its child (spawned next, in order).
    const rootA = manager.createTab({ workspace: "/a", sessionId: "root-pin-cancel-explicit", resume: false });
    expect(rootA.ok).toBe(true);
    const rootAHost = hosts[0]!;
    rootAHost.emit("message", spawnRequest({ requestId: "pin-cancel-explicit" }));
    const childAHost = hosts[1]!;
    rootAHost.emit("message", runCancel("pin-cancel-explicit"));
    childAHost.emit("exit", 0); // the real reap that flips cancelling -> cancelled

    const explicitTerminal = childRunEvents(rootAHost).find(
      (e) => e.requestId === "pin-cancel-explicit" && e.kind === "terminal",
    );
    expect(explicitTerminal).toMatchObject({ status: "cancelled", finalText: CANCELLED_TEXT });

    // Path B: the parent's own graceful close cascades a cancel to its child.
    // rootA is still alive as a second root, so closing rootB is not a
    // last_tab refusal. hosts[2] = rootB (3rd fork overall), hosts[3] = its child.
    const rootB = manager.createTab({ workspace: "/c", sessionId: "root-pin-cancel-cascade", resume: false });
    expect(rootB.ok).toBe(true);
    const rootBTabId = rootB.ok ? rootB.tab.tabId : "";
    const rootBHost = hosts[2]!;
    rootBHost.emit("message", spawnRequest({ requestId: "pin-cancel-cascade" }));

    await manager.closeTab(rootBTabId);

    const cascadeTerminal = childRunEvents(rootBHost).find(
      (e) => e.requestId === "pin-cancel-cascade" && e.kind === "terminal",
    );
    expect(cascadeTerminal).toMatchObject({ status: "cancelled", finalText: CANCELLED_TEXT });
  });

  it("an in-flight duplicate (parentSessionId, spawnToolCallId) spawn is rejected with EXACTLY the §10.8.2 п.4 ratified text", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-pin-duplicate", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "pin-dup-1", spawnToolCallId: "pin-dup-call" }));
    rootHost.emit("message", spawnRequest({ requestId: "pin-dup-2", spawnToolCallId: "pin-dup-call" }));

    const rejected = childRunEvents(rootHost).find((e) => e.requestId === "pin-dup-2" && e.kind === "rejected");
    expect(rejected).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "pin-dup-2",
      kind: "rejected",
      reason: "spawn_failed",
      message:
        "Agent: a session-subagent for this Agent tool call is already running. Wait for it to finish before retrying.",
    });
  });
});

/**
 * TASK.102 fix-wave F1: `drainChildren`'s `for(;;)` loop re-polls
 * `childrenByParentTab` on every iteration and re-invokes `cancelChildRun` for
 * every child it still finds — including one it already asked to shut down.
 * On the child that is already `state === "closing"`, `cancelChildRun` used
 * to return a bare `Promise.resolve()`: a promise that settles via the
 * microtask queue alone, with NO macrotask ever involved. Because the loop
 * feeds that straight back into another `await`, revisiting the SAME
 * still-closing child (its real exit not yet delivered) turns into a
 * self-sustaining chain of already-settled microtasks that never lets the
 * event loop reach a macrotask phase — starving the timer/IPC/exit callbacks
 * that would otherwise let the cascade actually finish. Reachable in
 * production exactly per the finding: cancel a child, then close its parent
 * before the child's real exit lands.
 */
describe("TabHostManager — drainChildren must not starve the event loop on an already-closing child (TASK.102 CUT-S2 F1)", () => {
  it("cancelChildRun revisiting an already-`closing` child (the drain loop's own repeat-visit case) resolves only via a REAL macrotask, never via microtasks alone", async () => {
    // liveForkRig: the child never auto-responds to the shutdown postMessage
    // (unlike shutdownableForkRig), so it stays "closing but not yet exited"
    // for as long as the test wants — the exact window the bug lives in.
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-f1", sessionId: "root-f1-starve", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "f1-req" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "f1-req" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");

    // The FIRST cancel: shutdownTabHost's synchronous prefix flips the child
    // to "closing" immediately, without waiting for anything.
    rootHost.emit("message", runCancel("f1-req"));
    expect(manager.getTab(childTabId)?.state).toBe("closing");

    // This is drainChildren's own repeat-visit case: a second cancel call on
    // a child that is already closing. Reached via the private method
    // directly (not the wire) on purpose: a full repro through closeTab's
    // drainChildren cannot be safely awaited here — on the UNFIXED code this
    // settles through an unbounded, self-sustaining microtask chain with no
    // macrotask ever interleaved, which would hang the whole vitest worker
    // (nothing — no fake timer, no Promise.race — can rescue an await stuck
    // behind a queue that never empties). Bounding the microtask flush
    // ourselves, from the test, is the only safe way to observe this.
    const raw = manager as unknown as { cancelChildRun(id: string): Promise<void> };
    let resolved = false;
    raw.cancelChildRun(childTabId).then(() => {
      resolved = true;
    });

    // Drain a large but FINITE number of microtask turns — bounded by the
    // TEST, never by the code under test. A bare `Promise.resolve()` (the
    // bug) flips `resolved` after the very first one of these.
    for (let i = 0; i < 2000; i++) {
      await Promise.resolve();
    }
    expect(resolved).toBe(false);

    // Give it exactly one real macrotask turn — the fix must resolve here.
    await new Promise<void>((r) => setImmediate(r));
    expect(resolved).toBe(true);
  });
});

/**
 * TASK.102 fix-wave F2: on the timeout branch, `shutdownTabHost` nulls
 * `tab.proc` right after calling `child.kill()`, before the process has
 * actually exited. When that real exit arrives later, `handleChildExit`'s
 * staleness guard (`tab.proc !== child`) — meant to catch a genuinely
 * superseded generation — wrongly treats it as stale too, since `tab.proc`
 * is already null. `finalizeChildRun` is then never called: the quota slot
 * and the `(parentSessionId, spawnToolCallId)` dedup key leak forever, and
 * the zombie child tab is never removed from `tabs`.
 */
describe("TabHostManager — a force-killed child's late real exit still finalizes the run (TASK.102 CUT-S2 F2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the exit that lands AFTER shutdownTabHost's exitDeadlineMs timeout still frees the slot, reaps the tab, and relays a cancelled terminal", async () => {
    // liveForkRig: the child never auto-exits on the shutdown postMessage,
    // forcing shutdownTabHost down its exitDeadlineMs timeout/force-kill
    // branch instead of the happy "it exited in time" branch.
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { limits: { exitDeadlineMs: 1000 } });
    const root = manager.createTab({ workspace: "/ws-f2", sessionId: "root-f2-timeout", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "f2-r1" }));
    const childHost = hosts[1]!;
    // Fill the rest of the per-parent cap with two ordinary (never cancelled)
    // children, so a leaked slot is observable as a rejected 4th spawn.
    rootHost.emit("message", spawnRequest({ requestId: "f2-r2" }));
    rootHost.emit("message", spawnRequest({ requestId: "f2-r3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(CHILD_RUNS_PER_PARENT_MAX);

    const accepted1 = childRunEvents(rootHost).find((e) => e.requestId === "f2-r1" && e.kind === "accepted");
    const childTabId = accepted1?.kind === "accepted" ? accepted1.childTabId : "";
    expect(manager.getTab(childTabId)).toBeDefined();

    // Cancel r1 — starts a real shutdownTabHost race the child never answers.
    rootHost.emit("message", runCancel("f2-r1"));
    expect(manager.getTab(childTabId)?.state).toBe("closing");

    // The deadline elapses: force-kill, and tab.proc gets nulled right here
    // (the bug), before the process has actually died.
    await vi.advanceTimersByTimeAsync(1000);
    expect(childHost.kill).toHaveBeenCalled();
    expect(manager.getTab(childTabId)?.proc).toBeNull();

    // The REAL OS-level exit for the force-killed process arrives LATE —
    // the event handleChildExit must still act on.
    childHost.emit("exit", 137);

    expect(manager.getTab(childTabId)).toBeUndefined(); // zombie tab reaped
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "f2-r1" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "cancelled" }); // parent notified

    // The freed slot admits a 4th spawn that would otherwise stay rejected
    // limit_parent forever.
    rootHost.emit("message", spawnRequest({ requestId: "f2-r4" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "f2-r4")).toMatchObject({ kind: "accepted" });
  });
});

/**
 * TASK.102 fix-wave F3: `finalizeChildRun` relays the parent's `terminal`
 * ChildRunEvent but never tells the RENDERER that the child TAB's own host
 * exited — the `HOST_EXITED_ENVELOPE_TYPE` send that flips a
 * `ChildRelation.live` flag in the UI. A finished child therefore renders as
 * permanently live for the rest of the app's lifetime.
 */
describe("TabHostManager — a finalized child notifies the renderer's host-exited channel (TASK.102 CUT-S2 F3)", () => {
  it("a normal ChildTerminal finalize sends HOST_EXITED for the CHILD's own tabId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window, hostExited } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-f3a", sessionId: "root-f3-happy", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "f3-r1" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "f3-r1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");
    expect(hostExited).not.toContain(childTabId); // not yet, while the child is running

    childHost.emit("message", childTerminalMsg({ status: "completed" }));

    expect(hostExited).toContain(childTabId);
  });

  it("the crash fallback (handleChildExit, no ChildTerminal ever sent) ALSO sends HOST_EXITED for the child's tabId", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window, hostExited } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-f3b", sessionId: "root-f3-crash", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "f3-r2" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "f3-r2" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");

    childHost.emit("exit", 1); // unprompted crash — no ChildTerminal

    expect(hostExited).toContain(childTabId);
  });
});

/**
 * TASK.102 fix-wave F5: `relocateTab` (a master's worktree migration) shuts
 * its own host down and respawns at the new workspace, but — unlike
 * `closeTab` and the crashed-root respawn path in `handleExit` — never calls
 * `drainChildren` first. Spec §0.6's "a dead root cancels its children" is
 * enforced for a graceful close and an unexpected crash, but not for a
 * rehost: any live child of that master is left running against a parent
 * that has since moved to a different workspace/branch.
 */
describe("TabHostManager — a master's worktree relocation drains its children first (TASK.102 CUT-S2 F5)", () => {
  it("relocateTab cancels a live child BEFORE respawning the master at the new worktree — the child is reaped, not orphaned", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-f5", sessionId: "root-f5", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "f5-r1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "f5-r1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(manager.getTab(childTabId)).toBeDefined();

    const transition: WorktreeTransitionMessage = {
      type: WORKTREE_TRANSITION_MESSAGE_TYPE,
      sessionId: "root-f5",
      fromWorkspace: "/ws-f5",
      toWorkspace: "/ws-f5/.worktrees/wt-1",
      projectRoot: "/ws-f5",
      worktree: {
        id: "wt-1",
        path: "/ws-f5/.worktrees/wt-1",
        branch: "feature-x",
        baseRef: "main",
        ownedByAnyCode: true,
      },
    };
    rootHost.emit("message", transition);
    await flush();

    // The child must have been cancelled and reaped as part of the
    // relocation, not left running against a master that has since moved.
    expect(manager.getTab(childTabId)).toBeUndefined();
    expect(manager.listTabs().some((t) => t.childOf !== undefined)).toBe(false);
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "f5-r1" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "cancelled" });

    // The master itself is still alive, now at the new workspace.
    const relocated = manager.getTab(rootTabId);
    expect(relocated?.workspace).toBe("/ws-f5/.worktrees/wt-1");
  });
});

/**
 * TASK.102 fix-wave F6: `handleChildTerminal` relays whatever `status` the
 * child self-reports, verbatim. A child that finishes its own turn right as
 * a cancel races in (ledger `state === "cancelling"`) can self-report
 * "completed" — the cut's prescribed `cancelled` transition is not forced,
 * so the parent sees a stale "completed" terminal for a run it just told
 * main to cancel.
 */
describe("TabHostManager — a self-reported ChildTerminal racing a cancel does not override the forced `cancelled` transition (TASK.102 CUT-S2 F6)", () => {
  it("ChildTerminal{status:'completed'} arriving while the ledger entry is still 'cancelling' is forced to status 'cancelled'", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-f6", sessionId: "root-f6", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "f6-r1" }));
    const childHost = hosts[1]!;

    // Cancel is in flight (ledger entry now "cancelling"); shutdownableForkRig's
    // auto-exit is only QUEUED on a microtask by the shutdown postMessage
    // above, not delivered yet — so the child's own (already in-flight)
    // ChildTerminal computation can still land, self-reporting "completed",
    // exactly the race the cut requires main to resolve in favor of cancel.
    rootHost.emit("message", runCancel("f6-r1"));
    childHost.emit("message", childTerminalMsg({ status: "completed", finalText: "actually finished" }));

    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "f6-r1" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "cancelled" });

    await flush(); // let the queued auto-exit settle before the test ends
  });
});

/**
 * Review T1 (post-F1): F1 fixed the `state === "closing"` branch of
 * `cancelChildRun` to yield a real macrotask instead of a bare
 * `Promise.resolve()`, but left its sibling branch — `childTab === undefined`
 * — untouched. If a childTabId is ever present in `childrenByParentTab`
 * while absent from `tabs` (every current `tabs.delete` site happens to also
 * clear the sibling set, so this is latent, not live), `drainChildren`'s
 * `for(;;)` loop would revisit that ghost id forever, once per bare
 * microtask, starving the main-process event loop exactly like F1's original
 * bug — on the one branch the fix never touched.
 */
describe("TabHostManager — cancelChildRun's unknown-tab branch (review T1a)", () => {
  it("a childTabId present in childrenByParentTab but absent from tabs resolves only via a REAL macrotask, and self-heals by dropping the id from the sibling set", async () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws-t1a", sessionId: "root-t1a", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1a-req" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1a-req" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");

    // Manufacture the state the finding describes: `childrenByParentTab`
    // still lists this id, but `tabs` no longer has it. Every real deletion
    // site removes both together (which is why this is latent in
    // production) — reaching here directly is the only safe way to exercise
    // the branch without depending on a second, hypothetical bug.
    const raw = manager as unknown as {
      tabs: Map<string, unknown>;
      childrenByParentTab: Map<string, Set<string>>;
      cancelChildRun(id: string): Promise<void>;
    };
    raw.tabs.delete(childTabId);
    expect(raw.childrenByParentTab.get(rootTabId)?.has(childTabId)).toBe(true);

    let resolved = false;
    raw.cancelChildRun(childTabId).then(() => {
      resolved = true;
    });

    // Drain a large but FINITE number of microtask turns — bounded by the
    // TEST, never by the code under test (mirrors F1's own test, which
    // documents why nothing else can safely bound an unfixed microtask
    // chain). A bare `Promise.resolve()` (the bug) flips `resolved` after
    // the very first one of these.
    for (let i = 0; i < 2000; i++) {
      await Promise.resolve();
    }
    expect(resolved).toBe(false);

    // Give it exactly one real macrotask turn — the fix must resolve here.
    await new Promise<void>((r) => setImmediate(r));
    expect(resolved).toBe(true);

    // And the ghost id must not survive: a child with no tab can never
    // finalize, so leaving it in the sibling set would just recreate the
    // same starvation for the NEXT drainChildren revisit.
    expect(raw.childrenByParentTab.get(rootTabId)?.has(childTabId)).toBeFalsy();
  });
});

/**
 * Review T1 (bounded drain): `drainChildren`'s `for(;;)` loop has no
 * iteration cap or deadline. If a force-killed child's process never
 * actually emits "exit" (so `finalizeChildRun` never runs and the sibling
 * set never empties), the loop revisits it forever, one real macrotask at a
 * time, and `closeTab`/`relocateTab` (both `await drainChildren`) never
 * resolve. The manager's injectable `now()` lets the test control the
 * deadline check deterministically without needing thousands of real
 * macrotask turns to elapse.
 */
describe("TabHostManager — drainChildren is bounded, not an infinite cascade (review T1b)", () => {
  it("gives up (with an honest, logged outcome) instead of looping forever when a child never actually finalizes", async () => {
    const { fork, hosts } = liveForkRig(); // never auto-responds to shutdown, never exits
    const { window } = windowRig();
    const errors: string[] = [];
    // A `now()` that reads 0 until the test flips `jumped` — deterministic
    // control over the deadline without needing thousands of real macrotask
    // turns to elapse for a wall-clock check to observe genuine elapsed
    // time. (spawnTabHost's own unrelated `now()` calls during setup below
    // just read 0 too, harmlessly.)
    let jumped = false;
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      now: () => (jumped ? Number.MAX_SAFE_INTEGER : 0),
      logger: { log() {}, warn() {}, error: (msg: string) => errors.push(msg) },
      limits: { exitDeadlineMs: 1000 },
    });
    const root = manager.createTab({ workspace: "/ws-t1b", sessionId: "root-t1b", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1b-req" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1b-req" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");

    // An explicit cancel flips the child to "closing" synchronously, without
    // waiting on its own exitDeadlineMs timer — from here on every
    // `cancelChildRun` revisit takes the already-fixed (F1/T1a) "yield a
    // real macrotask" branches, never a real exit, since this fork rig never
    // emits one.
    rootHost.emit("message", runCancel("t1b-req"));
    expect(manager.getTab(childTabId)?.state).toBe("closing");

    // Invoke drainChildren: its synchronous prefix (up to the loop's first
    // `await`) computes the deadline immediately, reading `now()` while
    // `jumped` is still false — THEN the test jumps the clock, so every
    // trip-check from here on reports a deadline that has already elapsed.
    // The loop's per-iteration wait is still a REAL setImmediate (F1),
    // decoupled from this injected clock, so even a correctly-bounded drain
    // needs at least one real macrotask turn to observe the trip and
    // return. Racing against a short real timeout is what discriminates an
    // unbounded loop (unfixed: spins for the full 250ms) from a bounded one
    // (fixed: resolves within a couple of macrotasks).
    const raw = manager as unknown as { drainChildren(tab: unknown): Promise<void> };
    const rootTab = manager.getTab(rootTabId);
    const drainPromise = raw.drainChildren(rootTab);
    jumped = true;
    const result = await Promise.race([
      drainPromise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(result).toBe("resolved");
    // Honest outcome, not a silent continue: something was logged about the
    // still-unreaped child rather than drainChildren just quietly returning
    // as if the cascade had actually finished.
    expect(errors.some((m) => m.includes(rootTabId))).toBe(true);
    // The sibling is legitimately still there — cancelChildRun already
    // signaled its shutdown; a LATER drain (the next close/relocate/exit
    // cascade) gets to retry it. Giving up must not fabricate a reap.
    expect(manager.getTab(childTabId)).toBeDefined();
  });
});

/**
 * Review T2: two `shutdownTabHost` calls can be in flight against the same
 * child with staggered deadlines — `cancelChildRun`'s explicit-cancel path
 * (A) and `finalizeChildRun`'s own reap call when a self-reported
 * `ChildTerminal` lands while `proc` is still non-null (B) — both capturing
 * `child = tab.proc` before either nulls it.
 *
 * NOTE ON SCOPE: the original finding described this as a PERMANENT leak of
 * `forceKilledExits` (the Set growing by one dead process per occurrence,
 * for the life of the main process). Direct TDD investigation of that claim
 * did NOT reproduce it in either relative ordering of "the real exit" vs
 * "the loser's own deadline": `forceKilledExits` is a `Set` (identity-keyed,
 * so a redundant `.add()` is a no-op) and `handleExit`'s single,
 * spawn-time-registered `.once("exit")` listener unconditionally removes
 * whatever entry exists the one time a real exit is ever observed —
 * regardless of how many times `shutdownTabHost` raced to add one. What IS
 * real and reproduces cleanly: the LOSING call has no guard against doing
 * its own force-kill bookkeeping — a second, fully redundant `child.kill()`
 * — after the WINNING call has already nulled `tab.proc` out from under it.
 * The fix below is exactly the one the finding proposed (guard the
 * force-kill bookkeeping on `tab.proc === child`); only the discriminating
 * test targets the redundant-kill defect that's actually there, not the
 * Set-leak that empirically isn't.
 */
describe("TabHostManager — an overlapping second shutdownTabHost call does not redundantly force-kill (review T2)", () => {
  it("a cancel-triggered shutdown racing a self-reported-terminal-triggered shutdown on the SAME child force-kills the underlying process EXACTLY once, even when the loser's own deadline elapses with no exit ever observed", async () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = liveForkRig(); // never auto-responds to shutdown, never exits on its own
      const { window } = windowRig();
      const manager = childManager(fork, window, { limits: { exitDeadlineMs: 1000 } });
      const root = manager.createTab({ workspace: "/ws-t2", sessionId: "root-t2", resume: false });
      expect(root.ok).toBe(true);
      const rootHost = hosts[0]!;
      rootHost.emit("message", spawnRequest({ requestId: "t2-req" }));
      const childHost = hosts[1]!;
      const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t2-req" && e.kind === "accepted");
      const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
      expect(childTabId).not.toBe("");

      // Call A: an explicit parent cancel starts the first shutdownTabHost,
      // arming its own deadline at t=1000.
      rootHost.emit("message", runCancel("t2-req"));
      expect(manager.getTab(childTabId)?.state).toBe("closing");

      // At t=200, the child's own (already in-flight) ChildTerminal lands —
      // finalizeChildRun sees `proc !== null` (A hasn't hit its deadline
      // yet) and starts a SECOND, overlapping shutdownTabHost call B, with
      // its OWN deadline armed at t=1200.
      await vi.advanceTimersByTimeAsync(200);
      childHost.emit("message", childTerminalMsg({ status: "completed" }));

      // t=1000: A's deadline elapses first. Force-kill #1; tab.proc -> null.
      await vi.advanceTimersByTimeAsync(800);
      expect(childHost.kill).toHaveBeenCalledTimes(1);

      // The process never actually reports an exit in this test (the
      // pathological "force-killed but never reaped" case review T1's
      // drainChildren cap and T3's engine-reap fix both exist to handle) —
      // so B's own "exited" listener has nothing to observe, and B's
      // deadline at t=1200 elapses too, on a tab whose `proc` A already
      // nulled out from under it.
      await vi.advanceTimersByTimeAsync(300);

      // Unfixed: B has no guard, so it redundantly re-adds to
      // forceKilledExits (a harmless no-op, since the Set is identity-keyed)
      // AND calls `child.kill()` a second time on the same corpse. Fixed: B
      // recognizes `tab.proc` is no longer the process it captured and
      // skips its own force-kill bookkeeping entirely.
      expect(childHost.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Review T3: on the force-kill path, `shutdownTabHost` nulls `tab.proc`
 * before the real "exit" ever arrives. When that late exit lands,
 * `handleExit` calls `reapEngineProcess(tab, child)`, whose guard requires
 * `tab.proc === child` — always false for a force-killed process, since
 * `tab.proc` was already nulled. The external engine process group
 * (`tab.engineProcess`) is therefore never reaped and outlives the app. This
 * affects ROOT sessions specifically (only a root can carry an
 * `engineProcess` registration — a child's host has no such control-plane
 * message wired).
 */
describe("TabHostManager — a force-killed ROOT's external engine process is still reaped when its late exit lands (review T3)", () => {
  it("reapEngineProcess uses the registration captured at force-kill time, not tab.proc===child (which is always false for a force-killed process by the time the exit lands)", async () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = liveForkRig(); // never auto-responds to shutdown, never exits on its own
      const reaped: number[] = [];
      const { window } = windowRig();
      const manager = new TabHostManager({
        fork,
        hostEntry: "/fake/host.js",
        createChannel: fakeChannel,
        getWindow: () => window,
        engineReady: () => true,
        reapEngineProcess: (registration) => reaped.push(registration.enginePid),
        logger: silentLogger,
        limits: { exitDeadlineMs: 1000 },
      });
      // A second root so closing the first is not refused as last_tab.
      const rootA = manager.createTab({ workspace: "/ws-t3-a", sessionId: "root-t3-a", resume: false, engine: "codex" });
      expect(rootA.ok).toBe(true);
      const rootB = manager.createTab({ workspace: "/ws-t3-b", sessionId: "root-t3-b", resume: false, engine: "codex" });
      expect(rootB.ok).toBe(true);
      const rootBTabId = rootB.ok ? rootB.tab.tabId : "";
      const rootBHost = hosts[1]!;

      rootBHost.emit("message", {
        type: "anycode:engine-process",
        hostPid: rootBHost.pid,
        generation: 1,
        enginePid: 777,
        pgid: 777,
      });
      expect(manager.getTab(rootBTabId)?.engineProcess?.enginePid).toBe(777);

      // closeTab's own shutdownTabHost races the deadline; the host never
      // responds, so it force-kills — `reapEngineProcess`'s ordinary
      // `tab.proc === child` guard has nothing to match against from here
      // on (`tab.proc` is about to be nulled by the force-kill branch).
      const closePromise = manager.closeTab(rootBTabId);
      await vi.advanceTimersByTimeAsync(1000);
      expect(rootBHost.kill).toHaveBeenCalled();
      expect(reaped).toEqual([]); // not yet — the real exit hasn't landed

      // The real exit finally lands, late.
      rootBHost.emit("exit", 137);
      await closePromise;

      expect(reaped).toEqual([777]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT reap a newer (respawned) generation's engine using a stale force-killed exit (relocateTab's respawn-after-force-kill case)", async () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = liveForkRig();
      const reaped: number[] = [];
      const { window } = windowRig();
      const manager = new TabHostManager({
        fork,
        hostEntry: "/fake/host.js",
        createChannel: fakeChannel,
        getWindow: () => window,
        engineReady: () => true,
        reapEngineProcess: (registration) => reaped.push(registration.enginePid),
        logger: silentLogger,
        limits: { exitDeadlineMs: 1000 },
      });
      const root = manager.createTab({ workspace: "/ws-t3c", sessionId: "root-t3c", resume: false, engine: "codex" });
      expect(root.ok).toBe(true);
      const rootTabId = root.ok ? root.tab.tabId : "";
      const oldHost = hosts[0]!;

      oldHost.emit("message", {
        type: "anycode:engine-process",
        hostPid: oldHost.pid,
        generation: 1,
        enginePid: 111,
        pgid: 111,
      });

      const raw = manager as unknown as { shutdownTabHost(tab: unknown): Promise<void> };
      const tab = manager.getTab(rootTabId);
      const shutdownPromise = raw.shutdownTabHost(tab);
      await vi.advanceTimersByTimeAsync(1000); // force-kills the OLD host
      await shutdownPromise;
      expect(reaped).toEqual([]); // still not yet — no exit landed

      // Simulate what relocateTab does next: respawn a NEW generation on
      // the SAME tab BEFORE the old host's late exit ever arrives.
      tab!.state = "running";
      (manager as unknown as { spawnTabHost(tab: unknown, opts: { firstSpawn: boolean }): void }).spawnTabHost(tab, {
        firstSpawn: false,
      });
      const newHost = hosts[1]!;
      newHost.emit("message", {
        type: "anycode:engine-process",
        hostPid: newHost.pid,
        generation: 2,
        enginePid: 222,
        pgid: 222,
      });
      expect(manager.getTab(rootTabId)?.engineProcess?.enginePid).toBe(222);

      // NOW the OLD (force-killed) host's late exit finally lands.
      oldHost.emit("exit", 137);

      // Only the OLD engine (captured at ITS OWN force-kill) was reaped —
      // the NEW generation's live engine must survive this stale exit.
      expect(reaped).toEqual([111]);
      expect(manager.getTab(rootTabId)?.engineProcess?.enginePid).toBe(222);
    } finally {
      vi.useRealTimers();
    }
  });
});
