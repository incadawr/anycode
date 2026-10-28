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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHostFailure } from "../host/error-diagnostics.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { CREDENTIAL_REQUEST_TYPE, CREDENTIAL_RESPONSE_TYPE } from "../shared/credentials.js";
import { PORT_ENVELOPE_TYPE, TAB_CLOSED_ENVELOPE_TYPE } from "../shared/envelopes.js";
import { handleCreate, handleTabRebind, type TabIpcDeps } from "./tab-ipc.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { PROVIDER_QUOTA_EVENT_TYPE } from "../shared/provider-quota.js";
import { TERMINAL_INIT_MESSAGE_TYPE, TERMINAL_PORT_ENVELOPE_TYPE } from "../shared/terminal.js";
import {
  PREVIEW_ARTIFACTS_TYPE,
  PREVIEW_REQUEST_TYPE,
  type PreviewArtifactsMessage,
  type PreviewRequestMessage,
} from "../shared/preview.js";
import { ENV_ENGINE, type EngineId } from "../shared/engines.js";
import {
  CHILD_PROGRESS_TYPE,
  CHILD_READY_TYPE,
  CHILD_RUNS_GLOBAL_MAX,
  CHILD_RUNS_PER_PARENT_MAX,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_RUN_SEND_TYPE,
  CHILD_SPAWN_QUEUE_MAX,
  CHILD_SPAWN_REQUEST_TYPE,
  CHILD_START_DEADLINE_MS,
  CHILD_START_TYPE,
  CHILD_TERMINAL_TYPE,
  parseChildRunEvent,
  type ChildRunEvent,
  type ChildRunSend,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";
import {
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeTransitionMessage,
} from "../shared/worktrees.js";
import { ENV_MAX_TURNS, ENV_MODEL } from "./host-env.js";
import { RECOGNIZER_CONFIG_CHANGED_TYPE, type RecognizerConfigChanged } from "../shared/recognizer.js";
import {
  DEFAULT_BREAKER_LIMITS,
  TabHostManager,
  workspaceMissing,
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
    // Mirrors production's own engineEnv (main/index.ts:1462), which always
    // stamps ANYCODE_ENGINE — required by the F4 gate-fix's fail-closed check.
    engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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

/** A valid ChildRunSend (Taskana 4153); caller supplies the childSessionId. */
function runSend(requestId: string, childSessionId: string, text = "here are the other reviewers' edits") {
  return { type: CHILD_RUN_SEND_TYPE, requestId, childSessionId, text } as const;
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
    // Mirrors production's own engineEnv (main/index.ts:1462), which always
    // stamps ANYCODE_ENGINE — required by the F4 gate-fix's fail-closed check.
    // A test exercising that check overrides this explicitly.
    engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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

describe("TabHostManager — session registration hook (Taskana 4747)", () => {
  it("reports a new root tab's sessionId, with no parent", () => {
    const { fork } = dyingForkRig();
    const { window } = windowRig();
    const seen: Array<{ sessionId: string; parentSessionId?: string }> = [];
    const manager = new TabHostManager({
      fork, hostEntry: "/fake/host.js", createChannel: fakeChannel, getWindow: () => window, env: () => ({}), logger: silentLogger, limits: {},
      onSessionRegistered: (info) => { seen.push(info); },
    });
    manager.createTab({ workspace: "/ws", sessionId: "root-session", resume: false });
    expect(seen).toEqual([{ sessionId: "root-session" }]);
  });
});

describe("TabHostManager — host spawn", () => {
  it("forks with ignored stdin, inherited stdout and piped stderr", () => {
    const fork = vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess);
    const manager = makeManager(fork, windowRig().window);
    expect(manager.createTab({ workspace: "/ws", sessionId: "stdio", resume: false }).ok).toBe(true);
    expect(fork.mock.calls[0]?.[2].stdio).toEqual(["ignore", "inherit", "pipe"]);
  });

  it("rolls back a throwing fork and logs its cause", () => {
    const error = new Error("fork failed: invalid stdin");
    const logError = vi.fn();
    const opened = vi.fn();
    const registered = vi.fn();
    const fork = vi.fn<HostForkFn>().mockImplementationOnce(() => { throw error; })
      .mockImplementation(() => new FakeHost() as unknown as UtilityProcess);
    const manager = new TabHostManager({
      fork, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => windowRig().window, env: () => ({}),
      logger: { ...silentLogger, error: logError }, onTabOpened: opened, onSessionRegistered: registered,
    });
    expect(manager.createTab({ workspace: "/ws", sessionId: "retry", resume: false }))
      .toEqual({ ok: false, reason: "not_ready" });
    expect(manager.listTabs()).toHaveLength(0);
    expect(opened).not.toHaveBeenCalled();
    expect(registered).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("host spawn failed"), error);
    expect(manager.createTab({ workspace: "/ws", sessionId: "retry", resume: false }).ok).toBe(true);
  });

  it("rolls back a deferred initial fork failure and notifies the renderer", async () => {
    const error = new Error("deferred fork failed");
    let blocked = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const registered = vi.fn();
    const closed = vi.fn();
    const logError = vi.fn();
    const send = vi.fn();
    const window = windowRig().window;
    window.webContents.send = send;
    const manager = new TabHostManager({
      fork: () => { throw error; }, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => window, env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined,
      logger: { ...silentLogger, error: logError }, onSessionRegistered: registered, onTabClosed: closed,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "deferred-failure", connectionId: "old", resume: false });
    if (!created.ok) throw new Error("create failed");
    expect(registered).toHaveBeenCalledWith({ sessionId: "deferred-failure" });
    blocked = false;
    release();
    await vi.waitFor(() => expect(manager.getTab(created.tab.tabId)).toBeUndefined());
    expect(manager.sessionOpenInTab("deferred-failure")).toBeUndefined();
    expect(manager.pinnedConnectionIds().has("old")).toBe(false);
    expect(registered).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(created.tab.tabId);
    expect(send).toHaveBeenCalledWith(TAB_CLOSED_ENVELOPE_TYPE, { tabId: created.tab.tabId });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("host spawn failed"), error);
  });

  it("a NEW session's awaited deferred fork refuses folder_not_found for a folder that vanished during the wait (GitHub #6)", async () => {
    let blocked = true;
    let missing = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const registered = vi.fn(() => () => {});
    const closed = vi.fn();
    const window = windowRig().window;
    const manager = new TabHostManager({
      fork: shutdownableForkRig().fork, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => window, env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined,
      workspaceMissing: () => missing,
      onSessionRegistered: registered, onTabClosed: closed, logger: silentLogger,
    });
    const created = manager.createTabAwaitingInitialSpawn({ workspace: "/ws/gone", sessionId: "deferred-gone", connectionId: "old", resume: false });
    // The folder is there when createTab checks it and gone by the time the
    // parked first fork is released.
    missing = true;
    blocked = false;
    release();
    expect(await created).toEqual({ ok: false, reason: "folder_not_found", workspace: "/ws/gone" });
    // Tab, binding and registration are all rolled back: nothing left to queue a
    // first prompt into, and the caller keeps the user's draft.
    expect(manager.listTabs()).toHaveLength(0);
    expect(manager.sessionOpenInTab("deferred-gone")).toBeUndefined();
    expect(manager.pinnedConnectionIds().has("old")).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("a NEW session's awaited deferred fork still opens the tab and delivers its port when the folder is there (GitHub #6)", async () => {
    const rig = shutdownableForkRig();
    let blocked = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { window, posted } = windowRig();
    const manager = new TabHostManager({
      fork: rig.fork, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => window, env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined, logger: silentLogger,
    });
    const created = manager.createTabAwaitingInitialSpawn({ workspace: "/ws", sessionId: "deferred-ok", connectionId: "old", resume: false });
    blocked = false;
    release();
    const result = await created;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deferred).toBe(true);
    expect(rig.hosts).toHaveLength(1);
    expect(result.tab.proc).not.toBeNull();
    expect(result.tab.state).toBe("running");
    // The port the caller would otherwise deliver a second time was already sent.
    expect(posted.filter((entry) => entry.channel === PORT_ENVELOPE_TYPE)).toHaveLength(1);
  });

  it("a RESUMED tab whose folder vanishes during the deferred first fork keeps its error tab (GitHub #6)", async () => {
    // A resume's first fork is parked in the same provider refresh and carries
    // `firstSpawn: true` too — but the session already exists, so the error tab
    // IS the surface: rolling it back (the new-session behaviour) would close the
    // restored tab and leave the user with nothing but a vanished sidebar entry.
    const rig = shutdownableForkRig();
    let blocked = true;
    let missing = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { window, posted, hostExited } = windowRig();
    const registered = vi.fn(() => () => {});
    const closed = vi.fn();
    const manager = new TabHostManager({
      fork: rig.fork, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => window, env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined,
      workspaceMissing: () => missing,
      onSessionRegistered: registered, onTabClosed: closed, logger: silentLogger,
    });
    const created = manager.createTab({ workspace: "/ws/gone", sessionId: "resumed-gone", connectionId: "old", resume: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The folder disappears while the provider refresh is still pending.
    missing = true;
    blocked = false;
    release();
    await vi.waitFor(() => expect(posted.filter((entry) => entry.channel === PORT_ENVELOPE_TYPE)).toHaveLength(1));
    // The tab is still here, bound, and reported as a missing-workspace error —
    // that envelope is what the renderer shows instead of "Connecting to host…".
    expect(manager.listTabs()).toHaveLength(1);
    expect(manager.sessionOpenInTab("resumed-gone")).toBe(created.tab.tabId);
    expect(manager.getTab(created.tab.tabId)?.missingWorkspace).toBe(true);
    expect(manager.getTab(created.tab.tabId)?.state).toBe("crash_looped");
    const envelope = posted.find((entry) => entry.channel === PORT_ENVELOPE_TYPE);
    expect(envelope?.payload).toMatchObject({ tabId: created.tab.tabId, workspace: "/ws/gone", missingWorkspace: true });
    // A resume is never rolled back: no close event, no registration undo, no
    // host-exit banner over the missing-folder error.
    expect(closed).not.toHaveBeenCalled();
    expect(hostExited).toHaveLength(0);
    expect(rig.hosts).toHaveLength(0);
  });

  it("refuses IPC rebind when the replacement fork throws without persisting the pin", async () => {
    const rig = shutdownableForkRig();
    const error = new Error("replacement fork failed");
    const logError = vi.fn();
    let calls = 0;
    const manager = new TabHostManager({
      fork: (...args) => { if (calls++ === 1) throw error; return rig.fork(...args); },
      hostEntry: "/fake/host.js", createChannel: fakeChannel, getWindow: () => windowRig().window,
      env: () => ({}), logger: { ...silentLogger, error: logError },
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "rebind-failure", connectionId: "old", resume: false });
    if (!created.ok) throw new Error("create failed");
    const touchSession = vi.fn();
    const deps = { manager, connectionExists: () => true, persistence: { touchSession } } as unknown as TabIpcDeps;
    expect(await handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "new" })).toEqual({ ok: false, reason: "spawn_failed" });
    expect(touchSession).not.toHaveBeenCalled();
    expect(created.tab.connectionId).toBe("old");
    expect(created.tab.state).toBe("crash_looped");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("host spawn failed"), error);
    await expect(manager.closeTab(created.tab.tabId)).resolves.toEqual({ ok: true });
  });

  it("marks a tab failed and logs the cause when a respawn fork throws", () => {
    const host = new FakeHost();
    const error = new Error("respawn fork failed");
    const logError = vi.fn();
    const recorded = vi.fn();
    const fork = vi.fn<HostForkFn>()
      .mockImplementationOnce(() => host as unknown as UtilityProcess)
      .mockImplementation(() => { throw error; });
    const manager = new TabHostManager({
      fork, hostEntry: "/fake/host.js", createChannel: fakeChannel,
      getWindow: () => windowRig().window, env: () => ({}),
      logger: { ...silentLogger, error: logError }, recordHostFailure: recorded,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "respawn", resume: false });
    expect(created.ok).toBe(true);
    host.emit("exit", 1);
    expect(created.ok && manager.getTab(created.tab.tabId)?.state).toBe("crash_looped");
    expect(created.ok && manager.getTab(created.tab.tabId)?.proc).toBeNull();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("host spawn failed"), error);
    expect(recorded).toHaveBeenCalledWith("respawn", "host_crash_loop");
  });

  it.each(["restart", "worktree move"] as const)("leaves a failed tab when a %s replacement fork throws", async (kind) => {
    const rig = shutdownableForkRig();
    const error = new Error("replacement fork failed");
    const logError = vi.fn();
    let calls = 0;
    const manager = new TabHostManager({
      fork: (...args) => { if (calls++ > 0) throw error; return rig.fork(...args); },
      hostEntry: "/fake/host.js", createChannel: fakeChannel, getWindow: () => windowRig().window,
      env: () => ({}), logger: { ...silentLogger, error: logError },
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "replacement", resume: false });
    if (!created.ok) throw new Error("create failed");
    if (kind === "restart") {
      await manager.restartTabHost(created.tab.tabId);
    } else {
      rig.hosts[0]!.emit("message", { type: WORKTREE_TRANSITION_MESSAGE_TYPE, sessionId: "replacement", fromWorkspace: "/ws", toWorkspace: "/ws/wt", projectRoot: "/ws", worktree: { id: "wt", path: "/ws/wt", branch: "feature", baseRef: "main", ownedByAnyCode: true } });
    }
    await vi.waitFor(() => expect(created.tab.state).toBe("crash_looped"));
    expect(created.tab.proc).toBeNull();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("host spawn failed"), error);
  });

  it("drains large stderr output until exit and retains only its bounded tail", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let done!: (stderr: string | undefined) => void;
      const recorded = new Promise<string | undefined>((resolve) => { done = resolve; });
      const manager = new TabHostManager({
        fork: () => {
          const child = spawn(process.execPath, ["-e", "process.stderr.write('x'.repeat(1048576) + 'END-MARKER', () => process.exit(1))"], { stdio: ["ignore", "ignore", "pipe"] });
          Object.assign(child, { postMessage: () => {} });
          return child as unknown as UtilityProcess;
        },
        hostEntry: "/unused", createChannel: fakeChannel, getWindow: () => windowRig().window,
        env: () => ({}), logger: silentLogger, limits: { maxRapidRespawns: 0 },
        recordHostFailure: (_id, _reason, _code, stderr) => done(stderr),
      });
      expect(manager.createTab({ workspace: "/tmp", sessionId: "large-stderr", resume: false }).ok).toBe(true);
      const stderr = await recorded;
      expect(stderr).toHaveLength(16384);
      expect(stderr?.endsWith("END-MARKER")).toBe(true);
      expect(write.mock.calls.reduce((n, call) => n + Buffer.byteLength(call[0] as string | Buffer), 0)).toBe(1048576 + 10);
    } finally { write.mockRestore(); }
  }, 30_000);
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

  it("closeTab closes a crash_looped tab — the breaker verdict is not a close veto", async () => {
    const { fork } = dyingForkRig();
    const { window } = windowRig();
    const manager = makeManager(fork, window);
    const a = manager.createTab({ workspace: "/ws", sessionId: "s-a", resume: false });
    const b = manager.createTab({ workspace: "/ws", sessionId: "s-b", resume: false });
    expect(a.ok && b.ok).toBe(true);
    await flush();
    const tabId = a.ok ? a.tab.tabId : "";
    expect(manager.getTab(tabId)?.state).toBe("crash_looped");
    // The PUBLIC close path (what close_session calls through main) accepts it:
    // state "closing" is sealed synchronously, the (absent) host is shut down,
    // and the tab is removed — no live-host round trip is involved.
    await expect(manager.closeTab(tabId)).resolves.toEqual({ ok: true });
    expect(manager.getTab(tabId)).toBeUndefined();
  });

  it("records a safe cause when the breaker gives up — the exit code alone named none", async () => {
    const { fork } = dyingForkRig();
    const { window } = windowRig();
    const recorded: Array<{ sessionId: string; reason: string }> = [];
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      recordHostFailure: (sessionId, reason) => recorded.push({ sessionId, reason }),
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "sess-loop", resume: false });
    expect(created.ok).toBe(true);
    await flush();
    expect(manager.getTab(created.ok ? created.tab.tabId : "")?.state).toBe("crash_looped");
    // One record, at the give-up (never per intermediate respawn).
    expect(recorded).toEqual([{ sessionId: "sess-loop", reason: "host_crash_loop" }]);
  });

  it("records a module-load failure from a real host process that exits before boot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-start-failure-"));
    try {
      const { window } = windowRig();
      let done!: () => void;
      const recorded = new Promise<void>((resolve) => { done = resolve; });
      const manager = new TabHostManager({
        fork: () => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", "import 'missing-anycode-host-test-module'"], { stdio: ["ignore", "pipe", "pipe"] });
          Object.assign(child, { postMessage: () => {} });
          return child as unknown as UtilityProcess;
        },
        hostEntry: "/unused", createChannel: fakeChannel, getWindow: () => window,
        env: () => ({}), logger: silentLogger,
        recordHostFailure: (sessionId, reason, exitCode) => { recordHostFailure(dir, sessionId, reason, exitCode); done(); },
      });
      const created = manager.createTab({ workspace: "/tmp", sessionId: "early-failure", resume: false });
      expect(created.ok).toBe(true);
      await recorded;
      const diagnostic = JSON.parse((await readFile(join(dir, "early-failure.jsonl"), "utf8")).trim());
      expect(diagnostic).toMatchObject({ code: "host_module_load", exitCode: 1 });
      expect(diagnostic.message).toContain("required module");
      expect(diagnostic.message).not.toContain("missing-anycode-host-test-module");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("records a safe system code from a real failing host process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-eacces-"));
    try {
      const { window } = windowRig();
      let done!: () => void;
      const recorded = new Promise<void>((resolve) => { done = resolve; });
      const manager = new TabHostManager({
        fork: () => {
          const child = spawn(process.execPath, ["-e", "throw new Error('EACCES: permission denied /private/secret')"], { stdio: ["ignore", "pipe", "pipe"] });
          Object.assign(child, { postMessage: () => {} });
          return child as unknown as UtilityProcess;
        },
        hostEntry: "/unused", createChannel: fakeChannel, getWindow: () => window,
        env: () => ({}), logger: silentLogger,
        recordHostFailure: (id, reason, code, stderr, signal) => { recordHostFailure(dir, id, reason, code, stderr, signal); done(); },
      });
      manager.createTab({ workspace: "/tmp", sessionId: "permission-failure", resume: false });
      await recorded;
      const diagnostic = JSON.parse((await readFile(join(dir, "permission-failure.jsonl"), "utf8")).trim());
      expect(diagnostic).toMatchObject({ code: "host_crash_loop", errorLine: "Error: EACCES: [details redacted]" });
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|secret|permission denied/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("records a redacted syntax error from an actual host startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-syntax-"));
    try {
      const { window } = windowRig();
      let done!: () => void;
      const recorded = new Promise<void>((resolve) => { done = resolve; });
      const manager = new TabHostManager({
        fork: () => {
          const child = spawn(process.execPath, ["-e", "throw new SyntaxError('secret /Users/private')"], { stdio: ["ignore", "pipe", "pipe"] });
          Object.assign(child, { postMessage: () => {} });
          return child as unknown as UtilityProcess;
        },
        hostEntry: "/unused", createChannel: fakeChannel, getWindow: () => window,
        env: () => ({}), logger: silentLogger,
        recordHostFailure: (id, reason, code, stderr, signal) => { recordHostFailure(dir, id, reason, code, stderr, signal); done(); },
      });
      manager.createTab({ workspace: "/tmp", sessionId: "syntax-failure", resume: false });
      await recorded;
      const diagnostic = JSON.parse((await readFile(join(dir, "syntax-failure.jsonl"), "utf8")).trim());
      expect(diagnostic).toMatchObject({ code: "host_syntax_error", exitCode: 1, errorLine: "SyntaxError: [details redacted]" });
      expect(JSON.stringify(diagnostic)).not.toMatch(/secret|Users/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

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
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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
      { PATH: "/base", ANYCODE_ENGINE: "codex", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
      { PATH: "/base", ANYCODE_ENGINE: "codex", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
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
      engineEnv: (engine, generation) => {
        generations.push(generation);
        return { [ENV_ENGINE]: engine, ANYCODE_HOST_GENERATION: String(generation) };
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
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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
    expect(overflow).toMatchObject({ ok: false, reason: "max_tabs", openTabs: 3, maxTabs: 3 });
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
      { PATH: "/base", ANYCODE_MODEL: "pick-x", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
      { PATH: "/base", ANYCODE_MODEL: "pick-x", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
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
    expect(envs[0]).toEqual({
      PATH: "/base",
      ANYCODE_MODEL: "base-m",
      ANYCODE_SESSION_ID: "s1",
      ANYCODE_SESSION_WORKSPACE: "/ws",
    });
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
      { PATH: "/base", ANYCODE_CONNECTION_ID: "conn-work", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
      { PATH: "/base", ANYCODE_CONNECTION_ID: "conn-work", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" },
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
    expect(envs[0]).toEqual({ PATH: "/base", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" });
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
    expect(created).toEqual({ ok: false, reason: "not_ready" });
    expect(forkSpy).not.toHaveBeenCalled();
    expect(hostExited).toHaveLength(1);
    expect(manager.listTabs()).toHaveLength(0);
  });

  it("records the dead-host cause for a fail-closed env miss — the 0.0.45 crash_looped shape", () => {
    const { window } = windowRig();
    const recorded: Array<{ sessionId: string; reason: string }> = [];
    const manager = new TabHostManager({
      fork: vi.fn<HostForkFn>(() => new FakeHost() as unknown as UtilityProcess),
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: (id?: string) => (id === "conn-glm" ? undefined : { PATH: "/base" }),
      logger: silentLogger,
      recordHostFailure: (sessionId, reason) => recorded.push({ sessionId, reason }),
    });
    manager.createTab({ workspace: "/ws", sessionId: "sess-glm", resume: false, connectionId: "conn-glm" });
    // Without this call the cause lived only in an inherited-stdio log line and
    // the user saw just "Session host unavailable".
    expect(recorded).toEqual([{ sessionId: "sess-glm", reason: "connection_env_unavailable" }]);
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
    expect(forkSpy.mock.calls[0]?.[2].env).toEqual({ PATH: "/base", ANYCODE_CONNECTION_ID: "conn-ok", ANYCODE_SESSION_ID: "s1", ANYCODE_SESSION_WORKSPACE: "/ws" });
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

  it("deliverTabPort stamps openedByAgent only for sessions the dep names (Taskana 4768)", () => {
    const { window, posted } = windowRig();
    const manager = new TabHostManager({
      fork: liveForkRig().fork, hostEntry: "/fake/host.js", createChannel: fakeChannel, getWindow: () => window, env: () => ({}), logger: silentLogger,
      isAgentOpenedSession: (sessionId) => sessionId === "s-agent",
    });
    for (const sessionId of ["s-agent", "s-human"]) {
      const created = manager.createTab({ workspace: "/ws", sessionId, resume: false });
      manager.deliverTabPort(manager.getTab(created.ok ? created.tab.tabId : "")!);
    }
    const payloads = posted.filter((p) => p.channel === PORT_ENVELOPE_TYPE).map((p) => p.payload as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]!.openedByAgent).toBe(true);
    expect("openedByAgent" in payloads[1]!).toBe(false);
  });

  it("reports every fresh host generation once, so a retained agent title can be retried (onTabPortDelivered)", () => {
    const { window, posted } = windowRig();
    const delivered: string[] = [];
    const manager = new TabHostManager({
      fork: liveForkRig().fork, hostEntry: "/fake/host.js", createChannel: fakeChannel, getWindow: () => window, env: () => ({}), logger: silentLogger,
      onTabPortDelivered: (tab) => delivered.push(tab.sessionId),
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "s-agent", resume: false });
    const tab = manager.getTab(created.ok ? created.tab.tabId : "")!;
    // A spawn delivery and a respawn delivery are two generations; a renderer
    // reload re-delivering the port is a third call.
    manager.deliverTabPort(tab);
    manager.deliverTabPort(tab);
    expect(delivered).toEqual(["s-agent", "s-agent"]);
    expect(posted.filter((p) => p.channel === PORT_ENVELOPE_TYPE)).toHaveLength(2);
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

describe("TabHostManager — provider quota event binding (Taskana 4090)", () => {
  function quotaManager(seen: Array<{ connectionId: string; message: unknown }>) {
    const rig = liveForkRig();
    const manager = new TabHostManager({
      fork: rig.fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      logger: silentLogger,
      onProviderQuotaEvent: (connectionId, message) => {
        seen.push({ connectionId, message });
      },
    });
    return { manager, hosts: rig.hosts };
  }
  const quota = { type: PROVIDER_QUOTA_EVENT_TYPE, quota: { usedPercent: 42 }, source: "x-ratelimit-tokens-remaining" };

  it("routes each tab's quota to its OWN pinned connectionId — never a sibling tab's", async () => {
    const seen: Array<{ connectionId: string; message: unknown }> = [];
    const { manager, hosts } = quotaManager(seen);
    manager.createTab({ workspace: "/a", sessionId: "sa", resume: false, connectionId: "conn-a" });
    manager.createTab({ workspace: "/b", sessionId: "sb", resume: false, connectionId: "conn-b" });
    await flush();
    hosts[1]!.emit("message", quota);
    await flush();
    expect(seen).toEqual([{ connectionId: "conn-b", message: quota }]);
  });

  it("drops a quota event from an unpinned (legacy) tab — no connection to persist onto", async () => {
    const seen: Array<{ connectionId: string; message: unknown }> = [];
    const { manager, hosts } = quotaManager(seen);
    manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false });
    await flush();
    hosts[0]!.emit("message", quota);
    await flush();
    expect(seen).toEqual([]);
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
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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
  it("4 synchronous spawns from the SAME parent, no await between them, admit exactly 3 and PARK the 4th (TASK.147 срез 1) — it wakes once a slot frees and reaches its own terminal", () => {
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
    rootHost.emit("message", spawnRequest({ requestId: "r4", spawnToolCallId: "r4-call" }));

    const events = childRunEvents(rootHost);
    const accepted = events.filter((e) => e.kind === "accepted");
    expect(accepted).toHaveLength(CHILD_RUNS_PER_PARENT_MAX);
    expect(accepted.map((e) => e.requestId)).toEqual(["r1", "r2", "r3"]);
    // TASK.147 срез 1: the cap no longer terminates a 4th request — it
    // parks. No reply (neither accepted nor rejected) has gone out for it.
    expect(events.some((e) => e.requestId === "r4")).toBe(false);
    // 1 root + 3 admitted children forked; the 4th never reached fork at all.
    expect(hosts).toHaveLength(1 + CHILD_RUNS_PER_PARENT_MAX);

    // The parked request already reserved its dedup key, exactly like a
    // running one would (§10.5 п.3's dedup discipline extends to a waiter).
    const raw = manager as unknown as { childSpawnQueue: string[]; childSpawnKeys: Map<string, string> };
    expect(raw.childSpawnQueue).toEqual(["r4"]);
    // The dedup key's join character is `childSpawnKey`'s own NUL separator
    // (§10.5 п.3) — built here via `String.fromCharCode`, not a literal
    // escape, so no NUL byte ever passes through as source text.
    const dedupKey = ["root-atomic", "r4-call"].join(String.fromCharCode(0));
    expect(raw.childSpawnKeys.has(dedupKey)).toBe(true);

    // Free r1's slot through the ONE honest release point (finalizeChildRun,
    // via a normal ChildTerminal) — the parked r4 must wake and actually fork.
    const child1Host = hosts[1]!;
    child1Host.emit("message", childTerminalMsg({ status: "completed" }));

    const afterFree = childRunEvents(rootHost);
    const r4Accepted = afterFree.find((e) => e.requestId === "r4");
    expect(r4Accepted).toMatchObject({ kind: "accepted" });
    expect(hosts).toHaveLength(1 + CHILD_RUNS_PER_PARENT_MAX + 1); // r4 forked now
    expect(raw.childSpawnQueue).toEqual([]);

    // ...and it reaches an actual terminal (the DoD's own "доходит до
    // терминала"), exactly like an immediately-admitted child would.
    const r4ChildTabId = r4Accepted?.kind === "accepted" ? r4Accepted.childTabId : "";
    const r4Host = hosts[hosts.length - 1]!;
    r4Host.emit("message", childTerminalMsg({ status: "completed" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "r4" && e.kind === "terminal")).toMatchObject({
      status: "completed",
    });
    expect(manager.getTab(r4ChildTabId)).toBeUndefined();
  });

  it("TASK.116: a child's real death reason reaches the parent verbatim through ONE terminal; a duplicate terminal cannot overwrite it or emit a second", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    manager.createTab({ workspace: "/ws", sessionId: "root-116", resume: false });
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "dead-1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "dead-1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    const childHost = hosts[1]!;

    childHost.emit("message", childTerminalMsg({ status: "error", finalText: "Claude exited during a turn" }));
    childHost.emit("message", childTerminalMsg({ status: "completed", finalText: "overwritten?" }));

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "dead-1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: "terminal", status: "error", finalText: "Claude exited during a turn" });
    expect(manager.getTab(childTabId)).toBeUndefined();
  });

  it("the 9th global spawn (spread across 3 parents, each under ITS OWN per-parent cap) PARKS on limit_global (TASK.147 срез 1) — and wakes when a DIFFERENT parent's slot frees, not just its own", () => {
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

    // A 9th spawn from the parent that still has per-parent room (2 of 3
    // used) — blocked purely by the GLOBAL cap. TASK.147 срез 1: it parks,
    // it is not told `limit_global` yet.
    rootHosts[2]!.emit("message", spawnRequest({ requestId: "p2-overflow" }));
    expect(childRunEvents(rootHosts[2]!).some((e) => e.requestId === "p2-overflow")).toBe(false);
    expect(hosts).toHaveLength(3 + 8); // 3 roots + exactly 8 children; the 9th never forked

    // Free a slot on PARENT 0 (`p0-0`, the first of the 8 children forked
    // above, at hosts[3]) — a DIFFERENT parent than the one the parked
    // request belongs to. The global cap is what was blocking it, and a
    // global slot just freed no matter WHOSE child released it (TASK.147's
    // own "заявка могла ждать из-за ГЛОБАЛЬНОГО кэпа, а освободился слот у
    // ДРУГОГО родителя — такую тоже надо будить").
    hosts[3]!.emit("message", childTerminalMsg({ status: "completed" }));

    const overflowEvent = childRunEvents(rootHosts[2]!).find((e) => e.requestId === "p2-overflow");
    expect(overflowEvent).toMatchObject({ kind: "accepted" });
    expect(hosts).toHaveLength(3 + 8 + 1); // the parked 9th finally forked

    const overflowChildTabId = overflowEvent?.kind === "accepted" ? overflowEvent.childTabId : "";
    hosts[hosts.length - 1]!.emit("message", childTerminalMsg({ status: "completed" }));
    expect(
      childRunEvents(rootHosts[2]!).find((e) => e.requestId === "p2-overflow" && e.kind === "terminal"),
    ).toMatchObject({ status: "completed" });
    expect(manager.getTab(overflowChildTabId)).toBeUndefined();
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

  it("an EXPLICIT known provider resolves via resolveProviderConnection and PREPARES: no fork before the deferred resolves, then forks on the frozen resolved target with the pin held through registration", async () => {
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
    // A controlled deferred: the fork must NOT happen until this settles.
    let resolvePrep!: (v: { ok: true; release: () => void } | { ok: false }) => void;
    const prepPromise = new Promise<{ ok: true; release: () => void } | { ok: false }>((res) => {
      resolvePrep = res;
    });
    const releaseSpy = vi.fn();
    let releaseCountAtAccepted = -1;
    let pinHeldAtAccepted = false;
    const manager = childManager(forkSpy, window, {
      resolveProviderConnection: (provider) => (provider === "known" ? "conn-known" : undefined),
      prepareChildConnection: () => prepPromise,
    });
    const root = manager.createTab({
      workspace: "/ws",
      sessionId: "root-provider",
      resume: false,
      connectionId: "conn-parent",
    });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    // Observe the accepted reply AT EMIT TIME: the preparation pin must still be
    // held (the manager releases it only in its `finally`, after registration).
    const originalPost = rootHost.postMessage.getMockImplementation();
    rootHost.postMessage.mockImplementation((msg: unknown) => {
      if ((msg as { kind?: unknown }).kind === "accepted" && (msg as { requestId?: unknown }).requestId === "prov-1") {
        releaseCountAtAccepted = releaseSpy.mock.calls.length;
        pinHeldAtAccepted = manager.pinnedConnectionIds().has("conn-known");
      }
      originalPost?.(msg);
    });
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "prov-1", provider: "known" }));
    await flush();

    // (a) No fork while preparation is pending.
    expect(hosts).toHaveLength(hostsBefore);
    expect(childRunEvents(rootHost).some((e) => e.requestId === "prov-1")).toBe(false);

    resolvePrep({ ok: true, release: releaseSpy });
    await flush();

    // (b) Forked on the FROZEN resolved target, not the parent's connection.
    expect(envs[1]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-known" });
    expect(childRunEvents(rootHost).find((e) => e.requestId === "prov-1")).toMatchObject({ kind: "accepted" });
    // (c) Pin-release integration ordering: at the moment `accepted` was emitted
    // the manager had NOT yet released the preparation pin, and the just-
    // registered child tab already protects "conn-known" via pinnedConnectionIds.
    expect(releaseCountAtAccepted).toBe(0);
    expect(pinHeldAtAccepted).toBe(true);
    // ...and once admitChildSpawn returns, the preparation pin is released
    // exactly once while the registered tab keeps protecting the connection.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(manager.pinnedConnectionIds().has("conn-known")).toBe(true);
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

  it("a resolved connection whose env is unavailable is refused not_ready before the fork, releasing the pin once (Taskana 4269)", async () => {
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
    const releaseSpy = vi.fn();
    const manager = childManager(forkSpy, window, {
      // The PARENT root's own connection resolves fine; only the CHILD's
      // explicitly-requested provider resolves to a connection whose env is gone.
      env: (connectionId) => (connectionId === "conn-gone" ? undefined : { PATH: "/base" }),
      resolveProviderConnection: () => "conn-gone",
      // Preparation itself "succeeds" (env priming reports nothing to do), but
      // the env for the frozen id is still absent — admission must refuse and
      // release the pin exactly once, never fork.
      prepareChildConnection: async () => ({ ok: true, release: releaseSpy }),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-envgone", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "env-gone", provider: "anything" }));
    await flush();

    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "env-gone",
        kind: "rejected",
        reason: "not_ready",
        message:
          'Agent: connection "conn-gone" could not be prepared for this child (deleted or its fork env is unavailable). Retry, or pick another connection.',
      },
    ]);
    expect(hosts).toHaveLength(hostsBefore); // no fork
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("cancelling a run holds its slot until the REAL reap — a 4th spawn stays PARKED (TASK.147 срез 1) until the cancelled child actually exits, then wakes it (not whoever asks next)", () => {
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

    // Still no slot: cancelling still occupies it, so this parks rather
    // than being told `limit_parent` (TASK.147 срез 1).
    rootHost.emit("message", spawnRequest({ requestId: "too-soon" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "too-soon")).toBe(false);

    // The cancelled child ACTUALLY exits now (shutdownableForkRig's auto-responder
    // already queued this on a microtask from the shutdown postMessage above, but
    // emitting explicitly here keeps the test's causality readable and robust to
    // any change in that timing).
    child1Host.emit("exit", 0);

    // The freed slot goes to the FIFO's rightful waiter, "too-soon" — not to
    // a fresh request arriving after it.
    expect(childRunEvents(rootHost).find((e) => e.requestId === "too-soon")).toMatchObject({ kind: "accepted" });
    const terminalForHold1 = childRunEvents(rootHost).find((e) => e.requestId === "hold-1" && e.kind === "terminal");
    expect(terminalForHold1).toMatchObject({ status: "cancelled" });

    // A brand-new request arriving NOW sees the cap full again (hold-2,
    // hold-3, too-soon) and parks in its turn — the freed slot was not
    // handed to it instead of the waiter that was already ahead of it.
    rootHost.emit("message", spawnRequest({ requestId: "after-reap" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "after-reap")).toBe(false);
  });
});

/**
 * TASK.147 срез 1: a spawn request exceeding the per-parent/global cap now
 * parks instead of being refused outright — the tests above (in "…admission
 * is ATOMIC") re-purpose the ORIGINAL cap tests to prove the park-then-wake
 * lifecycle end to end. These tests cover the three properties that lifecycle
 * specifically needs and nothing above already exercises: the queue's own
 * dedup surface, the queue's own upper bound, and app-quit purging every
 * waiter app-wide (as opposed to `drainChildren`'s per-parent purge, already
 * covered by the "spawn around a root's close" suite below).
 */
describe("TabHostManager — session-spawn queue (TASK.147 срез 1)", () => {
  it("a duplicate (parentSessionId, spawnToolCallId) pair is refused spawn_failed WHILE the first spawn is still queued, not only while it is running", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-dedup-queued", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "fill-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "fill-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "fill-3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);

    rootHost.emit("message", spawnRequest({ requestId: "queued-1", spawnToolCallId: "dupe-call" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "queued-1")).toBe(false); // parked, not answered

    // Same (parentSessionId, spawnToolCallId) pair, a second attempt, WHILE
    // the first is still only queued — never yet reserved in `childRuns`.
    rootHost.emit("message", spawnRequest({ requestId: "queued-2", spawnToolCallId: "dupe-call" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "queued-2")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "queued-2",
      kind: "rejected",
      reason: "spawn_failed",
      message:
        "Agent: a session-subagent for this Agent tool call is already running. Wait for it to finish before retrying.",
    });

    // Exactly the first attempt is queued — the duplicate never enqueues a
    // second entry for the same pair.
    const raw = manager as unknown as { childSpawnQueue: string[] };
    expect(raw.childSpawnQueue).toEqual(["queued-1"]);
  });

  it("the queue itself is bounded by CHILD_SPAWN_QUEUE_MAX — beyond it, a further cap-exceeding spawn is refused OUTRIGHT with the existing frozen limit text, not parked", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-queue-overflow", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "run-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "run-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "run-3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);

    for (let n = 0; n < CHILD_SPAWN_QUEUE_MAX; n++) {
      rootHost.emit("message", spawnRequest({ requestId: `queued-${n}` }));
    }
    const raw = manager as unknown as { childSpawnQueue: string[] };
    expect(raw.childSpawnQueue).toHaveLength(CHILD_SPAWN_QUEUE_MAX);
    expect(childRunEvents(rootHost).filter((e) => e.kind === "rejected")).toHaveLength(0);

    // One more, past the queue's own bound: refused outright, with the SAME
    // frozen text a cap-exceeding spawn always got pre-TASK.147 — the
    // "Границы решения" texts stay reachable exactly on this path.
    rootHost.emit("message", spawnRequest({ requestId: "overflow" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "overflow")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "overflow",
      kind: "rejected",
      reason: "limit_parent",
      message:
        'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".',
    });
    expect(raw.childSpawnQueue).toHaveLength(CHILD_SPAWN_QUEUE_MAX); // never enqueued
  });

  it("shutdownAllTabHosts (this.quitting) purges EVERY queued spawn request app-wide — rejected closing, no ghosts left in any map", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-quit-purge", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "run-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "run-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "run-3" }));
    rootHost.emit("message", spawnRequest({ requestId: "queued", spawnToolCallId: "quit-call" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "queued")).toBe(false);

    await manager.shutdownAllTabHosts();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "queued")).toMatchObject({
      kind: "rejected",
      reason: "closing",
      message: "Agent: the child session could not be started (host is closing).",
    });
    const raw = manager as unknown as {
      childSpawnQueue: string[];
      childSpawnWaiters: Map<string, unknown>;
      childSpawnKeys: Map<string, string>;
    };
    expect(raw.childSpawnQueue).toEqual([]);
    expect(raw.childSpawnWaiters.size).toBe(0);
    const dedupKey = ["root-quit-purge", "quit-call"].join(String.fromCharCode(0));
    expect(raw.childSpawnKeys.has(dedupKey)).toBe(false);
  });

  it("a spawn arriving DURING its parent's drain is refused limit_parent, not parked — a waiter would otherwise be admitted by the reaps that drain is waiting for, forking a child into a parent mid-rebind", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const created = manager.createTab({ workspace: "/ws", sessionId: "root-drain-window", resume: false, connectionId: "conn-old" });
    expect(created.ok).toBe(true);
    const tab = created.ok ? created.tab : undefined;
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "d1" }));
    rootHost.emit("message", spawnRequest({ requestId: "d2" }));
    rootHost.emit("message", spawnRequest({ requestId: "d3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);
    const hostsBeforeDrain = hosts.length;

    // A rebind drains the children WITHOUT sealing the tab `closing` first
    // (only `closeTab` seals; `handleExit` instead nulls `proc`), so the
    // parent host is still live, still `running`, and can still issue a
    // spawn while the drain awaits its reaps. Not awaited yet: an async
    // function body runs synchronously to its first `await`, so the drain
    // window is already open on the line below.
    const rebinding = manager.rebindTab(tab!, "conn-new");
    rootHost.emit("message", spawnRequest({ requestId: "d4", spawnToolCallId: "drain-window-call" }));

    // Every child is `cancelling` and §0.7 has `cancelling` hold its slot, so
    // the cap reads FULL for the whole drain — parking here would park in
    // every rebind rather than a rare one, and the waiter would then be
    // admitted by the very reaps the drain is waiting for.
    expect(childRunEvents(rootHost).find((e) => e.requestId === "d4")).toMatchObject({
      kind: "rejected",
      reason: "limit_parent",
    });
    const raw = manager as unknown as { childSpawnQueue: string[]; childSpawnKeys: Map<string, string> };
    expect(raw.childSpawnQueue).toEqual([]);
    expect(raw.childSpawnKeys.has(["root-drain-window", "drain-window-call"].join(String.fromCharCode(0)))).toBe(false);

    expect(await rebinding).toEqual({ ok: true });
    await flush();
    // Exactly one new host: the tab's own respawned root. No child was forked
    // for d4 on the way out, and the drain window is closed again.
    expect(hosts).toHaveLength(hostsBeforeDrain + 1);
    expect((manager as unknown as { drainingParents: Map<string, number> }).drainingParents.size).toBe(0);
    expect(raw.childSpawnQueue).toEqual([]);
  });

});

describe("TabHostManager — engine-aware spawnChild (TASK.102 CUT-S4 §3.2)", () => {
  it("an engine child asks isEngineReady for THAT engine, not core — ready admits, naming the engine in fork args' --child-mode triple", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const engineReady = vi.fn((_engine: EngineId) => true);
    const manager = childManager(fork, window, { engineReady });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-engine-ready", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    engineReady.mockClear();

    rootHost.emit("message", spawnRequest({ requestId: "engine-1", engine: "claude" }));

    expect(engineReady).toHaveBeenCalledWith("claude");
    expect(childRunEvents(rootHost)).toEqual([
      expect.objectContaining({ requestId: "engine-1", kind: "accepted" }),
    ]);
  });

  it("an engine child is refused not_ready (naming the engine) when THAT engine is not ready, even though core is", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { engineReady: (engine) => engine === "core" });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-engine-notready", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "codex-down", engine: "codex" }));

    expect(hosts).toHaveLength(hostsBefore); // no fork attempted — quota never reserved
    const event = childRunEvents(rootHost).find((e) => e.requestId === "codex-down");
    expect(event).toMatchObject({ kind: "rejected", reason: "not_ready" });
    expect((event as { message: string }).message).toContain("codex");
  });

  it("a `provider` alongside a non-core engine is refused not_ready and never forks (main does not trust the payload)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      engineReady: () => true,
      resolveProviderConnection: () => "conn-x",
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-engine-provider", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "engine-provider", engine: "claude", provider: "known" }));

    expect(hosts).toHaveLength(hostsBefore);
    expect(childRunEvents(rootHost)).toEqual([
      expect.objectContaining({ requestId: "engine-provider", kind: "rejected", reason: "not_ready" }),
    ]);
  });

  it("an accepted engine child's fork carries --engine-model (from req.model) but no --engine-preset, and the child's connectionId is never pinned", () => {
    const { hosts } = shutdownableForkRig();
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, opts) => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window, { engineReady: () => true });
    const root = manager.createTab({
      workspace: "/ws",
      sessionId: "root-engine-fork",
      resume: false,
      connectionId: "conn-parent",
    });
    expect(root.ok).toBe(true);

    hosts[0]!.emit("message", spawnRequest({ requestId: "engine-fork-1", engine: "claude", model: "opus[1m]" }));

    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).toContain("--engine-model");
    expect(childArgs[childArgs.indexOf("--engine-model") + 1]).toBe("opus[1m]");
    expect(childArgs).not.toContain("--engine-preset");
    const childEnv = forkSpy.mock.calls[1]?.[2]?.env ?? {};
    expect(childEnv).not.toHaveProperty("ANYCODE_CONNECTION_ID");
  });

  // TASK.102 S4 gate-fix (L1): tabs.ts:1249 states connectionId is "Never
  // consulted for a non-core engine" — an omitted req.model must NOT fall
  // back to describeChildModel(connectionId), which reads the PARENT
  // connection's own ANYCODE_MODEL (a core model string) off the ambient env.
  it("an engine child with no explicit model reports the placeholder default, never the parent connection's core ANYCODE_MODEL (L1)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      engineReady: () => true,
      env: () => ({ PATH: "/base", [ENV_MODEL]: "claude-opus-4-1" }),
    });
    const root = manager.createTab({
      workspace: "/ws",
      sessionId: "root-engine-model-law",
      resume: false,
      connectionId: "conn-parent",
    });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "engine-no-model", engine: "claude" }));

    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "engine-no-model");
    expect(accepted).toMatchObject({ kind: "accepted" });
    expect((accepted as { model: string }).model).not.toBe("claude-opus-4-1");
  });

  // TASK.102 S4 gate-fix (F4, latent): registry.ts's selectEnginePlugin treats
  // an absent ANYCODE_ENGINE as core, SILENTLY. Production's engineEnv always
  // stamps it (main/index.ts:1462), but a missing/misbehaving overlay must not
  // let a `claude` child boot a full core session on the ambient connection —
  // the spawn has to fail closed, the same shape as the unavailable-pinned-
  // connection guard just above (log + return without setting tab.proc).
  it("a claude child whose composed fork env omits ANYCODE_ENGINE fails closed — never forks a silent core session (F4)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      engineReady: () => true,
      engineEnv: () => ({}), // omits ANYCODE_ENGINE entirely
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-engine-env-missing", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    const hostsBefore = hosts.length;

    rootHost.emit("message", spawnRequest({ requestId: "engine-env-missing", engine: "claude" }));

    expect(hosts).toHaveLength(hostsBefore); // no fork attempted — never a silent core session
    expect(childRunEvents(rootHost)).toEqual([
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: "engine-env-missing",
        kind: "rejected",
        reason: "spawn_failed",
        message: "Agent: the child session failed to start.",
      },
    ]);
  });

  it("a core child (engine absent) keeps the byte-identical prior behavior: isEngineReady(\"core\"), connectionId inherited, model rides modelOverride not --engine-model", () => {
    const { hosts } = shutdownableForkRig();
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, opts) => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({
      workspace: "/ws",
      sessionId: "root-core-fork",
      resume: false,
      connectionId: "conn-parent",
    });
    expect(root.ok).toBe(true);

    hosts[0]!.emit("message", spawnRequest({ requestId: "core-fork-1", model: "sonnet" }));

    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).not.toContain("--engine-model");
    const childEnv = forkSpy.mock.calls[1]?.[2]?.env ?? {};
    expect(childEnv).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-parent" });
    expect(childRunEvents(hosts[0]!)).toEqual([
      expect.objectContaining({ requestId: "core-fork-1", kind: "accepted" }),
    ]);
  });
});

describe("TabHostManager — a profile's effort reaches a core child's host (TASK.127)", () => {
  function rig() {
    const { hosts } = shutdownableForkRig();
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-effort", resume: false, connectionId: "conn-parent" }).ok).toBe(true);
    return { hosts, forkSpy };
  }

  it("stamps ANYCODE_REASONING_EFFORT on the child fork when the request carries effort", () => {
    const { hosts, forkSpy } = rig();
    hosts[0]!.emit("message", spawnRequest({ requestId: "effort-1", effort: "low" }));
    expect(forkSpy.mock.calls[1]?.[2]?.env).toMatchObject({ ANYCODE_REASONING_EFFORT: "low" });
  });

  it("no effort on the request leaves the connection's own tier untouched", () => {
    const { hosts, forkSpy } = rig();
    hosts[0]!.emit("message", spawnRequest({ requestId: "effort-2" }));
    expect(forkSpy.mock.calls[1]?.[2]?.env ?? {}).not.toHaveProperty("ANYCODE_REASONING_EFFORT");
  });

  it("a core child's xhigh effort maps to max in the stamped env", () => {
    const { hosts, forkSpy } = rig();
    hosts[0]!.emit("message", spawnRequest({ requestId: "effort-xhigh-core", effort: "xhigh" }));
    expect(forkSpy.mock.calls[1]?.[2]?.env).toMatchObject({ ANYCODE_REASONING_EFFORT: "max" });
  });
});

describe("TabHostManager — a profile's effort reaches an engine child as --engine-effort", () => {
  function rig() {
    const { hosts } = shutdownableForkRig();
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, opts) => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = childManager(forkSpy, window, { engineReady: () => true });
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-engine-effort", resume: false, connectionId: "conn-parent" }).ok).toBe(true);
    return { hosts, forkSpy };
  }

  it("a claude/codex engine child's xhigh effort rides argv as --engine-effort xhigh (verbatim)", () => {
    for (const engine of ["claude", "codex"] as const) {
      const { hosts, forkSpy } = rig();
      hosts[0]!.emit("message", spawnRequest({ requestId: `engine-effort-${engine}`, engine, effort: "xhigh" }));
      const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
      expect(childArgs).toContain("--engine-effort");
      expect(childArgs[childArgs.indexOf("--engine-effort") + 1]).toBe("xhigh");
      // An engine child never stamps the core env var.
      expect(forkSpy.mock.calls[1]?.[2]?.env ?? {}).not.toHaveProperty("ANYCODE_REASONING_EFFORT");
    }
  });

  it("an engine child with no effort emits no --engine-effort flag", () => {
    const { hosts, forkSpy } = rig();
    hosts[0]!.emit("message", spawnRequest({ requestId: "engine-effort-none", engine: "claude" }));
    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).not.toContain("--engine-effort");
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

  it("close on a root with a QUEUED (not yet admitted) spawn kills the waiter too — rejected closing, no ghosts in childRuns/childrenByParentTab/childSpawnKeys (TASK.147 срез 1)", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const a = manager.createTab({ workspace: "/a", sessionId: "root-close-queued", resume: false });
    manager.createTab({ workspace: "/b", sessionId: "root-close-queued-b", resume: false });
    expect(a.ok).toBe(true);
    const rootTabId = a.ok ? a.tab.tabId : "";
    const rootHost = hosts[0]!;

    // Fill the per-parent cap, then a 4th request parks instead of forking.
    rootHost.emit("message", spawnRequest({ requestId: "close-run-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "close-run-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "close-run-3" }));
    rootHost.emit("message", spawnRequest({ requestId: "close-queued", spawnToolCallId: "close-call" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);
    expect(childRunEvents(rootHost).some((e) => e.requestId === "close-queued")).toBe(false);
    const hostsBeforeClose = hosts.length;

    const result = await manager.closeTab(rootTabId);
    expect(result).toEqual({ ok: true });

    // The waiter never forked (closing purges it before it could) and gets
    // the SAME `rejected closing` reply a spawn arriving after the seal
    // already gets (TASK.147's "отвечай существующим CHILD_CLOSING_MESSAGE
    // через тот же rejected-путь").
    expect(hosts).toHaveLength(hostsBeforeClose);
    expect(childRunEvents(rootHost).find((e) => e.requestId === "close-queued")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "close-queued",
      kind: "rejected",
      reason: "closing",
      message: "Agent: the child session could not be started (host is closing).",
    });

    // No ghosts anywhere — including the queue-specific structures a waiter
    // (as opposed to a running child) reserves.
    const raw = manager as unknown as {
      childRuns: Map<string, unknown>;
      childrenByParentTab: Map<string, Set<string>>;
      childSpawnKeys: Map<string, string>;
      childSpawnQueue: string[];
      childSpawnWaiters: Map<string, unknown>;
    };
    expect(raw.childRuns.size).toBe(0);
    expect(raw.childrenByParentTab.has(rootTabId)).toBe(false);
    expect(raw.childSpawnQueue).toEqual([]);
    expect(raw.childSpawnWaiters.size).toBe(0);
    const dedupKey = ["root-close-queued", "close-call"].join(String.fromCharCode(0));
    expect(raw.childSpawnKeys.has(dedupKey)).toBe(false);
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

  it("TASK.147 срез 1: the deadline is NOT consumed while a request sits queued — it starts only at the REAL fork, never at park time", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-deadline-queued", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "fill-1" }));
    rootHost.emit("message", spawnRequest({ requestId: "fill-2" }));
    rootHost.emit("message", spawnRequest({ requestId: "fill-3" }));
    // Clear the 3 fillers' OWN start-deadlines (child-ready) — otherwise
    // their unrelated 30s timeouts would fire during the long wait below
    // and confound this test via their own finalize/pump side effect.
    for (let n = 1; n <= 3; n++) {
      hosts[n]!.emit("message", childReadyMsg());
    }
    rootHost.emit("message", spawnRequest({ requestId: "queued-slow" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "queued-slow")).toBe(false);

    // Sit queued for LONGER than the start-deadline itself — if the timer
    // wrongly started at park time, this alone would already have produced
    // a spurious timeout terminal for a request that never even forked.
    vi.advanceTimersByTime(CHILD_START_DEADLINE_MS * 3);
    expect(childRunEvents(rootHost).some((e) => e.requestId === "queued-slow")).toBe(false);

    // Free a slot — the queued request wakes and forks NOW.
    const fill1Host = hosts[1]!;
    fill1Host.emit("message", childTerminalMsg({ status: "completed" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "queued-slow");
    expect(accepted).toMatchObject({ kind: "accepted" });

    // Its own deadline gets a FULL fresh window counted from THIS fork, not
    // whatever remained after the (already longer) wait above.
    vi.advanceTimersByTime(CHILD_START_DEADLINE_MS - 1);
    expect(
      childRunEvents(rootHost).find((e) => e.requestId === "queued-slow" && e.kind === "terminal"),
    ).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(
      childRunEvents(rootHost).find((e) => e.requestId === "queued-slow" && e.kind === "terminal"),
    ).toMatchObject({ status: "error" });
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

  // TASK.219: the child's own model facts ride the terminal relay verbatim.
  it("a ChildTerminal with model+responseModel relays both verbatim; a legacy terminal relays neither (TASK.219)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-term-models", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "m1" }));
    const childHost = hosts[1]!;

    childHost.emit(
      "message",
      childTerminalMsg({ status: "completed", finalText: "hi", model: "booted-model", responseModel: "glm-5.3" }),
    );
    const withModels = childRunEvents(rootHost).find((e) => e.requestId === "m1" && e.kind === "terminal");
    expect(withModels).toMatchObject({ model: "booted-model", responseModel: "glm-5.3" });

    rootHost.emit("message", spawnRequest({ requestId: "m2" }));
    const legacyChildHost = hosts[2]!;
    legacyChildHost.emit("message", childTerminalMsg({ status: "completed", finalText: "legacy" }));
    const legacy = childRunEvents(rootHost).find((e) => e.requestId === "m2" && e.kind === "terminal");
    expect(legacy).toMatchObject({ status: "completed", finalText: "legacy" });
    expect(legacy && "model" in legacy).toBe(false);
    expect(legacy && "responseModel" in legacy).toBe(false);
  });

  // ── TASK 4239: malformed ChildTerminal handling ──
  // A ChildTerminal with a malformed KNOWN field fails fail-closed parsing
  // (parseChildTerminal -> null); before 4239 the dispatch branch silently
  // returned, leaving the ledger entry "running" forever (the slot leaked
  // until app quit). The manager now finalizes it through the same
  // finalizeChildRun funnel handleChildExit uses. These tests share one
  // warn-spying logger (built per-test, local to this suite).
  function malformedLogger(): { logger: TabLogger; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const logger: TabLogger = { log() {}, warn, error() {} };
    return { logger, warn };
  }

  it("a malformed ChildTerminal (bad known field) warns once naming tab+run+error, finalizes the run as error 'malformed terminal', reaps the tab, frees the quota; a later VALID duplicate terminal is a no-op (TASK 4239)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const { logger, warn } = malformedLogger();
    const manager = childManager(fork, window, { logger });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-malformed-1", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";

    childHost.emit("message", childTerminalMsg({ turns: "many" }));

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "error" });
    expect(String((terminals[0] as { finalText?: string }).finalText)).toContain("malformed terminal");
    expect(warn).toHaveBeenCalledTimes(1);
    const warnText = String(warn.mock.calls[0]?.[0]);
    expect(warnText).toContain(childTabId);
    expect(warnText).toContain("t1");
    expect(warnText).toContain("as error");
    expect(manager.getTab(childTabId)).toBeUndefined();

    childHost.emit("message", childTerminalMsg({ status: "completed", finalText: "late" }));
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // The quota was freed exactly once: the full per-parent cap succeeds now.
    rootHost.emit("message", spawnRequest({ requestId: "t2" }));
    rootHost.emit("message", spawnRequest({ requestId: "t3" }));
    rootHost.emit("message", spawnRequest({ requestId: "t4" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(1 + 3);
  });

  it("a duplicate MALFORMED terminal after the finalize is a no-op — one warn, one terminal, no double free (TASK 4239)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const { logger, warn } = malformedLogger();
    const manager = childManager(fork, window, { logger });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-malformed-2", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childTerminalMsg({ turns: "many" }));
    childHost.emit("message", childTerminalMsg({ turns: "many" }));

    expect(childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    rootHost.emit("message", spawnRequest({ requestId: "t2" }));
    rootHost.emit("message", spawnRequest({ requestId: "t3" }));
    rootHost.emit("message", spawnRequest({ requestId: "t4" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(1 + 3);
  });

  it("cancel precedence: a malformed terminal racing an in-flight cancel finalizes as cancelled with CHILD_CANCELLED_MESSAGE, warn names 'cancelled' (TASK 4239)", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const { logger, warn } = malformedLogger();
    const manager = childManager(fork, window, { logger });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-malformed-3", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";

    rootHost.emit("message", runCancel("t1"));
    childHost.emit("message", childTerminalMsg({ turns: "many" }));
    await flush();

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "cancelled", finalText: "Agent: the child session was cancelled." });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("as cancelled");
    expect(manager.getTab(childTabId)).toBeUndefined();
  });

  it("an unknown additive terminal key is accepted and stripped end-to-end: the run finalizes normally with no warning (TASK 4239)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const { logger, warn } = malformedLogger();
    const manager = childManager(fork, window, { logger });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-additive", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "t1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";

    childHost.emit("message", childTerminalMsg({ status: "completed", finalText: "hi", futureAdditive: true }));

    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "completed", finalText: "hi" });
    expect("futureAdditive" in (terminals[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(manager.getTab(childTabId)).toBeUndefined();
  });

  it("stale/unauthorized sender: a malformed terminal emitted by the ROOT host (no childOf) neither warns nor finalizes anything (TASK 4239)", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const { logger, warn } = malformedLogger();
    const manager = childManager(fork, window, { logger });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-stale", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "t1" }));
    const childHost = hosts[1]!;

    rootHost.emit("message", childTerminalMsg({ turns: "many" }));

    expect(childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal")).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    // The live child run is untouched: its later valid terminal still relays once.
    childHost.emit("message", childTerminalMsg({ status: "completed", finalText: "fine" }));
    const terminals = childRunEvents(rootHost).filter((e) => e.requestId === "t1" && e.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "completed", finalText: "fine" });
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

  it("ChildTerminal.declaredDoneAtCeiling:true is relayed into the terminal ChildRunEvent; absent stays absent (TASK 4149)", () => {
    for (const [id, overrides, expected] of [
      ["relay-done-ceiling", { status: "max_turns", declaredDoneAtCeiling: true }, true],
      ["relay-no-done-ceiling", { status: "max_turns" }, false],
    ] as const) {
      const { fork, hosts } = shutdownableForkRig();
      const { window } = windowRig();
      const manager = childManager(fork, window);
      const root = manager.createTab({ workspace: "/ws", sessionId: `root-${id}`, resume: false });
      expect(root.ok).toBe(true);
      const rootHost = hosts[0]!;
      rootHost.emit("message", spawnRequest({ requestId: id }));
      hosts[1]!.emit("message", childTerminalMsg(overrides));
      const terminal = childRunEvents(rootHost).find((e) => e.requestId === id && e.kind === "terminal");
      expect(terminal).toBeDefined();
      expect(terminal && "declaredDoneAtCeiling" in terminal).toBe(expected);
    }
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

  // N1 (Taskana 4704 re-review #3): the R2 safe error descriptor must reach
  // the parent host. Before this relay it was parsed and then dropped here,
  // so the infra classifier always fell back to the free-text first line.
  it("N1: ChildTerminal.errorDescriptor is relayed VERBATIM into the terminal ChildRunEvent; absent => key absent", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-descriptor", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-descriptor" }));
    hosts[1]!.emit("message", childTerminalMsg({ status: "error", finalText: "rate limited (HTTP 429)\nmore model prose", errorDescriptor: "rate limited (HTTP 429)" }));
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "relay-descriptor" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "error", errorDescriptor: "rate limited (HTTP 429)" });
  });

  it("N1: a terminal WITHOUT errorDescriptor relays no such key", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-no-descriptor", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-no-descriptor" }));
    hosts[1]!.emit("message", childTerminalMsg({ status: "error", finalText: "boom" }));
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "relay-no-descriptor" && e.kind === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal && "errorDescriptor" in terminal).toBe(false);
  });

  it("ChildTerminal.finalTurnFinishReason is copied VERBATIM into the terminal ChildRunEvent; absent => key absent", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-relay-length", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "relay-length" }));
    const childHost = hosts[1]!;

    childHost.emit("message", childTerminalMsg({ finalTurnFinishReason: "length" }));

    const terminal = childRunEvents(rootHost).find(
      (e) => e.requestId === "relay-length" && e.kind === "terminal",
    );
    expect(terminal).toMatchObject({ finalTurnFinishReason: "length" });

    // Absence case — same rig, a second run:
    rootHost.emit("message", spawnRequest({ requestId: "relay-no-length" }));
    const childHost2 = hosts[2]!;
    childHost2.emit("message", childTerminalMsg());
    const terminal2 = childRunEvents(rootHost).find(
      (e) => e.requestId === "relay-no-length" && e.kind === "terminal",
    );
    expect(terminal2).toBeDefined();
    expect(terminal2 && "finalTurnFinishReason" in terminal2).toBe(false);
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

  it("listChildRuns() projects the admitted run's ledger fields plus the child tab's live host pid", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-child-runs", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "cr-1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "cr-1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    const childHost = hosts[1]!;

    const runs = manager.listChildRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      requestId: "cr-1",
      parentSessionId: "root-child-runs",
      childTabId,
      childSessionId,
      state: "starting",
      pid: childHost.pid,
      // GitHub #17 slice F: the child tab's real fork stamp on the clock.
      forkedAt: expect.any(Number),
    });
  });

  // GitHub #17 slice F: the automation projection carries the
  // child tab's ACTUAL fork time on the injected clock — the anchor the live
  // acceptance driver measures delivery against.
  it("listChildRuns exposes forkedAt as the injected clock's actual child spawn time, and null before a child tab exists", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let clock = 5_000;
    const manager = childManager(fork, window, { now: () => clock });
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-forked-at", resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    clock = 9_123;
    rootHost.emit("message", spawnRequest({ requestId: "fa-1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "fa-1" && e.kind === "accepted");
    expect(accepted?.kind).toBe("accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(manager.listChildRuns()[0]?.forkedAt).toBe(9_123);
    // Looked up live: once the child tab is gone the fork time is null, never stale.
    const childHost = hosts[1]!;
    childHost.emit("message", childTerminalMsg({ status: "completed" }));
    expect(manager.getTab(childTabId)).toBeUndefined();
    expect(manager.listChildRuns()).toEqual([]);
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
 *
 * SUPERSEDED outcome (TASK.102 CUT-S2 §10.11.2, N2): T1's original fix left
 * the still-unreaped child tracked, on the theory that "a later drain
 * retries it" — ratified as false (`closeTab`'s very next line deletes the
 * parent; there may be no later drain at all). The deadline branch now
 * administratively tombstones every remaining child via `finalizeChildRun`
 * instead, so this test's own outcome assertions were updated to match —
 * the BOUNDING behavior under test here (no infinite loop) is unchanged.
 */
describe("TabHostManager — drainChildren is bounded, not an infinite cascade (review T1b)", () => {
  it("gives up on waiting and administratively tombstones the still-unreaped child, instead of looping forever or leaving its ledger dangling (§10.11.2)", async () => {
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
    // deadline expiring rather than drainChildren just quietly returning as
    // if the cascade had actually finished on its own.
    expect(errors.some((m) => m.includes(rootTabId))).toBe(true);
    // §10.11.2 (N2): giving up is an ADMINISTRATIVE reap, not a no-op —
    // the child is gone, and so is its ledger entry (the quota slot it
    // would otherwise have held forever).
    expect(manager.getTab(childTabId)).toBeUndefined();
    const raw2 = manager as unknown as { childRuns: Map<string, unknown> };
    expect(raw2.childRuns.has("t1b-req")).toBe(false);
    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "t1b-req" && e.kind === "terminal");
    expect(terminal).toMatchObject({ status: "cancelled" });
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
        engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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
        engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
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

/**
 * TASK.102 CUT-S2 §10.11.2 (N2) — the ratified verdict: an expired
 * `drainChildren` deadline is an ADMINISTRATIVE reap, not a silent "the next
 * drain retries it" (the removed comment's promise was false for `closeTab`,
 * whose very next line deletes the parent tab — there IS no next drain for
 * this child). The new postcondition is that `drainChildren` never returns
 * with a non-empty per-parent ledger: every remaining child is tombstoned
 * through the SAME single release funnel every other terminal path already
 * uses (`finalizeChildRun`), freeing the quota slot and the
 * `(parentSessionId, spawnToolCallId)` dedup key it was otherwise holding
 * forever.
 */
describe("TabHostManager — drainChildren's deadline branch administratively tombstones every remaining child (TASK.102 CUT-S2 §10.11.2 N2)", () => {
  it("(i) a force-killed child that never exits is finalized `cancelled`/CHILD_UNREAPED_MESSAGE, its tab/ledger/dedup-key are all gone, and a late real exit afterward is a harmless no-op (first-wins)", async () => {
    const { fork, hosts } = liveForkRig(); // never responds to shutdown, never exits
    const { window } = windowRig();
    let jumped = false;
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      // Deterministic control over drainChildren's OWN (5x exitDeadlineMs)
      // deadline, decoupled from the real per-child shutdownTabHost timer
      // below — same technique as review T1b.
      now: () => (jumped ? Number.MAX_SAFE_INTEGER : 0),
      logger: silentLogger,
      limits: { exitDeadlineMs: 20 },
    });
    // A second root so closing the first is never refused as last_tab.
    const rootA = manager.createTab({ workspace: "/ws-n2i-a", sessionId: "root-n2i-a", resume: false });
    const rootB = manager.createTab({ workspace: "/ws-n2i-b", sessionId: "root-n2i-b", resume: false });
    expect(rootA.ok).toBe(true);
    expect(rootB.ok).toBe(true);
    const rootTabId = rootA.ok ? rootA.tab.tabId : "";
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "n2i-req" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "n2i-req" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");
    const childHost = hosts[2]!;

    // closeTab's synchronous prefix runs `drainChildren`'s own synchronous
    // prefix too (computing its deadline off `now()` while `jumped` is still
    // false) before ever yielding back here — so flipping `jumped` right
    // after this call, still in the same synchronous turn, guarantees every
    // SUBSEQUENT deadline check (the loop's later revisits) reads the jumped
    // clock without disturbing the deadline value itself.
    const closePromise = manager.closeTab(rootTabId);
    jumped = true;

    const result = await Promise.race([
      closePromise.then((r) => ({ kind: "resolved" as const, r })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 2000)),
    ]);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.r).toEqual({ ok: true });
    }

    // The stuck child's host was genuinely force-killed (its own real
    // exitDeadlineMs elapsed) — it just never actually exits in this rig.
    expect(childHost.kill).toHaveBeenCalled();

    const raw = manager as unknown as {
      childRuns: Map<string, unknown>;
      childSpawnKeys: Map<string, unknown>;
      childrenByParentTab: Map<string, Set<string>>;
    };
    // Postcondition: drainChildren must not have returned with a non-empty
    // per-parent ledger — quota slot AND dedup key both freed (folds in the
    // optional (iv): `childRuns.size` IS the global quota's live count).
    expect(raw.childRuns.size).toBe(0);
    expect(raw.childSpawnKeys.size).toBe(0);
    expect(raw.childrenByParentTab.has(rootTabId)).toBe(false);
    expect(manager.getTab(childTabId)).toBeUndefined();

    const terminal = childRunEvents(rootHost).find((e) => e.requestId === "n2i-req" && e.kind === "terminal");
    expect(terminal).toMatchObject({
      status: "cancelled",
      finalText: "Agent: the child session was cancelled; its host process did not exit and was abandoned.",
    });

    // (iii) regression guard: the force-killed process's real "exit" can
    // still land late, after the administrative tombstone already ran.
    // First-wins discipline (finalizeChildRun's own no-op-on-missing-entry
    // branch, `handleChildExit:1556-1561`) must swallow it silently — no
    // second terminal, no exception, no resurrected tab.
    const terminalCountBefore = childRunEvents(rootHost).filter(
      (e) => e.requestId === "n2i-req" && e.kind === "terminal",
    ).length;
    expect(() => childHost.emit("exit", 137)).not.toThrow();
    const terminalCountAfter = childRunEvents(rootHost).filter(
      (e) => e.requestId === "n2i-req" && e.kind === "terminal",
    ).length;
    expect(terminalCountAfter).toBe(terminalCountBefore);
    expect(manager.getTab(childTabId)).toBeUndefined();
  });

  it("(ii) relocateTab's own drain deadline tombstones a stuck child too — the dedup key and per-parent quota are both freed for the relocated generation", async () => {
    const { fork, hosts } = liveForkRig(); // never responds to shutdown, never exits
    const { window } = windowRig();
    let jumped = false;
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      now: () => (jumped ? Number.MAX_SAFE_INTEGER : 0),
      logger: silentLogger,
      limits: { exitDeadlineMs: 20 },
    });
    const root = manager.createTab({ workspace: "/ws-n2ii", sessionId: "root-n2ii", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "n2ii-r1", spawnToolCallId: "n2ii-call" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "n2ii-r1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");

    const transition: WorktreeTransitionMessage = {
      type: WORKTREE_TRANSITION_MESSAGE_TYPE,
      sessionId: "root-n2ii",
      fromWorkspace: "/ws-n2ii",
      toWorkspace: "/ws-n2ii/.worktrees/wt-1",
      projectRoot: "/ws-n2ii",
      worktree: {
        id: "wt-1",
        path: "/ws-n2ii/.worktrees/wt-1",
        branch: "feature-y",
        baseRef: "main",
        ownedByAnyCode: true,
      },
    };
    // Same synchronous-prefix trick as (i) above: `relocateTab`'s own
    // `drainChildren` deadline is computed before this emit ever returns.
    rootHost.emit("message", transition);
    jumped = true;

    // The stuck child never answers, so the loop needs one real
    // exitDeadlineMs (20ms) force-kill round-trip before the (already
    // jumped) deadline check on the next revisit tombstones it, then the
    // master's own (also real, 20ms) shutdown before the respawn lands.
    // Budget generously against real wall-clock flakiness.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(manager.getTab(childTabId)).toBeUndefined();
    const relocated = manager.getTab(rootTabId);
    expect(relocated?.workspace).toBe("/ws-n2ii/.worktrees/wt-1");

    const newRootHost = hosts[2]!;
    // The SAME (parentSessionId, spawnToolCallId) pair the stuck child held
    // — the dedup key must be free, not eaten forever by the never-exiting
    // zombie.
    newRootHost.emit("message", spawnRequest({ requestId: "n2ii-r2", spawnToolCallId: "n2ii-call" }));
    expect(childRunEvents(newRootHost).find((e) => e.requestId === "n2ii-r2")?.kind).toBe("accepted");

    // And the per-parent quota is genuinely back to a full 3 (not still
    // counting the leaked stuck run): two MORE fresh spawns succeed...
    newRootHost.emit("message", spawnRequest({ requestId: "n2ii-r3", spawnToolCallId: "n2ii-call-2" }));
    newRootHost.emit("message", spawnRequest({ requestId: "n2ii-r4", spawnToolCallId: "n2ii-call-3" }));
    expect(childRunEvents(newRootHost).find((e) => e.requestId === "n2ii-r3")?.kind).toBe("accepted");
    expect(childRunEvents(newRootHost).find((e) => e.requestId === "n2ii-r4")?.kind).toBe("accepted");
    // ...and a 4th PARKS rather than being refused outright (TASK.147 срез
    // 1) — no reply has gone out for it yet.
    newRootHost.emit("message", spawnRequest({ requestId: "n2ii-r5", spawnToolCallId: "n2ii-call-4" }));
    expect(childRunEvents(newRootHost).some((e) => e.requestId === "n2ii-r5")).toBe(false);
  });

  it("(iii) the crash-path respawn's own drain deadline (handleExit's THIRD drainChildren call site) tombstones a stuck child too — ledger/dedup-key/quota are all free on the RESPAWNED root", async () => {
    // Luna review (§10.12.5 п.2): (i) covers closeTab's drainChildren call,
    // (ii) covers relocateTab's — neither exercises the crash path's own
    // `void this.drainChildren(tab)` in `handleExit` (tabs.ts:1761). A root
    // that stops calling `drainChildren` on crash-respawn would pass both
    // (i) and (ii) while leaving every crash-orphaned child's ledger entry,
    // dedup key, and sibling-set slot stuck forever across the respawn.
    const { fork, hosts } = liveForkRig(); // never responds to shutdown, never exits
    const { window } = windowRig();
    let jumped = false;
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      // Same synchronous-prefix technique as (i)/(ii): `handleExit` is NOT
      // async, but the `drainChildren` call it fires (void, not awaited)
      // still runs synchronously up to its own first internal `await`
      // (computing its deadline off the STILL-unjumped `now()`) before
      // `handleExit` itself continues on, synchronously, to the respawn
      // decision and fork — all before this emit ever returns to the test.
      now: () => (jumped ? Number.MAX_SAFE_INTEGER : 0),
      logger: silentLogger,
      limits: { exitDeadlineMs: 20 },
    });
    const root = manager.createTab({ workspace: "/ws-n2iii", sessionId: "root-n2iii", resume: false });
    expect(root.ok).toBe(true);
    const rootTabId = root.ok ? root.tab.tabId : "";
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "n2iii-r1", spawnToolCallId: "n2iii-call" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "n2iii-r1" && e.kind === "accepted");
    const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
    expect(childTabId).not.toBe("");
    const childHost = hosts[1]!;

    // Crash (uptime ~0, below the breaker cap -> respawns), same trigger as
    // the §0.6 cascade-cancel tests above (line ~2062).
    rootHost.emit("exit", 1);
    jumped = true;
    const respawnedRootHost = hosts[2]!;

    // The stuck child needs one real exitDeadlineMs (20ms) force-kill
    // round-trip before the (already-jumped) deadline check on the loop's
    // next revisit administratively tombstones it. Budget generously
    // against real wall-clock flakiness (same margin as (ii) above).
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(childHost.kill).toHaveBeenCalled();
    expect(manager.getTab(childTabId)).toBeUndefined();

    const raw = manager as unknown as {
      childRuns: Map<string, unknown>;
      childSpawnKeys: Map<string, unknown>;
      childrenByParentTab: Map<string, Set<string>>;
    };
    // §10.11.2 postcondition: drainChildren never returns with a non-empty
    // per-parent ledger, on ANY of its three call sites — this is the third.
    expect(raw.childRuns.size).toBe(0);
    expect(raw.childSpawnKeys.size).toBe(0);
    expect(raw.childrenByParentTab.has(rootTabId)).toBe(false);

    // The tombstone terminal relays to the RESPAWNED host — the crashed one
    // is dead (same discipline as the §0.6 cascade test at line ~2090).
    const terminal = childRunEvents(respawnedRootHost).find(
      (e) => e.requestId === "n2iii-r1" && e.kind === "terminal",
    );
    expect(terminal).toMatchObject({ status: "cancelled" });

    // The SAME (parentSessionId, spawnToolCallId) pair the stuck child held —
    // the dedup key and per-parent quota must both be free, not eaten
    // forever by a zombie that survived the crash.
    respawnedRootHost.emit("message", spawnRequest({ requestId: "n2iii-r2", spawnToolCallId: "n2iii-call" }));
    expect(childRunEvents(respawnedRootHost).find((e) => e.requestId === "n2iii-r2")?.kind).toBe("accepted");
  });
});

/**
 * Luna review R2 MAJOR (N4) — a defect introduced by fix-wave F2/review T3:
 * `shutdownTabHost`'s timeout branch correctly guards its force-kill
 * bookkeeping on `tab.proc === child` (only the call that still recognizes
 * the tab's CURRENT process may force-kill/register it), but the trailing
 * `tab.proc = null;` at the very end of the function stayed UNCONDITIONAL.
 * A losing racer — a call whose captured `child` has since been superseded
 * by a newer generation (a respawn/relocate that already ran to completion
 * while this call was still waiting on its own deadline) — nulls out the
 * pointer to the CURRENT, live process. That generation's own later real
 * exit then reads as stale (`tab.proc !== child`, since `tab.proc` is
 * already null) and is silently dropped: the engine is never reaped.
 */
describe("TabHostManager — shutdownTabHost's trailing tab.proc=null is guarded like its force-kill bookkeeping (Luna R2 MAJOR / N4)", () => {
  it("a losing shutdownTabHost call does not null out a NEWER generation's tab.proc out from under it", async () => {
    vi.useFakeTimers();
    try {
      const { fork, hosts } = liveForkRig(); // never responds to shutdown, never exits
      const { window } = windowRig();
      const manager = new TabHostManager({
        fork,
        hostEntry: "/fake/host.js",
        createChannel: fakeChannel,
        getWindow: () => window,
        env: () => ({}),
        logger: silentLogger,
        limits: { exitDeadlineMs: 1000 },
      });
      const root = manager.createTab({ workspace: "/ws-n4", sessionId: "root-n4", resume: false });
      expect(root.ok).toBe(true);
      const rootTabId = root.ok ? root.tab.tabId : "";
      const tab = manager.getTab(rootTabId)!;

      const raw = manager as unknown as {
        shutdownTabHost(tab: unknown): Promise<void>;
        spawnTabHost(tab: unknown, opts: { firstSpawn: boolean }): void;
      };

      // The eventual LOSER: starts shutting down the CURRENT (old)
      // generation. Its deadline is armed now, at t=1000, against a host
      // that never answers and never exits.
      const shutdownPromise = raw.shutdownTabHost(tab);

      // While it is still waiting, something else (relocateTab's own
      // drainChildren -> shutdownTabHost -> respawn sequence, simulated
      // directly here to isolate this ONE guard, same technique review T3's
      // second test uses) already moved the tab on to a NEW generation.
      tab.state = "running";
      raw.spawnTabHost(tab, { firstSpawn: false });
      const newHost = hosts[1]!;
      expect(manager.getTab(rootTabId)?.proc).toBe(newHost);

      // The loser's own deadline (armed against the OLD generation) elapses
      // now. On the unfixed code this unconditionally nulls `tab.proc`,
      // wiping out the brand-new generation it never knew about.
      await vi.advanceTimersByTimeAsync(1000);
      await shutdownPromise;

      expect(manager.getTab(rootTabId)?.proc).toBe(newHost);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Luna review R4 MINOR (N5) — `cancelChildRun`'s unknown-tab branch (review
 * T1a) scrubs the ghost `childTabId` out of `childrenByParentTab` (so
 * `drainChildren`'s loop does not revisit it forever) but leaves `childRuns`
 * (keyed by requestId), the `(parentSessionId, spawnToolCallId)` dedup key in
 * `childSpawnKeys`, and the ledger entry's start-deadline timer all
 * untouched — the same class of quota/dedup-key leak as N2, reached by a
 * different path. Fixed the SAME way N2 was: through the single
 * `finalizeChildRun` release funnel, never a second, bespoke cleanup.
 */
describe("TabHostManager — cancelChildRun's unknown-tab branch also frees the ledger entry, dedup key, and start-deadline timer (Luna R4 MINOR / N5)", () => {
  it("tombstones the ghost childTabId's childRuns entry through finalizeChildRun instead of leaking its quota slot and dedup key", async () => {
    // Luna review R4 MINOR (N5, §10.12.5 п.1): the original version of this
    // test asserted the LEDGER-LEVEL symptoms (childRuns/childSpawnKeys
    // cleared, a terminal relayed) but never asserted the TIMER itself was
    // the thing that cleared — a `clearTimeout(entry.startDeadline)`
    // regression in `finalizeChildRun` stays fully green here, because the
    // orphaned timer's later, harmless-looking firing finds nothing left to
    // act on. Fake timers make the timer itself the discriminator.
    vi.useFakeTimers();
    try {
      const { fork, hosts } = liveForkRig();
      const { window } = windowRig();
      const manager = childManager(fork, window);
      const root = manager.createTab({ workspace: "/ws-n5", sessionId: "root-n5", resume: false });
      expect(root.ok).toBe(true);
      const rootTabId = root.ok ? root.tab.tabId : "";
      const rootHost = hosts[0]!;
      rootHost.emit("message", spawnRequest({ requestId: "n5-req", spawnToolCallId: "n5-call" }));
      const accepted = childRunEvents(rootHost).find((e) => e.requestId === "n5-req" && e.kind === "accepted");
      const childTabId = accepted?.kind === "accepted" ? accepted.childTabId : "";
      expect(childTabId).not.toBe("");

      // Manufacture T1a's own state (identical technique, identical rationale
      // for why this is the only safe way to reach it): the tab is gone from
      // `tabs` while `childRuns`/`childrenByParentTab` still name it.
      const raw = manager as unknown as {
        tabs: Map<string, unknown>;
        childRuns: Map<string, { childTabId: string; requestId: string }>;
        childSpawnKeys: Map<string, string>;
        childrenByParentTab: Map<string, Set<string>>;
        cancelChildRun(id: string): Promise<void>;
      };
      // The dedup key's join character is `childSpawnKey`'s own NUL separator
      // (§10.5 п.3) — built here via `String.fromCharCode`, not a literal
      // escape, so no NUL byte ever passes through as source text.
      const dedupKey = ["root-n5", "n5-call"].join(String.fromCharCode(0));
      raw.tabs.delete(childTabId);
      expect(raw.childRuns.has("n5-req")).toBe(true);
      expect(raw.childSpawnKeys.has(dedupKey)).toBe(true);

      // Discriminator 1 (§10.12.5 п.1): the only fake timer pending right now
      // is the ledger entry's own start-deadline `setTimeout`. `cancelChildRun`
      // clears it (via `finalizeChildRun`) AND schedules a real macrotask of
      // its own (F1's `setImmediate`, also fake under `vi.useFakeTimers()`) to
      // settle its returned promise — so the net count one full turn later
      // must be exactly one lower than before the call, never merely
      // unchanged (the signature of a leaked, never-cleared start-deadline).
      const timersBefore = vi.getTimerCount();
      const cancelPromise = raw.cancelChildRun(childTabId);
      await vi.advanceTimersByTimeAsync(0); // flushes cancelChildRun's own settling macrotask
      await cancelPromise;
      const timersAfter = vi.getTimerCount();
      expect(timersBefore - timersAfter).toBe(1);

      // Sibling set is clean (already true before this fix, per T1a).
      expect(raw.childrenByParentTab.get(rootTabId)?.has(childTabId)).toBeFalsy();
      // The N5 gap: the ledger entry AND its dedup key — the actual quota
      // reservation — must ALSO be freed, not left dangling forever.
      expect(raw.childRuns.has("n5-req")).toBe(false);
      expect(raw.childSpawnKeys.has(dedupKey)).toBe(false);

      // Same tombstone funnel as N2: the parent gets a cancelled terminal for
      // the abandoned run instead of silence.
      const terminal = childRunEvents(rootHost).find((e) => e.requestId === "n5-req" && e.kind === "terminal");
      expect(terminal).toMatchObject({ status: "cancelled" });

      // Discriminator 2 (§10.12.5 п.1): if the start-deadline timer had only
      // LEAKED (never cleared) rather than merely misreported by discriminator
      // 1, letting it run all the way out would still fire
      // `handleChildStartTimeout` — a silent no-op against an already-deleted
      // entry that produces no NEW childRunEvents either way. Advancing past
      // it and asserting nothing new arrived closes that gap too.
      const eventsBefore = childRunEvents(rootHost).length;
      await vi.advanceTimersByTimeAsync(CHILD_START_DEADLINE_MS);
      expect(childRunEvents(rootHost).length).toBe(eventsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── TASK.106 cut-2: rebindTab (§D1 — the relocateTab precedent) ────────────

describe("TabHostManager — rebindTab (TASK.106 cut-2)", () => {
  /** A manager whose env() answers per-connection envs by id — rebind's own fail-closed seam. */
  function rebindManager(fork: HostForkFn, window: WindowLike, envs: Map<string, NodeJS.ProcessEnv>) {
    return new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: (connectionId?: string) =>
        connectionId === undefined ? {} : envs.get(connectionId),
      logger: silentLogger,
      limits: {},
    });
  }

  it("refuses not_ready WITHOUT mutating anything when the target's fork env is not primed", async () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = rebindManager(fork, window, new Map([["conn-old", {}]]));
    const created = manager.createTab({
      workspace: "/ws",
      sessionId: "s-reb",
      resume: false,
      connectionId: "conn-old",
    });
    expect(created.ok).toBe(true);
    const tab = created.ok ? created.tab : undefined;
    expect(tab).toBeDefined();

    const res = await manager.rebindTab(tab!, "conn-unprimed");

    expect(res).toEqual({ ok: false, reason: "not_ready" });
    // Nothing was mutated: still the original pin, original host, running.
    expect(tab!.connectionId).toBe("conn-old");
    expect(tab!.state).toBe("running");
    expect(tab!.proc).not.toBeNull();
  });

  it("rebinds: shuts the old host down, mutates the pin, re-spawns on the resume path, delivers a port", async () => {
    const { fork, hosts } = liveForkRig();
    const { window, posted } = windowRig();
    const manager = rebindManager(
      fork,
      window,
      new Map([
        ["conn-old", { ANYCODE_API_KEY: "old" }],
        ["conn-new", { ANYCODE_API_KEY: "new", ANYCODE_MODEL: "glm-5.3" }],
      ]),
    );
    // describeConnection mirrors main/index.ts's wiring: without it the port
    // envelope omits the pin pair entirely (both fields ride together, F2).
    (manager as unknown as { deps: { describeConnection?: (id: string) => { providerId: string } } }).deps.describeConnection =
      (id: string) => ({ providerId: id === "conn-new" ? "z-ai" : "moonshot" });
    const created = manager.createTab({
      workspace: "/ws",
      sessionId: "s-reb2",
      resume: false,
      connectionId: "conn-old",
      modelOverride: "imported-model",
    });
    expect(created.ok).toBe(true);
    const tab = created.ok ? created.tab : undefined;
    expect(tab).toBeDefined();
    const oldProc = tab!.proc;
    expect(hosts).toHaveLength(1);

    const res = await manager.rebindTab(tab!, "conn-new");

    expect(res).toEqual({ ok: true });
    // A second host was forked and took over the tab.
    expect(hosts).toHaveLength(2);
    expect(tab!.proc).not.toBe(oldProc);
    // The pin moved; a stale per-fork model override did not follow.
    expect(tab!.connectionId).toBe("conn-new");
    expect(tab!.modelOverride).toBeUndefined();
    // The respawn runs on the RESUME path (--resume s-reb2), not --session.
    const rebindingFork = fork;
    void rebindingFork;
    // The port envelope carries the NEW pin to the renderer.
    const envelope = posted.find(
      (entry) => (entry.payload as { tabId?: string } | undefined)?.tabId === tab!.tabId,
    );
    expect(envelope).toBeDefined();
    expect((envelope!.payload as { connectionId?: string }).connectionId).toBe("conn-new");
    // Breakers were reset for the new epoch.
    expect(tab!.rapidRespawns).toBe(0);
    expect(tab!.initialResume).toBe(true);
    expect(tab!.state).toBe("running");
  });

  it("the re-spawn's argv runs --resume with the SAME session id (history survives by construction)", async () => {
    const seenArgs: string[][] = [];
    const hosts: FakeHost[] = [];
    const fork: HostForkFn = (_entry, args) => {
      seenArgs.push([...args]);
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      return host as unknown as UtilityProcess;
    };
    const { window } = windowRig();
    const manager = rebindManager(
      fork,
      window,
      new Map([
        ["conn-old", {}],
        ["conn-new", {}],
      ]),
    );
    const created = manager.createTab({
      workspace: "/ws",
      sessionId: "s-resume-argv",
      resume: false,
      connectionId: "conn-old",
    });
    expect(created.ok).toBe(true);

    const res = await manager.rebindTab(created.ok ? created.tab : undefined!, "conn-new");

    expect(res).toEqual({ ok: true });
    expect(seenArgs).toHaveLength(2);
    expect(seenArgs[1]).toContain("--resume");
    expect(seenArgs[1]).toContain("s-resume-argv");
    expect(seenArgs[1]).not.toContain("--session");
  });
});

describe("TabHostManager — recognizer live-config broadcast (TASK.198 E1 §1.2)", () => {
  it("delivers to every live root CORE tab, and skips a codex root, a child-session tab, and a dead proc", () => {
    const hosts: FakeHost[] = [];
    const fork: HostForkFn = () => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    };
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      engineReady: () => true,
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
      logger: silentLogger,
      limits: {},
    });

    const rootA = manager.createTab({ workspace: "/a", sessionId: "root-a", resume: false });
    const rootB = manager.createTab({ workspace: "/b", sessionId: "root-b", resume: false });
    const codexRoot = manager.createTab({ workspace: "/c", sessionId: "root-codex", resume: false, engine: "codex" });
    expect(rootA.ok).toBe(true);
    expect(rootB.ok).toBe(true);
    expect(codexRoot.ok).toBe(true);

    // A child-session tab spawned under root A (fork #4, index 3).
    const rootAHost = hosts[0]!;
    rootAHost.emit("message", spawnRequest({ requestId: "recognizer-child-1" }));
    const childHost = hosts[3];
    expect(childHost).toBeDefined();

    // Simulate root B's host being dead/mid-respawn (its live proc is null).
    const rootBTab = rootB.ok ? manager.getTab(rootB.tab.tabId) : undefined;
    expect(rootBTab).toBeDefined();
    if (rootBTab !== undefined) {
      rootBTab.proc = null;
    }

    const event: RecognizerConfigChanged = {
      type: RECOGNIZER_CONFIG_CHANGED_TYPE,
      endpoint: { model: "vision-model" },
    };
    expect(() => manager.broadcastRecognizerConfig(event)).not.toThrow();

    expect(rootAHost.postMessage).toHaveBeenCalledWith(event);
    expect(hosts[1]!.postMessage).not.toHaveBeenCalledWith(event); // root B — dead proc
    expect(hosts[2]!.postMessage).not.toHaveBeenCalledWith(event); // codex root — non-core engine
    expect(childHost?.postMessage).not.toHaveBeenCalledWith(event); // child-session tab
  });

  it("swallows a live proc's postMessage throw — best-effort, same discipline as replyChildRunEvent", () => {
    const throwing = new FakeHost();
    throwing.postMessage.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const fork: HostForkFn = () => throwing as unknown as UtilityProcess;
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => windowRig().window,
      env: () => ({}),
      logger: silentLogger,
      limits: {},
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "root-throw", resume: false });
    expect(created.ok).toBe(true);

    expect(() =>
      manager.broadcastRecognizerConfig({ type: RECOGNIZER_CONFIG_CHANGED_TYPE, endpoint: null }),
    ).not.toThrow();
    expect(throwing.postMessage).toHaveBeenCalled();
  });

  it("is a no-op with zero live tabs", () => {
    const manager = makeManager(() => new FakeHost() as unknown as UtilityProcess, windowRig().window);
    expect(() =>
      manager.broadcastRecognizerConfig({ type: RECOGNIZER_CONFIG_CHANGED_TYPE, endpoint: null }),
    ).not.toThrow();
  });
});

describe("TASK.194 model admission before fork", () => {
  it("rejects an unavailable model before it can reach the child's HTTP request", () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const validateChildModel = vi.fn(() => { throw new Error("not in connection"); });
    const manager = childManager(fork, window, { validateChildModel });
    manager.createTab({ workspace: "/ws", sessionId: "model-guard-root", resume: false, connectionId: "z-ai-connection" });
    const root = hosts[0]!;
    root.emit("message", spawnRequest({ model: "opus" }));
    expect(validateChildModel).toHaveBeenCalledWith("opus", "z-ai-connection");
    expect(hosts).toHaveLength(1);
    expect(childRunEvents(root)).toMatchObject([{ kind: "rejected", reason: "not_ready", message: expect.stringContaining("matching provider/connection") }]);
  });
  it("validates against an explicitly selected provider rather than the parent", async () => {
    const { fork, hosts } = liveForkRig();
    const { window } = windowRig();
    const validateChildModel = vi.fn();
    const manager = childManager(fork, window, {
      validateChildModel,
      resolveProviderConnection: () => "anthropic-connection",
      // Taskana 4269: an explicit provider now prepares its connection before
      // the fork (env primed + pin held).
      prepareChildConnection: async () => ({ ok: true, release: () => {} }),
    });
    manager.createTab({ workspace: "/ws", sessionId: "model-provider-root", resume: false, connectionId: "z-ai-connection" });
    hosts[0]!.emit("message", spawnRequest({ model: "claude-opus-5-5", provider: "anthropic" }));
    await flush();
    expect(validateChildModel).toHaveBeenCalledWith("claude-opus-5-5", "anthropic-connection");
    expect(hosts).toHaveLength(2);
  });
});

describe("TASK.242 owned process communication routing", () => {
  it("pins workspace/session and accepts a correlated response only from the recipient host", async () => {
    const rig = liveForkRig(); const manager = makeManager(rig.fork, windowRig().window);
    manager.createTab({ workspace: "/allowed", sessionId: "a", resume: false });
    manager.createTab({ workspace: "/other", sessionId: "b", resume: false });
    await expect(manager.communicationRequest("a", "get_session_status", undefined, "/moved")).rejects.toThrow("unavailable");
    let settled = false;
    const request = manager.communicationRequest("a", "get_session_status", undefined, "/allowed").then((value) => { settled = true; return value; });
    const packet = rig.hosts[0]!.postMessage.mock.calls.map((call) => call[0] as { type?: string; requestId?: string }).find((m) => m.type === "communication_request")!;
    rig.hosts[1]!.emit("message", { type: "communication_response", requestId: packet.requestId, result: { sessionId: "b" } });
    await flush(); expect(settled).toBe(false);
    rig.hosts[0]!.emit("message", { type: "communication_response", requestId: packet.requestId, result: { sessionId: "a" } });
    expect(await request).toEqual({ sessionId: "a" });
  });
  it("does not accept a host delivery addressed to another session", () => {
    const rig = liveForkRig(); const manager = makeManager(rig.fork, windowRig().window);
    manager.createTab({ workspace: "/allowed", sessionId: "a", resume: false });
    const listener = vi.fn(); const unsubscribe = manager.onCommunicationDelivery(listener);
    rig.hosts[0]!.emit("message", { type: "communication_delivery", delivery: { envelope: { recipientSessionId: "b" }, state: "acknowledged" } });
    expect(listener).not.toHaveBeenCalled(); unsubscribe();
  });
});

describe("TabHostManager — follow-up to a finished child (resumeChildSessionId)", () => {
  /** shutdownableForkRig plus each fork's argv/env, in fork order. */
  function argvRig() {
    const rig = shutdownableForkRig();
    const forks: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const fork: HostForkFn = (entry, args, opts) => {
      forks.push({ args, env: opts.env });
      return rig.fork(entry, args, opts);
    };
    return { fork, hosts: rig.hosts, forks };
  }

  async function finishedChild(sessionId: string, overrides: Partial<ChildSpawnRequest> = {}) {
    const { fork, hosts, forks } = argvRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { validateChildModel: () => {} });
    expect(manager.createTab({ workspace: "/ws", sessionId, resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "first", ...overrides }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "first" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    hosts[1]!.emit("message", childTerminalMsg({ finalText: "found defects" }));
    return { manager, hosts, forks, rootHost, childSessionId };
  }

  it("boots a new host on the SAME child session with --resume and its pinned model, once the old host has exited", async () => {
    const { hosts, forks, rootHost, childSessionId } = await finishedChild("root-resume", { model: "glm-5.3" });
    rootHost.emit("message", spawnRequest({ requestId: "again", resumeChildSessionId: childSessionId, prompt: "fix defect 1" }));
    // The finished host is still exiting: nothing is forked or answered yet.
    expect(hosts).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hosts).toHaveLength(3);
    const args = forks[2]!.args;
    expect(args.slice(0, 2)).toEqual(["--resume", childSessionId]);
    expect(args).toContain("--child-parent");
    expect(forks[2]!.env?.ANYCODE_MODEL).toBe("glm-5.3");
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "again" && e.kind === "accepted");
    expect(accepted).toMatchObject({ childSessionId, model: "glm-5.3" });

    // The follow-up prompt alone is released at child-ready.
    hosts[2]!.emit("message", childReadyMsg());
    expect(hosts[2]!.postMessage.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ prompt: "fix defect 1" }),
    );

    // Its terminal reaches the parent under the new requestId, and the child stays continuable.
    hosts[2]!.emit("message", childTerminalMsg({ finalText: "fixed" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "again" && e.kind === "terminal")).toMatchObject({
      childSessionId,
      finalText: "fixed",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", spawnRequest({ requestId: "third", resumeChildSessionId: childSessionId }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "third")).toMatchObject({ kind: "accepted", childSessionId });
  });

  it("refuses a child id this parent never spawned, without forking", async () => {
    const { hosts, rootHost } = await finishedChild("root-unknown");
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", spawnRequest({ requestId: "bogus", resumeChildSessionId: "someone-elses-child" }));
    expect(hosts).toHaveLength(2);
    expect(childRunEvents(rootHost).find((e) => e.requestId === "bogus")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
    });
  });

  it("refuses another parent's finished child", async () => {
    const { manager, hosts, childSessionId } = await finishedChild("root-owner");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-other", resume: false }).ok).toBe(true);
    const otherHost = hosts[2]!;
    otherHost.emit("message", spawnRequest({ requestId: "steal", resumeChildSessionId: childSessionId }));
    expect(hosts).toHaveLength(3);
    expect(childRunEvents(otherHost).find((e) => e.requestId === "steal")).toMatchObject({ kind: "rejected", reason: "not_ready" });
  });

  it("refuses a model/provider override and a second follow-up while the first is still running", async () => {
    const { hosts, rootHost, childSessionId } = await finishedChild("root-busy");
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", spawnRequest({ requestId: "override", resumeChildSessionId: childSessionId, model: "other" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "override")).toMatchObject({ kind: "rejected", reason: "not_ready" });

    rootHost.emit("message", spawnRequest({ requestId: "run", resumeChildSessionId: childSessionId }));
    rootHost.emit("message", spawnRequest({ requestId: "dup", resumeChildSessionId: childSessionId }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "run")).toMatchObject({ kind: "accepted" });
    expect(childRunEvents(rootHost).find((e) => e.requestId === "dup")).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(hosts).toHaveLength(3);
  });

  it("an engine child is never continuable", async () => {
    const { fork, hosts } = argvRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { engineReady: () => true });
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-engine", resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "eng", engine: "codex" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "eng" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    hosts[1]!.emit("message", childTerminalMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", spawnRequest({ requestId: "eng2", resumeChildSessionId: childSessionId }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "eng2")).toMatchObject({ kind: "rejected", reason: "not_ready" });
  });
});

describe("TabHostManager — follow-up card alias", () => {
  it("maps a follow-up run's own call id to the continued child; a fresh spawn gets no alias", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-alias", resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "a1", spawnToolCallId: "call-a1" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "a1" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    hosts[1]!.emit("message", childTerminalMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", spawnRequest({ requestId: "a2", spawnToolCallId: "call-a2", resumeChildSessionId: childSessionId }));

    expect(manager.followUpChildSessionId("root-alias", "call-a2")).toBe(childSessionId);
    expect(manager.followUpChildSessionId("root-alias", "call-a1")).toBeUndefined();
    expect(manager.followUpChildSessionId("other-root", "call-a2")).toBeUndefined();
  });
});

// ── TASK.119 / TASK.147 slice 2: LIVE session-capacity limits (settings readers) ──

describe("TabHostManager — live session limits (TASK.119 / TASK.147 срез 2)", () => {
  it("DEFAULT_BREAKER_LIMITS.maxTabs is 20 (TASK.119 п.1)", () => {
    expect(DEFAULT_BREAKER_LIMITS.maxTabs).toBe(20);
  });

  it("createTab respects a LIVE maxTabs reader — change applies without restart (DoD)", () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    let cap = 5;
    const manager = makeManager(fork, window, {});
    // makeManager does not accept readers; construct via the same rig but a
    // reader-injecting manager (mirrors makeManager's own wiring).
    const readerManager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      limits: {},
      maxTabs: () => cap,
    });

    for (let n = 0; n < 5; n++) {
      const r = readerManager.createTab({ workspace: "/ws", sessionId: `s${n}`, resume: false });
      expect(r.ok).toBe(true);
    }
    const sixth = readerManager.createTab({ workspace: "/ws", sessionId: "s5", resume: false });
    expect(sixth).toMatchObject({ ok: false, reason: "max_tabs", openTabs: 5, maxTabs: 5 });

    cap = 6;
    const sixthRetry = readerManager.createTab({ workspace: "/ws", sessionId: "s5", resume: false });
    expect(sixthRetry.ok).toBe(true);
    expect(readerManager.capacity()).toEqual({ open: 6, max: 6 });
  });

  it("a below-range reader value clamps to the sanctioned min", () => {
    const { fork } = liveForkRig();
    const { window } = windowRig();
    const manager = new TabHostManager({
      fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      logger: silentLogger,
      limits: {},
      maxTabs: () => 2,
    });
    for (let n = 0; n < 4; n++) {
      const r = manager.createTab({ workspace: "/ws", sessionId: `s${n}`, resume: false });
      expect(r.ok).toBe(true);
    }
    const fifth = manager.createTab({ workspace: "/ws", sessionId: "s4", resume: false });
    expect(fifth).toMatchObject({ ok: false, reason: "max_tabs", openTabs: 4, maxTabs: 4 });
  });

  it("a LIVE childRunsPerParentMax reader applies at each waiter's next wake", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let pp = 1;
    const manager = childManager(fork, window, { childRunsPerParentMax: () => pp });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-pp-live", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "r1" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(1);

    rootHost.emit("message", spawnRequest({ requestId: "r2" }));
    rootHost.emit("message", spawnRequest({ requestId: "r3" }));

    const raw = manager as unknown as { childSpawnQueue: string[] };
    expect(raw.childSpawnQueue).toEqual(["r2", "r3"]);
    expect(childRunEvents(rootHost).some((e) => e.requestId === "r2" || e.requestId === "r3")).toBe(false);

    pp = 2;
    hosts[1]!.emit("message", childTerminalMsg({ status: "completed" }));

    const events = childRunEvents(rootHost);
    expect(events.find((e) => e.requestId === "r2")?.kind).toBe("accepted");
    expect(events.find((e) => e.requestId === "r3")?.kind).toBe("accepted");
    expect(raw.childSpawnQueue).toEqual([]);
  });

  it("a LIVE childRunsGlobalMax reader applies at each waiter's next wake", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let gg = 1;
    const manager = childManager(fork, window, { childRunsGlobalMax: () => gg });
    for (const sid of ["rootA", "rootB", "rootC"]) {
      const r = manager.createTab({ workspace: "/ws", sessionId: sid, resume: false });
      expect(r.ok).toBe(true);
    }
    const [hostA, hostB, hostC] = [hosts[0]!, hosts[1]!, hosts[2]!];

    hostA.emit("message", spawnRequest({ requestId: "a1" }));
    expect(childRunEvents(hostA).filter((e) => e.kind === "accepted")).toHaveLength(1);

    hostB.emit("message", spawnRequest({ requestId: "b1" }));
    hostC.emit("message", spawnRequest({ requestId: "c1" }));

    const raw = manager as unknown as { childSpawnQueue: string[] };
    expect(raw.childSpawnQueue).toEqual(["b1", "c1"]);

    gg = 2;
    hosts[3]!.emit("message", childTerminalMsg({ status: "completed" })); // A's child

    const bEvents = childRunEvents(hostB);
    const cEvents = childRunEvents(hostC);
    expect(bEvents.find((e) => e.requestId === "b1")?.kind).toBe("accepted");
    expect(cEvents.find((e) => e.requestId === "c1")?.kind).toBe("accepted");
    expect(raw.childSpawnQueue).toEqual([]);
  });

  it("reducing a live cap never cancels admitted runs — a NEW spawn parks instead of rejecting", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let gg = 2;
    const manager = childManager(fork, window, { childRunsGlobalMax: () => gg });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-reduce", resume: false });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "k1" }));
    rootHost.emit("message", spawnRequest({ requestId: "k2" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(2);

    gg = 1; // reduce below the two already running
    rootHost.emit("message", spawnRequest({ requestId: "k3" }));

    const events = childRunEvents(rootHost);
    expect(events.some((e) => e.kind === "rejected")).toBe(false);
    expect(events.filter((e) => e.kind === "terminal")).toHaveLength(0);
    const raw = manager as unknown as { childSpawnQueue: string[]; childRuns: Map<string, unknown> };
    expect(raw.childRuns.size).toBe(2);
    expect(raw.childSpawnQueue).toEqual(["k3"]);
  });
});

// TASK.180: the creating spawn's turn budget (req.maxTurns) rides the child's
// argv as --child-max-turns <n> — only for a FRESH child, never a follow-up
// (resumed) child or an ordinary tab.
describe("TabHostManager — child turn budget argv (TASK.180)", () => {
  function forkSpyRig() {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, _opts) => {
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    });
    return { forkSpy, hosts };
  }

  it("a fresh CORE child request with a budget forks with --child-max-turns <n>", () => {
    const { forkSpy, hosts } = forkSpyRig();
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-budget-core", resume: false });
    expect(root.ok).toBe(true);

    hosts[0]!.emit("message", spawnRequest({ requestId: "budget-core", maxTurns: 17 }));

    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).toContain("--child-max-turns");
    expect(childArgs[childArgs.indexOf("--child-max-turns") + 1]).toBe("17");
  });

  it("a fresh ENGINE child request with a budget also forks with --child-max-turns <n>", () => {
    const { forkSpy, hosts } = forkSpyRig();
    const { window } = windowRig();
    const manager = childManager(forkSpy, window, { engineReady: () => true });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-budget-engine", resume: false });
    expect(root.ok).toBe(true);

    hosts[0]!.emit("message", spawnRequest({ requestId: "budget-engine", engine: "claude", maxTurns: 5 }));

    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).toContain("--child-max-turns");
    expect(childArgs[childArgs.indexOf("--child-max-turns") + 1]).toBe("5");
  });

  it("a child request WITHOUT a budget leaves the argv unchanged (no flag)", () => {
    const { forkSpy, hosts } = forkSpyRig();
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-budget-none", resume: false });
    expect(root.ok).toBe(true);

    hosts[0]!.emit("message", spawnRequest({ requestId: "budget-none" }));

    const childArgs = forkSpy.mock.calls[1]?.[1] ?? [];
    expect(childArgs).not.toContain("--child-max-turns");
  });

  it("a follow-up (resumed) child omits the budget even if the request carries one", async () => {
    const { forkSpy, hosts } = forkSpyRig();
    const { window } = windowRig();
    const manager = childManager(forkSpy, window);
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-budget-followup", resume: false });
    expect(root.ok).toBe(true);

    // First (creating) run: budget rides argv; child finishes.
    hosts[0]!.emit("message", spawnRequest({ requestId: "budget-first", maxTurns: 9 }));
    const childHost = hosts[1]!;
    const accepted = childRunEvents(hosts[0]!).find((e) => e.requestId === "budget-first" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    childHost.emit("message", childReadyMsg());
    childHost.emit("message", childTerminalMsg());
    // Let the reap (shutdown -> exit -> reaped.then) microtask chain settle so
    // the follow-up admits synchronously rather than parking on `reaped`.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Follow-up on the finished child: a NEW host forks, without the budget.
    const forksBefore = forkSpy.mock.calls.length;
    hosts[0]!.emit("message", spawnRequest({ requestId: "budget-second", resumeChildSessionId: childSessionId, maxTurns: 40 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forkSpy.mock.calls.length).toBe(forksBefore + 1);
    const followUpArgs = forkSpy.mock.calls[forkSpy.mock.calls.length - 1]?.[1] ?? [];
    expect(followUpArgs).not.toContain("--child-max-turns");
  });
});

// ---------------------------------------------------------------------------
// Taskana 4269: a profile selects its own connection. These exercise the LOAD-
// BEARING admission protocol in main/tabs.ts: the child-run ledger slot is
// reserved SYNCHRONOUSLY before the preparation await (so caps stay exact), the
// frozen connection id comes from prepareChildConnection under resolveResumePin's
// protocol, and post-await rechecks refuse to fork after close/shutdown/cancel/
// generation change. The env-recording fork lets us prove WHICH connection each
// child actually booted on.

describe("child spawn — profile-declared connection routing (Taskana 4269)", () => {
  type PrepResult = { ok: true; release: () => void } | { ok: false };

  /** A controllable preparation: the test decides when (and how) it settles. */
  function deferred(): { promise: Promise<PrepResult>; resolve: (v: PrepResult) => void } {
    let resolve!: (v: PrepResult) => void;
    const promise = new Promise<PrepResult>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** Shutdownable env-recording fork: hosts exit on `shutdown`, and every fork's env is captured. */
  function envRig() {
    const hosts: FakeHost[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const fork: HostForkFn = (_entry, _args, opts) => {
      envs.push(opts.env ?? {});
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      host.postMessage.mockImplementation((msg: unknown) => {
        if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
      });
      return host as unknown as UtilityProcess;
    };
    return { fork, hosts, envs };
  }

  function acceptedOn(host: FakeHost) {
    return childRunEvents(host).filter((e) => e.kind === "accepted");
  }

  it("DoD: two routed spawns on ONE parent fork on their own connections (glm-planner conn-glm, ds-executor conn-ds)", async () => {
    const { fork, hosts, envs } = envRig();
    const { window } = windowRig();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-routing", resume: false, connectionId: "conn-parent" });
    expect(root.ok).toBe(true);
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "glm", agentType: "glm-planner", connectionId: "conn-glm" }));
    rootHost.emit("message", spawnRequest({ requestId: "ds", agentType: "ds-executor", connectionId: "conn-ds" }));
    await flush();
    expect(preps).toHaveLength(2); // both reached preparation; no fork until it settles
    expect(acceptedOn(rootHost)).toHaveLength(0);

    preps[0]!.resolve({ ok: true, release: () => {} });
    await flush();
    preps[1]!.resolve({ ok: true, release: () => {} });
    await flush();

    expect(acceptedOn(rootHost).map((e) => e.requestId).sort()).toEqual(["ds", "glm"]);
    // SAME supervisor parent (one root), DIFFERENT child connections.
    expect(envs[1]!.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    expect(envs[2]!.ANYCODE_CONNECTION_ID).toBe("conn-ds");
  });

  it("counts a PENDING preparation against the per-parent cap (the reservation precedes the await)", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-cap", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1); // A reserved its slot synchronously, now awaiting preparation
    expect(hosts).toHaveLength(1);

    // B sees the cap FULL even though A has not forked — proof the slot is held pre-await.
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" }));
    expect(preps).toHaveLength(1); // B parked, never reached preparation
    expect(childRunEvents(rootHost).some((e) => e.requestId === "B")).toBe(false);
    expect(hosts).toHaveLength(1);

    preps[0]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({ kind: "accepted" });
    expect(hosts).toHaveLength(2);

    // Finishing A frees the slot -> pump admits B -> B prepares and forks on conn-ds.
    hosts[1]!.emit("message", childTerminalMsg());
    await flush();
    expect(preps).toHaveLength(2);
    expect(acceptedOn(rootHost).some((e) => e.requestId === "B")).toBe(false);
    preps[1]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });
    expect(hosts).toHaveLength(3);
  });

  it("preparation failure => not_ready naming the connection, slot released, NO fork, release never called", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseSpy = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-prepfail", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    preps[0]!.resolve({ ok: false });
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "A",
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: connection "conn-glm" could not be prepared for this child (deleted or its fork env is unavailable). Retry, or pick another connection.',
    });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(1); // no fork

    // The failed slot was released -> a following spawn admits immediately.
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" }));
    await flush();
    expect(preps).toHaveLength(2);
    preps[1]!.resolve({ ok: true, release: releaseSpy });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });
  });

  it("a rejecting prepareChildConnection is caught: same honest not_ready, no unhandled rejection", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => Promise.reject(new Error("priming blew up")),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-prepreject", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: connection "conn-glm" could not be prepared for this child (deleted or its fork env is unavailable). Retry, or pick another connection.',
    });
    expect(hosts).toHaveLength(1); // no fork, and the process survived
  });

  it("NO prepareChildConnection dep => honest not_ready, never a successful no-op fork", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      // prepareChildConnection deliberately absent; an env happens to exist.
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-nodep", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: connection "conn-glm" could not be prepared for this child (deleted or its fork env is unavailable). Retry, or pick another connection.',
    });
    expect(hosts).toHaveLength(1);
  });

  it("NO resolveChildConnection dep (unknown id) => not_ready naming the connection, no preparation, no fork", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
    const manager = childManager(fork, window, { prepareChildConnection: prepareSpy });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-noresolver", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-ghost" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "A",
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: connection "conn-ghost" declared by this profile is not available in this host. Fix or remove the profile\'s "connection:" frontmatter.',
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(1);
  });

  it("EXPLICIT provider path: unknown provider fails closed, no preparation, no parent fallback", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
    const manager = childManager(fork, window, {
      resolveProviderConnection: (p) => (p === "known" ? "conn-known" : undefined),
      prepareChildConnection: prepareSpy,
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-unknownprov", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", provider: "mystery" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message: 'Agent: provider connection "mystery" is not available in this host. Omit "provider" to use the parent session\'s connection.',
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(1); // never silently on the parent's conn-parent
  });

  it("deleted-while-queued: a request whose target is DELETED between enqueue and admission is refused not_ready, no preparation, no fork", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    // conn-ds EXISTS at enqueue time — this is the planned deletion BETWEEN
    // enqueue and admission, not an unknown-id case.
    let live = new Set(["conn-parent", "conn-glm", "conn-ds"]);
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => (live.has(id) ? id : undefined),
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-delqueue", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1); // A holds the single slot, awaiting preparation

    // B parks behind the cap while its target is still LIVE.
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" }));
    await flush();
    expect(preps).toHaveLength(1); // B parked, never resolved yet
    expect(childRunEvents(rootHost).some((e) => e.requestId === "B")).toBe(false);

    // ...now the target is DELETED while B is queued (before admission).
    live = new Set(["conn-parent", "conn-glm"]);

    // Free A's slot -> pump admits B -> resolution now fails on the deleted id.
    preps[0]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({ kind: "accepted" });
    hosts[1]!.emit("message", childTerminalMsg());
    await flush();

    const bEvent = childRunEvents(rootHost).find((e) => e.requestId === "B");
    expect(bEvent).toMatchObject({ kind: "rejected", reason: "not_ready" });
    expect(bEvent).toMatchObject({
      message:
        'Agent: connection "conn-ds" declared by this profile is not available in this host. Fix or remove the profile\'s "connection:" frontmatter.',
    });
    expect(childRunEvents(rootHost).some((e) => e.requestId === "B" && e.kind === "accepted")).toBe(false);
    expect(preps).toHaveLength(1); // B never reached preparation
    expect(hosts).toHaveLength(2); // only the root + A's child; B never forked
  });

  it("MISSING target env after a successful preparation => not_ready, release once, no fork", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseSpy = vi.fn();
    const manager = childManager(fork, window, {
      env: (id) => (id === "conn-glm" ? undefined : { PATH: "/base" }),
      resolveChildConnection: (id) => id,
      prepareChildConnection: async () => ({ ok: true, release: releaseSpy }),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-noenv", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: connection "conn-glm" could not be prepared for this child (deleted or its fork env is unavailable). Retry, or pick another connection.',
    });
    expect(hosts).toHaveLength(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("engine children reject a connection selection (both codex and claude)", async () => {
    for (const engine of ["codex", "claude"] as const) {
      const { fork, hosts } = envRig();
      const { window } = windowRig();
      const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
      const manager = childManager(fork, window, {
        engineReady: () => true,
        engineEnv: (e) => ({ [ENV_ENGINE]: e }),
        resolveChildConnection: (id) => id,
        prepareChildConnection: prepareSpy,
      });
      const root = manager.createTab({ workspace: "/ws", sessionId: `root-engine-${engine}`, resume: false, connectionId: "conn-parent" });
      const rootHost = hosts[0]!;

      rootHost.emit("message", spawnRequest({ requestId: "A", engine, connectionId: "conn-glm" }));
      await flush();

      expect(childRunEvents(rootHost).find((e) => e.requestId === "A"), engine).toMatchObject({
        kind: "rejected",
        reason: "not_ready",
        message:
          "Agent: a connection selection is not valid for an engine child — it runs on its own CLI account, not an AnyCode provider connection.",
      });
      expect(prepareSpy, engine).not.toHaveBeenCalled();
      expect(hosts, engine).toHaveLength(1);
    }
  });

  it("provider + connectionId on one spawn: the wire parser drops it, and a DIRECT caller is refused defensively", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
    const manager = childManager(fork, window, {
      resolveProviderConnection: () => "conn-known",
      resolveChildConnection: (id) => id,
      prepareChildConnection: prepareSpy,
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-conflict", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;
    const rootTab = manager.getTab(root.ok ? root.tab.tabId : "");
    expect(rootTab).toBeDefined();

    // (1) Through the normal message boundary the shared parser drops the pair
    // outright — no event, nothing admitted.
    rootHost.emit("message", spawnRequest({ requestId: "A", provider: "known", connectionId: "conn-glm" }));
    await flush();
    expect(childRunEvents(rootHost)).toHaveLength(0);

    // (2) A DIRECT caller bypassing the parser still hits main's defensive refusal
    // (a prompt not_ready naming the conflict — never a silent parent fallback).
    const direct = manager as unknown as {
      spawnChild: (tab: unknown, sender: unknown, req: ChildSpawnRequest) => void;
    };
    direct.spawnChild(rootTab, rootHost, spawnRequest({ requestId: "D", provider: "known", connectionId: "conn-glm" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "D")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message:
        'Agent: "provider" and "connectionId" are mutually exclusive on one spawn; the profile selects its own connection — omit "provider".',
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(1);
  });

  it("a resume carrying connectionId is refused; a plain resume keeps the child's original pin", async () => {
    const { fork, hosts, envs } = envRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: async () => ({ ok: true, release: () => {} }),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-resume", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "A" && e.kind === "accepted");
    expect(accepted).toMatchObject({ kind: "accepted" });
    const childSessionId = accepted!.kind === "accepted" ? accepted!.childSessionId : "";
    // Finish + reap the child so the follow-up is admissible.
    hosts[1]!.emit("message", childReadyMsg());
    hosts[1]!.emit("message", childTerminalMsg());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A resume MAY NOT re-send routing.
    rootHost.emit("message", spawnRequest({ requestId: "R-override", resumeChildSessionId: childSessionId, connectionId: "conn-ds" }));
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "R-override")).toMatchObject({
      kind: "rejected",
      reason: "not_ready",
      message: "Agent: a continued child keeps its own connection and model; omit provider/model when continuing.",
    });

    // A PLAIN resume forks on the child's ORIGINAL pin (conn-glm), not the parent's.
    rootHost.emit("message", spawnRequest({ requestId: "R-plain", resumeChildSessionId: childSessionId }));
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "R-plain")).toMatchObject({ kind: "accepted" });
    expect(envs[envs.length - 1]!.ANYCODE_CONNECTION_ID).toBe("conn-glm");
  });

  it("an unrouted fresh spawn inherits the parent connection WITHOUT preparation", async () => {
    const { fork, hosts, envs } = envRig();
    const { window } = windowRig();
    const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
    const manager = childManager(fork, window, { prepareChildConnection: prepareSpy });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-inherit", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A" }));
    await flush();

    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({ kind: "accepted" });
    expect(envs[1]!.ANYCODE_CONNECTION_ID).toBe("conn-parent");
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("an explicit route EQUAL to the parent's pin still prepares (selection is explicit, never inferred)", async () => {
    const { fork, hosts, envs } = envRig();
    const { window } = windowRig();
    const prepareSpy = vi.fn(async () => ({ ok: true as const, release: () => {} }));
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: prepareSpy,
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-equal", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-parent" }));
    await flush();

    expect(prepareSpy).toHaveBeenCalledWith("conn-parent");
    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({ kind: "accepted" });
    expect(envs[1]!.ANYCODE_CONNECTION_ID).toBe("conn-parent");
  });

  it("validates the requested model against the SELECTED connection; an incompatible model never forks", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const validateChildModel = vi.fn((model: string) => {
      if (model === "nope") throw new Error("not available on this connection");
    });
    const manager = childManager(fork, window, {
      validateChildModel,
      resolveChildConnection: (id) => id,
      prepareChildConnection: async () => ({ ok: true, release: () => {} }),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-model", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm", model: "nope" }));
    await flush();

    expect(validateChildModel).toHaveBeenCalledWith("nope", "conn-glm");
    expect(childRunEvents(rootHost).find((e) => e.requestId === "A")).toMatchObject({ kind: "rejected", reason: "not_ready" });
    expect(hosts).toHaveLength(1); // no fork
  });

  it("a parent CLOSE during preparation finalizes the starting entry: no late fork, no accepted, pin released", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseSpy = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root1 = manager.createTab({ workspace: "/ws", sessionId: "root-close-1", resume: false, connectionId: "conn-parent" });
    const root2 = manager.createTab({ workspace: "/ws", sessionId: "root-close-2", resume: false, connectionId: "conn-parent" });
    expect(root1.ok && root2.ok).toBe(true);
    const root1Host = hosts[0]!;

    root1Host.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1);

    const hostsBeforeClose = hosts.length;
    await manager.closeTab(root1.ok ? root1.tab.tabId : "");
    expect(hosts).toHaveLength(hostsBeforeClose); // no child fork on close

    preps[0]!.resolve({ ok: true, release: releaseSpy });
    await flush();
    expect(hosts).toHaveLength(hostsBeforeClose); // no LATE fork either
    expect(acceptedOn(root1Host)).toHaveLength(0);
    expect(releaseSpy).toHaveBeenCalledTimes(1); // pin released, not leaked
  });

  it("SHUTDOWN during preparation: pending A is finalized and a QUEUED B is purged — no late fork, no accepted, pins released once", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseA = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-shutdown", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1);
    // B QUEUES behind the pending A (cap=1) — it has a waiter, not a reservation.
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" }));
    await flush();
    expect(preps).toHaveLength(1); // B parked
    expect(childRunEvents(rootHost).some((e) => e.requestId === "B")).toBe(false);
    const hostsBefore = hosts.length;

    await manager.shutdownAllTabHosts();
    // A's preparation SUCCEEDS late; its connection's env is available — so a
    // fork would have happened had the closing custody not intervened.
    preps[0]!.resolve({ ok: true, release: releaseA });
    await flush();

    // Neither the pending A nor the queued B ever forked or got accepted.
    expect(hosts).toHaveLength(hostsBefore);
    expect(acceptedOn(rootHost)).toHaveLength(0);
    expect(preps).toHaveLength(1); // the queued B was purged, never admitted
    expect(releaseA).toHaveBeenCalledTimes(1); // A's pin released exactly once
    // Replies to the now-dead parent host are suppressed (replyChildRunEvent
    // no-ops once its proc is null); the substantive guarantees above hold.
  });

  it("a parent generation change (exit + respawn) during preparation never forks on the dead sender", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseSpy = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-gen", resume: false, connectionId: "conn-parent" });
    const oldHost = hosts[0]!;

    oldHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1);

    oldHost.emit("exit", 0); // drain + respawn: the parent generation is replaced
    await flush();
    const hostsAfterRespawn = hosts.length;

    preps[0]!.resolve({ ok: true, release: releaseSpy });
    await flush();
    expect(hosts).toHaveLength(hostsAfterRespawn); // the dead sender never forks
    expect(acceptedOn(oldHost)).toHaveLength(0);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("preparation failure of A admits an already-queued B without an external completion event (cap=1)", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-pumpfail", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" })); // parked
    expect(preps).toHaveLength(1);

    preps[0]!.resolve({ ok: false }); // A fails -> rollback pumps the queue -> B admitted
    await flush();
    expect(preps).toHaveLength(2); // B reached preparation with no external completion
    preps[1]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });
    // No leaked slot/pin: a THIRD spawn still fits after B finishes.
    hosts[1]!.emit("message", childTerminalMsg());
    await flush();
    rootHost.emit("message", spawnRequest({ requestId: "C", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(3);
  });

  it("preparation REJECTION of A likewise admits an already-queued B (cap=1), no unhandled rejection", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-pumpreject", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", connectionId: "conn-glm" }));
    await flush();
    rootHost.emit("message", spawnRequest({ requestId: "B", connectionId: "conn-ds" })); // parked
    expect(preps).toHaveLength(1);

    // Make A's preparation REJECT -> caught, treated as failure -> rollback pumps B.
    preps[0]!.resolve(Promise.reject(new Error("boom")) as unknown as PrepResult);
    await flush();
    await flush();
    expect(preps).toHaveLength(2); // B admitted with no external completion event
    preps[1]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });
  });

  // §3 item 12: a cancellation during preparation followed by a replacement B
  // must not let A's LATE completion or failure erase B's sibling set, dedup
  // key, or emit a second result. Exercised at cap=1 so B's admission itself
  // proves A's slot was freed, and so a THIRD request can prove B still holds
  // the slot afterwards.
  it("a cancellation during preparation + replacement B: A's LATE FAILURE emits no second result and leaves B's slot/dedup intact", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-cancel-fail", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", spawnToolCallId: "call-A", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(1);

    // Cancel A while its preparation is pending (no tab yet -> the ledger
    // finalize funnel frees A's slot and tombstones its entry).
    rootHost.emit("message", runCancel("A"));
    await flush();
    const aTerminals = childRunEvents(rootHost).filter((e) => e.requestId === "A" && e.kind !== "accepted");
    expect(aTerminals).toHaveLength(1); // A is answered EXACTLY once by the funnel

    // B is admitted (A's slot was freed) and now consumes the single slot.
    rootHost.emit("message", spawnRequest({ requestId: "B", spawnToolCallId: "call-B", connectionId: "conn-ds" }));
    await flush();
    expect(preps).toHaveLength(2);
    preps[1]!.resolve({ ok: true, release: releaseB });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });
    const aEventsAfterB = childRunEvents(rootHost).filter((e) => e.requestId === "A").length;

    // A's preparation finally settles FAILURE — the entry is tombstoned, so this
    // must emit NO second A result and must NOT touch B's reservations.
    preps[0]!.resolve({ ok: false });
    await flush();
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "A")).toHaveLength(aEventsAfterB); // unchanged
    expect(releaseA).not.toHaveBeenCalled(); // failure => the release closure is a no-op

    // B STILL consumes the cap: a third request must stay parked.
    rootHost.emit("message", spawnRequest({ requestId: "C", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(2); // C parked, never reached preparation
    expect(childRunEvents(rootHost).some((e) => e.requestId === "C")).toBe(false);

    // B's dedup key SURVIVED: a duplicate (parentSessionId, spawnToolCallId) is
    // still refused while B runs.
    rootHost.emit("message", spawnRequest({ requestId: "B-dupe", spawnToolCallId: "call-B", connectionId: "conn-ds" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B-dupe")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "B-dupe",
      kind: "rejected",
      reason: "spawn_failed",
      message:
        "Agent: a session-subagent for this Agent tool call is already running. Wait for it to finish before retrying.",
    });

    // B's completion pumps the queued C.
    hosts[hosts.length - 1]!.emit("message", childTerminalMsg());
    await flush();
    expect(preps).toHaveLength(3); // C admitted
    expect(releaseB).toHaveBeenCalledTimes(1); // B's pin released at its terminal
  });

  it("a cancellation during preparation + replacement B: A's LATE SUCCESS releases its pin exactly once and clobbers nothing", async () => {
    const { fork, hosts } = envRig();
    const { window } = windowRig();
    const releaseA = vi.fn();
    const preps: Array<ReturnType<typeof deferred>> = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: () => 1,
      resolveChildConnection: (id) => id,
      prepareChildConnection: () => {
        const d = deferred();
        preps.push(d);
        return d.promise;
      },
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-cancel-success", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "A", spawnToolCallId: "call-A", connectionId: "conn-glm" }));
    await flush();
    rootHost.emit("message", runCancel("A"));
    await flush();
    const aEventCount = childRunEvents(rootHost).filter((e) => e.requestId === "A").length;

    rootHost.emit("message", spawnRequest({ requestId: "B", spawnToolCallId: "call-B", connectionId: "conn-ds" }));
    await flush();
    preps[1]!.resolve({ ok: true, release: () => {} });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "B")).toMatchObject({ kind: "accepted" });

    // A's preparation now resolves SUCCESSFULLY, late. The tombstoned entry must
    // not fork, must not emit a second result, and MUST release the pin it took.
    preps[0]!.resolve({ ok: true, release: releaseA });
    await flush();
    expect(childRunEvents(rootHost).filter((e) => e.requestId === "A")).toHaveLength(aEventCount); // unchanged
    expect(acceptedOn(rootHost).some((e) => e.requestId === "A")).toBe(false); // no late fork
    expect(releaseA).toHaveBeenCalledTimes(1); // pin released exactly once

    // B still consumes the cap.
    rootHost.emit("message", spawnRequest({ requestId: "C", connectionId: "conn-glm" }));
    await flush();
    expect(preps).toHaveLength(2); // C parked
  });

  it("bridge→admission identity chain: paired glm-planner/conn-glm and ds-executor/provider deepseek->conn-ds, SAME parent", async () => {
    const { fork, hosts, envs } = envRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, {
      // The real policy resolves a catalog provider id to a configured connection.
      resolveProviderConnection: (p) => (p === "deepseek" ? "conn-ds" : undefined),
      resolveChildConnection: (id) => id,
      prepareChildConnection: async () => ({ ok: true, release: () => {} }),
    });
    const root = manager.createTab({ workspace: "/ws", sessionId: "root-bridge-chain", resume: false, connectionId: "conn-parent" });
    const rootHost = hosts[0]!;

    // Exactly the fixtures the core-side agent-bridge tests capture (item 9).
    rootHost.emit("message", spawnRequest({ requestId: "glm", agentType: "glm-planner", connectionId: "conn-glm" }));
    rootHost.emit("message", spawnRequest({ requestId: "ds", agentType: "ds-executor", provider: "deepseek" }));
    await flush();

    expect(acceptedOn(rootHost).map((e) => e.requestId).sort()).toEqual(["ds", "glm"]);
    expect(envs[1]!.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    expect(envs[2]!.ANYCODE_CONNECTION_ID).toBe("conn-ds");
  });
});

// ── Taskana 4153 / TASK.216 wire: ChildRunSend — a parent host's follow-up to
// its OWN STILL-RUNNING child, delivered through communicationRequest into the
// existing receiveAgentMessage/agentInbox path. Every test drives main purely
// via host.emit("message", ...) on fake hosts, like the suites above.
describe("TabHostManager — send to a running own child (Taskana 4153)", () => {
  /**
   * One root tab plus ONE still-running core child: spawnRequest accepted
   * (hosts[0] -> hosts[1]), child-ready emitted, NO terminal — the child tab
   * stays state "running" with a live proc, exactly the addressable window
   * send_to exists for.
   */
  function runningChild(sessionId: string) {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { validateChildModel: () => {} });
    expect(manager.createTab({ workspace: "/ws", sessionId, resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "first" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "first" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    hosts[1]!.emit("message", childReadyMsg());
    return { manager, hosts, rootHost, childHost: hosts[1]!, childSessionId };
  }

  /** The communication_request packet posted to a host (if any) for an operation. */
  function commPacket(host: FakeHost, operation: string): { requestId: string; payload: Record<string, unknown> } | undefined {
    return host.postMessage.mock.calls
      .map((call) => call[0] as { type?: string; operation?: string; requestId?: string; payload?: unknown })
      .find((m) => m.type === "communication_request" && m.operation === operation) as
      | { requestId: string; payload: Record<string, unknown> }
      | undefined;
  }

  it("happy path: delivers via communication_request to the CHILD host, sender parent-session:<id>, and acks kind sent on a queued delivery", async () => {
    const { hosts, rootHost, childHost, childSessionId } = runningChild("root-send-happy");
    rootHost.emit("message", runSend("s1", childSessionId, "re-review with these edits"));
    await flush();
    // The packet went to the CHILD host (hosts[1]), not the parent or anyone else.
    const packet = commPacket(childHost, "send_message");
    expect(packet).toBeDefined();
    expect(packet!.payload).toMatchObject({
      sender: "parent-session:root-send-happy",
      recipientSessionId: childSessionId,
      payload: "re-review with these edits",
      mode: "next_turn",
      kind: "agent_message",
    });
    expect(commPacket(rootHost, "send_message")).toBeUndefined();
    void hosts;
    // Child host answers queued -> the parent receives { kind: "sent", requestId }.
    childHost.emit("message", { type: "communication_response", requestId: packet!.requestId, result: { state: "queued", envelope: { messageId: "m1" } } });
    await flush();
    expect(childRunEvents(rootHost).find((e) => e.requestId === "s1")).toMatchObject({ kind: "sent" });
  });

  it("a rejected delivery state (e.g. inbox full) reaches the parent as kind rejected", async () => {
    const { rootHost, childHost, childSessionId } = runningChild("root-send-rejected");
    rootHost.emit("message", runSend("s2", childSessionId));
    await flush();
    const packet = commPacket(childHost, "send_message");
    expect(packet).toBeDefined();
    childHost.emit("message", { type: "communication_response", requestId: packet!.requestId, result: { state: "rejected", detail: "Inbox full" } });
    await flush();
    const event = childRunEvents(rootHost).find((e) => e.requestId === "s2");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("rejected");
  });

  it("another parent's child is refused (not yours) and NO communication_request is posted anywhere", async () => {
    const rig = runningChild("root-send-owner");
    // A second root tab tries to address the first root's child.
    expect(rig.manager.createTab({ workspace: "/ws", sessionId: "root-send-other", resume: false }).ok).toBe(true);
    const otherHost = rig.hosts[2]!;
    otherHost.emit("message", runSend("s3", rig.childSessionId));
    const event = childRunEvents(otherHost).find((e) => e.requestId === "s3");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("cannot be addressed");
    // No delivery was attempted on any host.
    for (const host of rig.hosts) {
      expect(commPacket(host, "send_message")).toBeUndefined();
    }
  });

  it("a finished child is refused (not running)", async () => {
    const { hosts, rootHost, childSessionId } = runningChild("root-send-finished");
    hosts[1]!.emit("message", childTerminalMsg({ finalText: "done early" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rootHost.emit("message", runSend("s4", childSessionId));
    const event = childRunEvents(rootHost).find((e) => e.requestId === "s4");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("not running");
  });

  it("a CHILD tab trying to send is refused (recursion lock #3 symmetry)", async () => {
    const { hosts, childHost, childSessionId } = runningChild("root-send-from-child");
    // The child host itself emits a ChildRunSend addressed to its own session id
    // (or any other): a tab with childOf set can never pass the sender check.
    childHost.emit("message", runSend("s5", childSessionId));
    const event = childRunEvents(childHost).find((e) => e.requestId === "s5");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("cannot be addressed");
    void hosts;
  });

  it("a child still starting (no child-ready yet) is refused and NO communication_request is posted — the follow-up must never run ahead of the child's own task", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { validateChildModel: () => {} });
    expect(manager.createTab({ workspace: "/ws", sessionId: "root-send-starting", resume: false }).ok).toBe(true);
    const rootHost = hosts[0]!;
    rootHost.emit("message", spawnRequest({ requestId: "first" }));
    const accepted = childRunEvents(rootHost).find((e) => e.requestId === "first" && e.kind === "accepted");
    const childSessionId = accepted?.kind === "accepted" ? accepted.childSessionId : "";
    rootHost.emit("message", runSend("s7", childSessionId));
    await flush();
    const event = childRunEvents(rootHost).find((e) => e.requestId === "s7");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("still starting");
    expect(commPacket(hosts[1]!, "send_message")).toBeUndefined();
  });

  it("an unknown childSessionId is refused", async () => {
    const { rootHost } = runningChild("root-send-unknown");
    rootHost.emit("message", runSend("s6", "no-such-child-session"));
    const event = childRunEvents(rootHost).find((e) => e.requestId === "s6");
    expect(event).toMatchObject({ kind: "rejected", reason: "spawn_failed" });
    expect(event?.kind === "rejected" && event.message).toContain("not running");
  });
});

describe("TabHostManager — workspace trust (Taskana 4736)", () => {
  const HASH = "b".repeat(64);

  function rig(extra: { workspaceTrustOnce?: (ws: string) => string | undefined; limits?: object } = {}) {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>((_entry, _args, _opts) => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const { window, posted } = windowRig();
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      engineReady: () => true,
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
      logger: silentLogger,
      now: () => 0,
      limits: (extra.limits ?? {}) as never,
      ...(extra.workspaceTrustOnce !== undefined ? { workspaceTrustOnce: extra.workspaceTrustOnce } : {}),
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "sess-T", resume: false });
    expect(created.ok).toBe(true);
    const tabId = created.ok ? created.tab.tabId : "";
    return { manager, hosts, forkSpy, posted, tabId };
  }

  it("records the host's reported pending hash for its tab and answers the workspace it was forked in", () => {
    const { manager, hosts, tabId } = rig();
    hosts[0]!.emit("message", { type: "workspace_trust_pending", hash: HASH });
    expect(manager.workspaceTrustPendingFor(tabId)).toEqual({ workspace: "/ws", hash: HASH });
  });

  it("ignores a malformed pending hash and a message from a stale host", () => {
    const { manager, hosts, tabId } = rig();
    hosts[0]!.emit("message", { type: "workspace_trust_pending", hash: "not-a-hash" });
    expect(manager.workspaceTrustPendingFor(tabId)).toBe("no_pending");
  });

  it("reports unknown_tab for a missing tab", () => {
    const { manager } = rig();
    expect(manager.workspaceTrustPendingFor("no-such-tab")).toBe("unknown_tab");
  });

  it("restartTabHost re-forks with --resume and does NOT count against the rapid-respawn breaker", async () => {
    // maxRapidRespawns 0: any counted respawn would give up. A deliberate restart must still re-fork.
    const { manager, hosts, forkSpy, tabId } = rig({ limits: { maxRapidRespawns: 0, minHealthyUptimeMs: 1e9 } });
    const restartPromise = manager.restartTabHost(tabId);
    // xfix D3: the shutdown message is posted BEFORE any kill.
    expect(hosts[0]!.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
    expect(hosts[0]!.kill).not.toHaveBeenCalled();
    hosts[0]!.emit("exit", 0);
    await restartPromise;
    await flush();
    expect(forkSpy).toHaveBeenCalledTimes(2);
    expect(forkSpy.mock.calls[1]?.[1]).toEqual(["--resume", "sess-T"]);
    expect(manager.getTab(tabId)?.state).toBe("running");
    expect(manager.getTab(tabId)?.rapidRespawns).toBe(0);
  });

  // Taskana 4736 xfix D3: restartTabHost must use the graceful shutdown
  // handshake (HOST_SHUTDOWN posted, exit awaited with the existing
  // exitDeadlineMs deadline, force-kill only on timeout) — never a bare kill
  // that could orphan the host's own children mid-turn.
  it("restartTabHost force-kills only after the exit deadline expires (xfix D3)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, hosts, tabId } = rig({ limits: { maxRapidRespawns: 0, minHealthyUptimeMs: 1e9, exitDeadlineMs: 1000 } });
      const restartPromise = manager.restartTabHost(tabId);
      expect(hosts[0]!.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
      expect(hosts[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(hosts[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await restartPromise;
      expect(hosts[0]!.kill).toHaveBeenCalledTimes(1);
      // The force-killed host's late exit still re-forks via the deliberate path.
      hosts[0]!.emit("exit", 0);
      await vi.advanceTimersByTimeAsync(50);
      expect(manager.getTab(tabId)?.state).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restartTabHost posts the shutdown message exactly once per restart", async () => {
    const { manager, hosts, tabId } = rig({ limits: { maxRapidRespawns: 0, minHealthyUptimeMs: 1e9 } });
    const restartPromise = manager.restartTabHost(tabId);
    hosts[0]!.emit("exit", 0);
    await restartPromise;
    expect(hosts[0]!.postMessage).toHaveBeenCalledTimes(1);
    expect(hosts[0]!.postMessage).toHaveBeenCalledWith({ type: "shutdown" });
  });

  it("restartTabHost refuses an unknown tab", async () => {
    const { manager } = rig();
    await expect(manager.restartTabHost("nope")).resolves.toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("stamps a main-approved trust-once hash into the fork env for that workspace", () => {
    const { forkSpy } = rig({ workspaceTrustOnce: (ws) => (ws === "/ws" ? HASH : undefined) });
    const env = (forkSpy.mock.calls[0]?.[2] as { env?: Record<string, string> }).env;
    expect(env?.ANYCODE_WORKSPACE_TRUST_ONCE).toBe(HASH);
  });

  // Taskana 4736 xfix D4: the parent's current decision must ride the CHILD's
  // fork too — children share the workspace and cannot answer the question
  // themselves, so the once hash (or the persisted record) is the only way a
  // child of a trusted-once parent boots trusted.
  it("a child spawn in a workspace with an approved once hash inherits it in its fork env (xfix D4)", async () => {
    const { hosts, forkSpy } = rig({ workspaceTrustOnce: (ws) => (ws === "/ws" ? HASH : undefined) });
    // The parent host spawns a child session (the Agent tool's control-plane
    // request; main answers with the same once-approved workspace env).
    hosts[0]!.emit("message", {
      type: "anycode:child-spawn-request",
      requestId: "req-1",
      spawnToolCallId: "call-1",
      agentType: "explore",
      description: "look around",
      prompt: "do the thing",
      permissionMode: "build",
      // engine omitted: absent = core (the wire dictionary only knows claude/codex)
    });
    await flush();
    // The child fork (second fork call) carries the SAME once hash.
    expect(forkSpy).toHaveBeenCalledTimes(2);
    const childEnv = (forkSpy.mock.calls[1]?.[2] as { env?: Record<string, string> }).env;
    expect(childEnv?.ANYCODE_WORKSPACE_TRUST_ONCE).toBe(HASH);
  });

  it("does not stamp a trust-once env when nothing was approved", () => {
    const { forkSpy } = rig();
    const env = (forkSpy.mock.calls[0]?.[2] as { env?: Record<string, string> }).env;
    expect(env?.ANYCODE_WORKSPACE_TRUST_ONCE).toBeUndefined();
  });
});

// Taskana 4752 part A: the session's tools (Bash, hooks, terminal, engines) see
// ANYCODE_SESSION_ID (= the id list_sessions reports) and ANYCODE_SESSION_WORKSPACE,
// stamped per fork so every spawn — first, resume, respawn — carries them.
describe("TabHostManager — session tool env (Taskana 4752, part A)", () => {
  function envRig(baseEnv: NodeJS.ProcessEnv) {
    const envs: NodeJS.ProcessEnv[] = [];
    const hosts: FakeHost[] = [];
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
      env: () => baseEnv,
      logger: silentLogger,
    });
    return { manager, envs, hosts };
  }

  it("A-1: stamps both keys on the first spawn and keeps them on a respawn", () => {
    const { manager, envs, hosts } = envRig({ PATH: "/base" });
    manager.createTab({ workspace: "/ws/one", sessionId: "sess-env-1", resume: false });
    hosts[0]!.emit("exit", 1); // sub-healthy exit -> respawn
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.ANYCODE_SESSION_ID).toBe("sess-env-1");
      expect(env.ANYCODE_SESSION_WORKSPACE).toBe("/ws/one");
    }
  });

  it("A-1: a resumed tab's first spawn carries the stamp too", () => {
    const { manager, envs } = envRig({ PATH: "/base" });
    manager.createTab({ workspace: "/ws/two", sessionId: "sess-env-R", resume: true });
    expect(envs[0]?.ANYCODE_SESSION_ID).toBe("sess-env-R");
    expect(envs[0]?.ANYCODE_SESSION_WORKSPACE).toBe("/ws/two");
  });

  it("A-2: a stale ANYCODE_SESSION_WORKSPACE in the base env is overridden by the tab's workspace", () => {
    const { manager, envs } = envRig({
      PATH: "/base",
      ANYCODE_SESSION_ID: "stale-id",
      ANYCODE_SESSION_WORKSPACE: "/stale/ws",
    });
    manager.createTab({ workspace: "/ws/fresh", sessionId: "sess-env-2", resume: false });
    expect(envs[0]?.ANYCODE_SESSION_ID).toBe("sess-env-2");
    expect(envs[0]?.ANYCODE_SESSION_WORKSPACE).toBe("/ws/fresh");
  });

  it("A-3: the stamped ANYCODE_SESSION_ID equals the sessionId listTabs() reports", () => {
    const { manager, envs } = envRig({ PATH: "/base" });
    manager.createTab({ workspace: "/ws/three", sessionId: "sess-env-3", resume: false });
    const summary = manager.listTabs()[0];
    expect(summary?.sessionId).toBe("sess-env-3");
    expect(envs[0]?.ANYCODE_SESSION_ID).toBe(summary?.sessionId);
  });

  it("does not stamp the launch directive ANYCODE_WORKSPACE into the fork", () => {
    const { manager, envs } = envRig({ PATH: "/base" });
    manager.createTab({ workspace: "/ws/four", sessionId: "sess-env-4", resume: false });
    expect(envs[0] && "ANYCODE_WORKSPACE" in envs[0]).toBe(false);
  });
});

// Taskana 4752 part C: the MCP secret hand-off rides the fork env only when the
// tab's workspace has referenced+set secrets; a respawn reads the latest value.
describe("TabHostManager — MCP secret hand-off env (Taskana 4752, part C)", () => {
  it("passes ANYCODE_MCP_SECRETS from the injected dep on the fork", () => {
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
      mcpSecretsEnv: (workspace) => (workspace === "/ws" ? '{"GH":"ghp_value_1"}' : undefined),
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s-mcp", resume: false });
    expect(envs[0]?.ANYCODE_MCP_SECRETS).toBe('{"GH":"ghp_value_1"}');
  });

  it("does not set ANYCODE_MCP_SECRETS when the dep yields nothing for the workspace", () => {
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
      mcpSecretsEnv: () => undefined,
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s-none", resume: false });
    expect(envs[0] && "ANYCODE_MCP_SECRETS" in envs[0]).toBe(false);
  });

  it("a respawn reads the latest cache value (a secret change reaches the next spawn)", () => {
    const { hosts } = liveForkRig();
    const envs: NodeJS.ProcessEnv[] = [];
    let current = '{"GH":"v1-value"}';
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
      mcpSecretsEnv: () => current,
      logger: silentLogger,
    });
    manager.createTab({ workspace: "/ws", sessionId: "s-respawn", resume: false });
    current = '{"GH":"v2-value"}';
    hosts[0]!.emit("exit", 1);
    expect(envs[0]?.ANYCODE_MCP_SECRETS).toBe('{"GH":"v1-value"}');
    expect(envs[1]?.ANYCODE_MCP_SECRETS).toBe('{"GH":"v2-value"}');
  });
});

// Taskana 4759: "Full browser access" rides the fork env as an explicit "1"/"0" stamp,
// recomputed on every spawn, and a trust question from the host notifies main.
describe("TabHostManager — browser access env stamp (Taskana 4759) — test 49", () => {
  function browserRig(browserFullAccess: (tabId: string) => boolean, onWorkspaceTrustPending?: (tabId: string) => void) {
    const hosts: FakeHost[] = [];
    const forkSpy = vi.fn<HostForkFn>(() => {
      const host = new FakeHost();
      hosts.push(host);
      return host as unknown as UtilityProcess;
    });
    const { window } = windowRig();
    const manager = new TabHostManager({
      fork: forkSpy,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => window,
      env: () => ({}),
      engineReady: () => true,
      engineEnv: (engine) => ({ [ENV_ENGINE]: engine }),
      logger: silentLogger,
      now: () => 0,
      limits: { maxRapidRespawns: 0, minHealthyUptimeMs: 1e9 } as never,
      browserFullAccess,
      ...(onWorkspaceTrustPending !== undefined ? { onWorkspaceTrustPending } : {}),
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "sess-B", resume: false });
    const tabId = created.ok ? created.tab.tabId : "";
    return { manager, hosts, forkSpy, tabId };
  }
  const stampOf = (spy: ReturnType<typeof vi.fn<HostForkFn>>, index: number) =>
    (spy.mock.calls[index]?.[2] as { env?: Record<string, string> } | undefined)?.env?.ANYCODE_BROWSER_FULL_ACCESS;

  it("stamps \"1\" only when the effective switch is on; an off tab gets no stamp", () => {
    expect(stampOf(browserRig(() => true).forkSpy, 0)).toBe("1");
    expect(stampOf(browserRig(() => false).forkSpy, 0)).toBeUndefined();
  });

  it("recomputes the stamp on every respawn", async () => {
    let on = false;
    const { manager, hosts, forkSpy, tabId } = browserRig(() => on);
    on = true;
    const restart = manager.restartTabHost(tabId);
    hosts[0]!.emit("exit", 0);
    await restart;
    expect(forkSpy).toHaveBeenCalledTimes(2);
    expect(stampOf(forkSpy, 0)).toBeUndefined();
    expect(stampOf(forkSpy, 1)).toBe("1");
  });

  it("a host trust question notifies main for that tab (its effective switch just dropped to off)", () => {
    const seen: string[] = [];
    const { hosts, tabId } = browserRig(() => true, (id) => seen.push(id));
    hosts[0]!.emit("message", { type: "workspace_trust_pending", hash: "c".repeat(64) });
    expect(seen).toEqual([tabId]);
  });

  it("main ignores a browser-access message sent FROM the host: no reply and no state change", () => {
    const seen: string[] = [];
    const { hosts } = browserRig(() => false, (id) => seen.push(id));
    hosts[0]!.emit("message", { type: "anycode:browser-access", fullAccess: true });
    expect(hosts[0]!.postMessage).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("A new session on a NON-active connection reaches the spawn with that env", () => {
  // Models main/index.ts: a per-connection env cache that is fail-closed on a miss
  // (hostEnvForConnection) and is filled only by the resume-pin primer.
  function rig() {
    const cache = new Map<string, NodeJS.ProcessEnv>();
    const resolveResumePin = async (meta: { connectionId?: string }) => {
      if (meta.connectionId === "conn-gone") return { ok: false as const, connectionId: "conn-gone" };
      if (meta.connectionId === "conn-boom") throw new Error("vault unreadable");
      cache.set(meta.connectionId!, { PATH: "/base", ANYCODE_API_KEY: "glm-key" });
      return { ok: true as const, connectionId: meta.connectionId, release: vi.fn() };
    };
    const forkEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const hosts: FakeHost[] = [];
    const fork: HostForkFn = (_entry, _args, opts) => {
      forkEnvs.push(opts?.env as NodeJS.ProcessEnv | undefined);
      const host = new FakeHost();
      hosts.push(host);
      queueMicrotask(() => host.emit("spawn"));
      return host as unknown as UtilityProcess;
    };
    const w = windowRig();
    const manager = childManager(fork, w.window, {
      env: (id) => (id === undefined || id === "conn-active" ? { PATH: "/active" } : cache.get(id)),
    });
    return { manager, resolveResumePin, forkEnvs, hostExited: w.hostExited };
  }

  it("primed: the fork receives the non-active connection's env (no crash_looped)", async () => {
    const { primeNewSessionPin } = await import("./session-pin.js");
    const r = rig();
    const pin = await primeNewSessionPin("conn-glm", "conn-active", r.resolveResumePin);
    expect(pin.ok).toBe(true);
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-glm" });
    expect(created.ok).toBe(true);
    await flush();
    expect(r.forkEnvs).toHaveLength(1);
    expect(r.forkEnvs[0]?.ANYCODE_API_KEY).toBe("glm-key");
    expect(r.hostExited).toEqual([]);
  });

  it("regression: WITHOUT priming the same tab is refused (crash_looped) — what 0.0.45 shipped", async () => {
    const r = rig();
    r.manager.createTab({ workspace: "/ws", sessionId: "s1", resume: false, connectionId: "conn-glm" });
    await flush();
    expect(r.forkEnvs).toHaveLength(0);
    expect(r.hostExited).toHaveLength(1);
  });

  it("active connection is primed, no pin skips priming, and failures return a clean refusal", async () => {
    const { primeNewSessionPin } = await import("./session-pin.js");
    const r = rig();
    const spy = vi.fn(r.resolveResumePin);
    expect((await primeNewSessionPin("conn-active", "conn-active", spy)).ok).toBe(true);
    expect((await primeNewSessionPin(undefined, "conn-active", spy)).ok).toBe(true);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ connectionId: "conn-active" });
    expect(await primeNewSessionPin("conn-gone", "conn-active", r.resolveResumePin)).toMatchObject({ ok: false, reason: "connection_missing" });
    // a priming failure carries a safe, actionable reason (the
    // raw error — a vault read, a probe — is classified, never echoed).
    const boom = await primeNewSessionPin("conn-boom", "conn-active", r.resolveResumePin);
    expect(boom).toMatchObject({ ok: false, reason: "not_ready", connectionId: "conn-boom" });
    if (boom.ok) throw new Error("expected a refusal");
    expect(boom.detail).toContain("could not prepare connection conn-boom");
    expect(boom.detail).not.toContain("vault unreadable");
  });
});

describe("deferred host spawns during a settings refresh", () => {
  it.each(["initial create", "crash respawn", "restart", "worktree move", "reconnect"] as const)("resumes %s after refresh", async (kind) => {
    const rig = shutdownableForkRig();
    let blocked = kind === "initial create";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const manager = childManager(rig.fork, windowRig().window, {
      env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "session", resume: false, connectionId: "old" });
    if (!created.ok) throw new Error("create failed");
    let reconnect: Promise<unknown> | undefined;
    if (kind !== "initial create") {
      const host = rig.hosts[0]!;
      if (kind === "reconnect") {
        const post = host.postMessage.getMockImplementation()!;
        host.postMessage.mockImplementation((message: unknown) => { blocked = true; return post(message); });
        reconnect = manager.rebindTab(created.tab, "new");
        await vi.waitFor(() => expect(created.tab.proc).toBeNull());
      } else {
        blocked = true;
        if (kind === "crash respawn") host.emit("exit", 1);
        if (kind === "restart") await manager.restartTabHost(created.tab.tabId);
        if (kind === "worktree move") {
          host.emit("message", { type: WORKTREE_TRANSITION_MESSAGE_TYPE, sessionId: "session", fromWorkspace: "/ws", toWorkspace: "/ws/wt", projectRoot: "/ws", worktree: { id: "wt", path: "/ws/wt", branch: "feature", baseRef: "main", ownedByAnyCode: true } });
          await vi.waitFor(() => expect(created.tab.workspace).toBe("/ws/wt"));
        }
      }
    }
    const count = rig.hosts.length;
    expect(created.tab.proc).toBeNull();
    blocked = false;
    release();
    await reconnect;
    await vi.waitFor(() => expect(rig.hosts).toHaveLength(count + 1));
    expect(created.tab.state).toBe("running");
    expect(created.tab.proc).not.toBeNull();
  });

  it.each(["rejects", "resolves"] as const)("ignores a superseded deferred rebind when its refresh %s", async (outcome) => {
    const rig = shutdownableForkRig();
    const { window, hostExited } = windowRig();
    let blocked = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const recordHostFailure = vi.fn();
    const manager = childManager(rig.fork, window, {
      env: () => blocked ? undefined : {},
      waitForHostEnv: () => blocked ? pending : undefined,
      recordHostFailure,
    });
    const created = manager.createTab({ workspace: "/ws", sessionId: "superseded", connectionId: "old", resume: false });
    if (!created.ok) throw new Error("create failed");
    const post = rig.hosts[0]!.postMessage.getMockImplementation()!;
    rig.hosts[0]!.postMessage.mockImplementation((message: unknown) => { blocked = true; return post(message); });
    expect(await manager.rebindTab(created.tab, "first")).toEqual({ ok: true });
    expect(created.tab.proc).toBeNull();
    blocked = false;
    expect(await manager.rebindTab(created.tab, "second")).toEqual({ ok: true });
    const liveHost = created.tab.proc;
    expect(rig.hosts).toHaveLength(2);
    hostExited.length = 0;
    recordHostFailure.mockClear();
    if (outcome === "rejects") reject(new Error("old refresh failed"));
    else resolve();
    await flush();
    expect(created.tab.state).toBe("running");
    expect(created.tab.proc).toBe(liveHost);
    expect(rig.hosts).toHaveLength(2);
    expect(hostExited).toEqual([]);
    expect(recordHostFailure).not.toHaveBeenCalled();
  });

  it("does not resume a deferred spawn after close", async () => {
    const rig = shutdownableForkRig();
    let blocked = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const manager = childManager(rig.fork, windowRig().window, { env: () => blocked ? undefined : {}, waitForHostEnv: () => blocked ? pending : undefined });
    manager.createTab({ workspace: "/ws", sessionId: "control", resume: false });
    blocked = true;
    const created = manager.createTab({ workspace: "/ws", sessionId: "deferred", resume: false });
    if (!created.ok) throw new Error("create failed");
    await manager.closeTab(created.tab.tabId);
    blocked = false;
    release();
    await flush();
    expect(rig.hosts).toHaveLength(1);
    expect(manager.getTab(created.tab.tabId)).toBeUndefined();
  });
});

it("does not rehost a worktree move racing a real close", async () => {
  const rig = liveForkRig();
  const manager = childManager(rig.fork, windowRig().window);
  manager.createTab({ workspace: "/ws", sessionId: "control", resume: false });
  const created = manager.createTab({ workspace: "/ws", sessionId: "moving", resume: false });
  if (!created.ok) throw new Error("create failed");
  const host = rig.hosts[1]!;
  host.emit("message", { type: WORKTREE_TRANSITION_MESSAGE_TYPE, sessionId: "moving", fromWorkspace: "/ws", toWorkspace: "/ws/wt", projectRoot: "/ws", worktree: { id: "wt", path: "/ws/wt", branch: "feature", baseRef: "main", ownedByAnyCode: true } });
  await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalled());
  const closing = manager.closeTab(created.tab.tabId);
  await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledTimes(2));
  host.emit("exit", 0);
  await closing;
  await flush();
  expect(manager.getTab(created.tab.tabId)).toBeUndefined();
  expect(rig.hosts).toHaveLength(2);
});

it("starts a child after a paused settings refresh", async () => {
  const rig = shutdownableForkRig();
  let blocked = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const manager = childManager(rig.fork, windowRig().window, { env: () => blocked ? undefined : {}, waitForHostEnv: () => blocked ? pending : undefined });
  manager.createTab({ workspace: "/ws", sessionId: "parent", resume: false });
  blocked = true;
  const host = rig.hosts[0]!;
  host.emit("message", spawnRequest({ requestId: "deferred-child" }));
  expect(rig.hosts).toHaveLength(1);
  expect(childRunEvents(host).find((event) => event.requestId === "deferred-child")).toBeUndefined();
  blocked = false;
  release();
  await vi.waitFor(() => expect(rig.hosts).toHaveLength(2));
  expect(childRunEvents(host)).toContainEqual(expect.objectContaining({ requestId: "deferred-child", kind: "accepted" }));
});


it("refuses overlapping rebinds during refresh and persists the live connection", async () => {
  const rig = shutdownableForkRig();
  let blocked = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const manager = childManager((entry, args, opts) => { envs.push(opts.env); return rig.fork(entry, args, opts); }, windowRig().window, {
    env: () => blocked ? undefined : {}, waitForHostEnv: () => blocked ? pending : undefined,
  });
  const created = manager.createTab({ workspace: "/ws", sessionId: "rebind-race", connectionId: "old", resume: false });
  if (!created.ok) throw new Error("create failed");
  const post = rig.hosts[0]!.postMessage.getMockImplementation()!;
  rig.hosts[0]!.postMessage.mockImplementation((message: unknown) => { blocked = true; return post(message); });
  const touchSession = vi.fn(async () => {});
  const deps = { manager, connectionExists: () => true, persistence: { touchSession } } as unknown as TabIpcDeps;
  const firstPending = handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "new" });
  const secondPending = handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "other" });
  expect(await secondPending).toEqual({ ok: false, reason: "not_ready" });
  expect(await firstPending).toEqual({ ok: true, connectionId: "new" });
  expect(await handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "other" })).toEqual({ ok: false, reason: "not_ready" });
  blocked = false;
  release();
  await vi.waitFor(() => expect(rig.hosts).toHaveLength(2));
  expect(envs[1]?.ANYCODE_CONNECTION_ID).toBe("new");
  expect(touchSession).toHaveBeenCalledOnce();
  expect(touchSession).toHaveBeenCalledWith("rebind-race", { connectionId: "new" });
});

it("keeps the imported model after a deferred failure and applies it on retry", async () => {
  const rig = liveForkRig();
  let blocked = true;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const manager = childManager((entry, args, opts) => {
    if (fail) throw new Error("fork failed");
    envs.push(opts.env);
    return rig.fork(entry, args, opts);
  }, windowRig().window, { env: () => blocked ? undefined : {}, waitForHostEnv: () => blocked ? pending : undefined });
  const models = new Map([["imported", "chosen-model"]]);
  const deps = {
    manager, dialog: {}, persistence: { getRootSession: async () => ({ id: "imported", workspace: "/ws", model: "old", mode: "build", createdAt: 1, updatedAt: 1 }) },
    peekPendingImportModel: (id: string) => models.get(id),
    consumePendingImportModel: (id: string) => { const model = models.get(id); models.delete(id); return model; },
  } as unknown as TabIpcDeps;
  const first = await handleCreate(deps, { kind: "resume", sessionId: "imported" });
  expect(first.ok).toBe(true);
  expect(models.get("imported")).toBe("chosen-model");
  blocked = false;
  release();
  await vi.waitFor(() => expect(manager.sessionOpenInTab("imported")).toBeUndefined());
  expect(models.get("imported")).toBe("chosen-model");
  fail = false;
  const retry = await handleCreate(deps, { kind: "resume", sessionId: "imported" });
  expect(retry.ok).toBe(true);
  expect(envs[0]?.ANYCODE_MODEL).toBe("chosen-model");
  expect(models.has("imported")).toBe(false);
});

it.each([false, true])("holds the rebind guard during preparation and releases it after failure=%s", async (fail) => {
  const rig = shutdownableForkRig();
  const manager = childManager(rig.fork, windowRig().window, { env: () => ({}) });
  const created = manager.createTab({ workspace: "/ws", sessionId: "prepare-race", connectionId: "old", resume: false });
  if (!created.ok) throw new Error("create failed");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const ensureConnectionEnv = vi.fn(async () => {
    if (ensureConnectionEnv.mock.calls.length === 1) {
      await pending;
      if (fail) throw new Error("preparation failed");
    }
  });
  const deps = { manager, connectionExists: () => true, ensureConnectionEnv, persistence: { touchSession: vi.fn(async () => {}) } } as unknown as TabIpcDeps;
  const first = handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "new" });
  expect(await handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "other" })).toEqual({ ok: false, reason: "not_ready" });
  expect(ensureConnectionEnv).toHaveBeenCalledTimes(1);
  expect(rig.hosts).toHaveLength(1);
  release();
  expect(await first).toEqual(fail ? { ok: false, reason: "not_ready" } : { ok: true, connectionId: "new" });
  expect(rig.hosts).toHaveLength(fail ? 1 : 2);
  expect(await handleTabRebind(deps, { tabId: created.tab.tabId, connectionId: "other" })).toEqual({ ok: true, connectionId: "other" });
  expect(rig.hosts).toHaveLength(fail ? 2 : 3);
});

it("drops a deferred imported model when rebind supersedes the initial start", async () => {
  const rig = shutdownableForkRig();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let blocked = true;
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const manager = childManager((entry, args, opts) => { envs.push(opts.env); return rig.fork(entry, args, opts); }, windowRig().window, {
    env: (id) => id === "old" && blocked ? undefined : { ANYCODE_MODEL: "connection-model" },
    waitForHostEnv: (id) => id === "old" && blocked ? pending : undefined,
  });
  const models = new Map([["imported-rebind", "import-model"]]);
  const deps = {
    manager, dialog: {}, connectionExists: () => true,
    resolveResumePin: async () => ({ ok: true, connectionId: blocked ? "old" : "new" }),
    persistence: { getRootSession: async () => ({ id: "imported-rebind", workspace: "/ws", connectionId: "old", model: "connection-model", mode: "build", createdAt: 1, updatedAt: 1 }), touchSession: async () => {} },
    peekPendingImportModel: (id: string) => models.get(id),
    consumePendingImportModel: (id: string) => { const model = models.get(id); models.delete(id); return model; },
  } as unknown as TabIpcDeps;
  const created = await handleCreate(deps, { kind: "resume", sessionId: "imported-rebind" });
  if (!created.ok) throw new Error("create failed");
  const tabId = created.tabId;
  expect(models.has("imported-rebind")).toBe(true);
  expect(await handleTabRebind(deps, { tabId, connectionId: "new" })).toEqual({ ok: true, connectionId: "new" });
  expect(models.has("imported-rebind")).toBe(false);
  blocked = false;
  release();
  await flush();
  expect(rig.hosts).toHaveLength(1);
  manager.createTab({ workspace: "/ws", sessionId: "control", resume: false });
  expect(await manager.closeTab(tabId)).toEqual({ ok: true });
  expect((await handleCreate(deps, { kind: "resume", sessionId: "imported-rebind" })).ok).toBe(true);
  expect(envs[2]?.ANYCODE_MODEL).toBe("connection-model");
});

describe("TabHostManager — GitHub #17 slice A accepted acknowledgement", () => {
  function rawAccepted(host: FakeHost, requestId: string): unknown {
    const raw = host.postMessage.mock.calls.map((c) => c[0] as { type?: unknown; requestId?: unknown; kind?: unknown });
    return raw.find(
      (m) => m.type === CHILD_RUN_EVENT_TYPE && m.requestId === requestId && m.kind === "accepted",
    );
  }

  it("a forked child's accepted event survives the real parser with ANYCODE_MAX_TURNS=300, and a stamped request budget outranks the env", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window, { env: () => ({ PATH: "/base", [ENV_MAX_TURNS]: "300" }) });
    manager.createTab({ workspace: "/ws", sessionId: "root-mt300", resume: false });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "mt-300" }));
    expect(parseChildRunEvent(rawAccepted(rootHost, "mt-300"))).toMatchObject({ kind: "accepted", maxTurns: 300 });

    // Stamped request budget (17) keeps its request > env precedence and is
    // carried verbatim, not replaced by the env's 300.
    rootHost.emit("message", spawnRequest({ requestId: "mt-17", maxTurns: 17 }));
    expect(parseChildRunEvent(rawAccepted(rootHost, "mt-17"))).toMatchObject({ kind: "accepted", maxTurns: 17 });
  });

  it("absent, malformed, zero and negative ANYCODE_MAX_TURNS are omitted from accepted (never invalidate the acknowledgement)", () => {
    for (const envMax of [undefined, "", "0", "-5", "abc", "2.5"]) {
      const { fork, hosts } = shutdownableForkRig();
      const { window } = windowRig();
      const env = envMax === undefined ? { PATH: "/base" } : { PATH: "/base", [ENV_MAX_TURNS]: envMax };
      const manager = childManager(fork, window, { env: () => env });
      manager.createTab({ workspace: "/ws", sessionId: `root-mt-${envMax ?? "undef"}`, resume: false });
      const rootHost = hosts[0]!;
      rootHost.emit("message", spawnRequest({ requestId: "mt-invalid" }));
      const parsed = parseChildRunEvent(rawAccepted(rootHost, "mt-invalid"));
      expect(parsed).toMatchObject({ kind: "accepted" });
      expect((parsed as { maxTurns?: number } | null)?.maxTurns).toBeUndefined();
    }
  });

  it("child channel delivery failure does not suppress accepted — exactly one accepted, no rejection, and the start deadline still reaps", () => {
    vi.useFakeTimers();
    try {
      const hosts: FakeHost[] = [];
      const fork: HostForkFn = () => {
        const host = new FakeHost();
        hosts.push(host);
        queueMicrotask(() => host.emit("spawn"));
        host.postMessage.mockImplementation((msg: unknown) => {
          // The SECOND fork is the child: its host-channel delivery throws,
          // which must not prevent the already-posted accepted acknowledgement.
          if (hosts.length === 2 && (msg as { type?: unknown }).type === "anycode:init") {
            throw new Error("child renderer-port delivery boom");
          }
          if ((msg as { type?: unknown }).type === "shutdown") {
            queueMicrotask(() => host.emit("exit", 0));
          }
        });
        return host as unknown as UtilityProcess;
      };
      const { window } = windowRig();
      const manager = childManager(fork, window);
      manager.createTab({ workspace: "/ws", sessionId: "root-chan", resume: false });
      const rootHost = hosts[0]!;

      rootHost.emit("message", spawnRequest({ requestId: "chan-1" }));
      const events = childRunEvents(rootHost);
      expect(events.filter((e) => e.kind === "accepted")).toHaveLength(1);
      expect(events.find((e) => e.requestId === "chan-1")).toMatchObject({ kind: "accepted" });
      expect(events.some((e) => e.kind === "rejected")).toBe(false);
      expect(hosts).toHaveLength(2); // fork already happened before delivery
      expect(manager.listChildRuns()).toHaveLength(1);

      vi.advanceTimersByTime(CHILD_START_DEADLINE_MS);
      expect(childRunEvents(rootHost).find((e) => e.requestId === "chan-1" && e.kind === "terminal")).toMatchObject({
        status: "error",
      });
      expect(manager.listChildRuns()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * GitHub #17 slice B: a DETACHED spawn above the per-parent or
 * global cap is refused IMMEDIATELY. A parked detached request sends no
 * `accepted` until capacity frees, and the parent's step awaits every tool
 * call — so parking a detached request is exactly the sync-join the detach
 * flag exists to avoid. Explicitly synchronous callers keep the FIFO queue.
 */
describe("TabHostManager — detached spawns are refused at the cap, never parked (GitHub #17 slice B)", () => {
  it("four detached same-step requests accept three and reject the fourth without queueing", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    manager.createTab({ workspace: "/ws", sessionId: "root-detach-burst", resume: false });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "d1", detach: true }));
    rootHost.emit("message", spawnRequest({ requestId: "d2", detach: true }));
    rootHost.emit("message", spawnRequest({ requestId: "d3", detach: true }));
    rootHost.emit("message", spawnRequest({ requestId: "d4", detach: true, spawnToolCallId: "d4-call" }));

    const events = childRunEvents(rootHost);
    expect(events.filter((e) => e.kind === "accepted").map((e) => e.requestId)).toEqual(["d1", "d2", "d3"]);
    // The 4th is ANSWERED — a refusal, not silence.
    expect(events.find((e) => e.requestId === "d4")).toEqual({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "d4",
      kind: "rejected",
      reason: "limit_parent",
      message:
        'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".',
    });
    // Nothing was queued, nothing was reserved, nothing forked.
    const raw = manager as unknown as { childSpawnQueue: string[]; childSpawnKeys: Map<string, string> };
    expect(raw.childSpawnQueue).toEqual([]);
    expect(raw.childSpawnKeys.has(["root-detach-burst", "d4-call"].join(String.fromCharCode(0)))).toBe(false);
    expect(hosts).toHaveLength(1 + 3);
    expect(events.filter((e) => e.requestId === "d4" && e.kind === "terminal")).toHaveLength(0);
  });

  it("a detached SYNCHRONOUS sibling occupying the last slot makes the next detached spawn refuse immediately", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    manager.createTab({ workspace: "/ws", sessionId: "root-mixed", resume: false });
    const rootHost = hosts[0]!;

    // Two synchronous children fill 2 of 3 slots; one more sync child fills the cap.
    rootHost.emit("message", spawnRequest({ requestId: "s1", detach: false }));
    rootHost.emit("message", spawnRequest({ requestId: "s2" }));
    rootHost.emit("message", spawnRequest({ requestId: "s3" }));
    expect(childRunEvents(rootHost).filter((e) => e.kind === "accepted")).toHaveLength(3);

    // A sync spawn would park here (the existing queue behavior)...
    rootHost.emit("message", spawnRequest({ requestId: "s4", spawnToolCallId: "s4-call" }));
    expect(childRunEvents(rootHost).some((e) => e.requestId === "s4")).toBe(false);
    const raw = manager as unknown as { childSpawnQueue: string[] };
    expect(raw.childSpawnQueue).toEqual(["s4"]);

    // ...but a DETACHED one must be refused at once, so its step can finish.
    rootHost.emit("message", spawnRequest({ requestId: "d-over", detach: true, spawnToolCallId: "d-over-call" }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "d-over")).toMatchObject({
      kind: "rejected",
      reason: "limit_parent",
    });
    expect(raw.childSpawnQueue).toEqual(["s4"]);
  });

  it("a detached global overflow rejects immediately while another parent owns the slots", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const manager = childManager(fork, window);
    for (const sid of ["root-gA", "root-gB", "root-gC", "root-gD"]) {
      expect(manager.createTab({ workspace: "/ws", sessionId: sid, resume: false }).ok).toBe(true);
    }
    const [hostA, hostB, hostC, hostD] = [hosts[0]!, hosts[1]!, hosts[2]!, hosts[3]!];
    const perParentCounts = [3, 3, 2]; // sums to the global cap of 8

    for (let p = 0; p < 3; p++) {
      for (let n = 0; n < perParentCounts[p]!; n++) {
        [hostA, hostB, hostC][p]!.emit("message", spawnRequest({ requestId: `g${p}-${n}` }));
      }
    }
    expect(childRunEvents(hostC).filter((e) => e.kind === "accepted")).toHaveLength(2);

    hostD.emit("message", spawnRequest({ requestId: "d-global", detach: true, spawnToolCallId: "d-global-call" }));
    const refused = childRunEvents(hostD).find((e) => e.requestId === "d-global");
    expect(refused).toMatchObject({ kind: "rejected", reason: "limit_global" });
    const raw = manager as unknown as { childSpawnQueue: string[]; childSpawnKeys: Map<string, string> };
    expect(raw.childSpawnQueue).toEqual([]);
    expect(raw.childSpawnKeys.has(["root-gD", "d-global-call"].join(String.fromCharCode(0)))).toBe(false);
    expect(hosts).toHaveLength(4 + 8);
  });

  it("the live per-parent resolver uses the OWNING workspace", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const seen: string[] = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: (workspace) => {
        seen.push(workspace);
        return workspace === "/proj-narrow" ? 1 : 3;
      },
    });
    expect(manager.createTab({ workspace: "/proj-narrow", sessionId: "root-narrow", resume: false }).ok).toBe(true);
    expect(manager.createTab({ workspace: "/proj-wide", sessionId: "root-wide", resume: false }).ok).toBe(true);
    const [narrowHost, wideHost] = [hosts[0]!, hosts[1]!];

    narrowHost.emit("message", spawnRequest({ requestId: "n1", detach: true }));
    narrowHost.emit("message", spawnRequest({ requestId: "n2", detach: true }));
    expect(childRunEvents(narrowHost).find((e) => e.requestId === "n2")).toMatchObject({
      kind: "rejected",
      reason: "limit_parent",
    });

    wideHost.emit("message", spawnRequest({ requestId: "w1", detach: true }));
    wideHost.emit("message", spawnRequest({ requestId: "w2", detach: true }));
    expect(childRunEvents(wideHost).filter((e) => e.kind === "accepted")).toHaveLength(2);
    // The reader was consulted with each parent's OWN workspace, never a
    // process-wide workspace or a workspace-less default.
    expect(seen).toContain("/proj-narrow");
    expect(seen).toContain("/proj-wide");
  });

  it("uses the stable project root for a worktree session's role cap", () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    const seen: string[] = [];
    const manager = childManager(fork, window, {
      childRunsPerParentMax: (projectRoot) => {
        seen.push(projectRoot);
        return projectRoot === "/project" ? 1 : 3;
      },
    });
    manager.createTab({ workspace: "/project/.worktrees/one", projectRoot: "/project", sessionId: "worktree-root", resume: false });
    const host = hosts[0]!;
    host.emit("message", spawnRequest({ requestId: "one", detach: false }));
    host.emit("message", spawnRequest({ requestId: "two", detach: true }));
    expect(childRunEvents(host).find((event) => event.requestId === "two")).toMatchObject({ kind: "rejected", reason: "limit_parent" });
    expect(seen).toEqual(["/project", "/project"]);
  });

  it("lowering the live per-parent cap does not cancel admitted children", async () => {
    const { fork, hosts } = shutdownableForkRig();
    const { window } = windowRig();
    let cap = 3;
    const manager = childManager(fork, window, { childRunsPerParentMax: () => cap });
    manager.createTab({ workspace: "/ws", sessionId: "root-lower", resume: false });
    const rootHost = hosts[0]!;

    rootHost.emit("message", spawnRequest({ requestId: "l1", detach: true }));
    rootHost.emit("message", spawnRequest({ requestId: "l2", detach: true }));
    const accepted = childRunEvents(rootHost).filter((e) => e.kind === "accepted");
    expect(accepted).toHaveLength(2);
    const childTabIds = accepted.map((e) => (e.kind === "accepted" ? e.childTabId : ""));

    cap = 1;
    rootHost.emit("message", spawnRequest({ requestId: "l3", detach: true }));
    expect(childRunEvents(rootHost).find((e) => e.requestId === "l3")).toMatchObject({
      kind: "rejected",
      reason: "limit_parent",
    });
    // The two admitted children still run: no cancel, no terminal, still listed.
    await flush();
    const events = childRunEvents(rootHost);
    expect(events.some((e) => e.kind === "terminal")).toBe(false);
    for (const childTabId of childTabIds) expect(manager.getTab(childTabId)).toBeDefined();
  });
});


describe("GitHub #6 — a missing workspace folder fails fast instead of connecting forever", () => {
  it("a NEW session refuses with folder_not_found, rolls the tab back and leaves no binding", () => {
    const rig = liveForkRig();
    const win = windowRig();
    const opened = vi.fn();
    const registered = vi.fn();
    const manager = new TabHostManager({
      fork: rig.fork,
      hostEntry: "/fake",
      createChannel: fakeChannel,
      getWindow: () => win.window,
      env: () => ({}),
      logger: silentLogger,
      onTabOpened: opened,
      onSessionRegistered: registered,
      workspaceMissing,
    });
    const workspace = join(tmpdir(), `anycode-missing-${randomUUID()}`);
    const result = manager.createTab({ workspace, sessionId: "missing-new", resume: false });

    // The regression: without the folder check this fake fork runs and the
    // caller sees a success it can queue a first prompt into — a host that can
    // never boot, so the prompt (and the start screen's draft) is lost.
    expect(rig.hosts).toHaveLength(0);
    expect(result).toEqual({ ok: false, reason: "folder_not_found", workspace });
    // Rolled back: no tab, no session->tab binding, nothing opened/registered,
    // and nothing handed to the renderer.
    expect(manager.listTabs()).toHaveLength(0);
    expect(manager.sessionOpenInTab("missing-new")).toBeUndefined();
    expect(opened).not.toHaveBeenCalled();
    expect(registered).not.toHaveBeenCalled();
    expect(win.posted).toHaveLength(0);
  });

  it("a RESUME keeps the error tab and delivers the error on create and on reload", () => {
    const rig = liveForkRig();
    const win = windowRig();
    const manager = new TabHostManager({
      fork: rig.fork,
      hostEntry: "/fake",
      createChannel: fakeChannel,
      getWindow: () => win.window,
      env: () => ({}),
      logger: silentLogger,
      workspaceMissing,
    });
    const workspace = join(tmpdir(), `anycode-missing-${randomUUID()}`);
    const result = manager.createTab({ workspace, sessionId: "missing", resume: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rig.hosts).toHaveLength(0);
    expect(result.tab.state).toBe("crash_looped");
    manager.deliverTabPort(result.tab);
    manager.deliverAllTabPorts();
    expect(win.posted).toHaveLength(2);
    for (const posted of win.posted) {
      expect(posted.channel).toBe(PORT_ENVELOPE_TYPE);
      expect(posted.payload).toMatchObject({ tabId: result.tab.tabId, workspace, missingWorkspace: true });
    }
  });

  it("a folder deleted under a live tab makes the respawn refuse to fork and deliver the error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "anycode-ws-"));
    const rig = liveForkRig();
    const win = windowRig();
    const manager = new TabHostManager({
      fork: rig.fork,
      hostEntry: "/fake",
      createChannel: fakeChannel,
      getWindow: () => win.window,
      env: () => ({}),
      logger: silentLogger,
      workspaceMissing,
    });
    const created = manager.createTab({ workspace, sessionId: "vanished", resume: false });
    if (!created.ok) throw new Error("create failed");
    expect(rig.hosts).toHaveLength(1);
    await rm(workspace, { recursive: true, force: true });
    rig.hosts[0]!.emit("exit", 1);
    expect(manager.getTab(created.tab.tabId)?.state).toBe("crash_looped");
    expect(manager.getTab(created.tab.tabId)?.proc).toBeNull();
    expect(rig.hosts).toHaveLength(1);
    const delivered = win.posted.filter((posted) => posted.channel === PORT_ENVELOPE_TYPE);
    expect(delivered.at(-1)?.payload).toMatchObject({ tabId: created.tab.tabId, missingWorkspace: true });
  });

  it("the probe only calls a vanished or non-directory path missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-probe-"));
    try {
      expect(workspaceMissing(dir)).toBe(false);
      await writeFile(join(dir, "file"), "");
      expect(workspaceMissing(join(dir, "file"))).toBe(true);
      expect(workspaceMissing(join(dir, "file", "nested"))).toBe(true);
      await rm(dir, { recursive: true, force: true });
      expect(workspaceMissing(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Prepared (unpublished) tabs — the window a created session's effort is
// configured in. A prepared tab is a fully forked host that is NOT yet part of
// the application surface: it holds capacity and its binding, is invisible to
// the public API, gets no renderer port, and runs none of the publication
// hooks until main publishes it (or aborts it).
describe("TabHostManager — prepared (unpublished) tabs", () => {
  function preparedRig(limits: { maxTabs?: number; exitDeadlineMs?: number } = {}) {
    const rig = liveForkRig();
    const win = windowRig();
    const opened: string[] = [];
    const registered: string[] = [];
    const manager = new TabHostManager({
      fork: rig.fork,
      hostEntry: "/fake/host.js",
      createChannel: fakeChannel,
      getWindow: () => win.window,
      env: () => ({}),
      logger: silentLogger,
      limits: { maxTabs: 1, ...limits },
      onTabOpened: (tabId) => opened.push(tabId),
      onSessionRegistered: ({ sessionId }) => { registered.push(sessionId); },
    });
    return { manager, hosts: rig.hosts, opened, registered, win };
  }

  it("prepared tabs reserve capacity without becoming public", async () => {
    const r = preparedRig();
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-prepared", resume: false, deferPublication: true });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("prepared creation refused");

    // Invisible publicly, but the slot and the session binding are held.
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.manager.atCapacity()).toBe(true);
    expect(r.manager.count()).toBe(1);
    expect(r.manager.sessionOpenInTab("s-prepared")).toBe(created.tab.tabId);
    // No publication side effect of any kind: no hooks, no renderer port.
    expect(r.opened).toEqual([]);
    expect(r.registered).toEqual([]);
    expect(r.win.posted).toEqual([]);

    // The INTERNAL control plane still reaches this host.
    const pending = r.manager.communicationRequest("s-prepared", "get_session_status", undefined, "/ws");
    await flush();
    const host = r.hosts[0]!;
    const request = host.postMessage.mock.calls
      .map((call) => call[0] as { type?: string; requestId?: string })
      .find((message) => message.type === "communication_request");
    expect(request).toBeDefined();
    host.emit("message", { type: "communication_response", requestId: request!.requestId, result: { state: "idle" } });
    await expect(pending).resolves.toEqual({ state: "idle" });
  });

  it("publishes a prepared tab exactly once", async () => {
    const r = preparedRig();
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-publish", resume: false, deferPublication: true });
    if (!created.ok) throw new Error("prepared creation refused");

    expect(r.manager.publishPreparedTab(created.tab.tabId)).toBe(true);
    // Now public, and the normal creation hooks ran — once each.
    expect(r.manager.listTabs().map((tab) => tab.sessionId)).toEqual(["s-publish"]);
    expect(r.opened).toEqual([created.tab.tabId]);
    expect(r.registered).toEqual(["s-publish"]);

    // A second publication is a no-op: the hooks must never run twice.
    expect(r.manager.publishPreparedTab(created.tab.tabId)).toBe(false);
    expect(r.opened).toEqual([created.tab.tabId]);
    expect(r.registered).toEqual(["s-publish"]);
  });

  it("aborts an unpublished last tab and reaps its host", async () => {
    const r = preparedRig();
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-abort", resume: false, deferPublication: true });
    if (!created.ok) throw new Error("prepared creation refused");
    const host = r.hosts[0]!;
    // A real host exits when it is told to shut down.
    host.postMessage.mockImplementation((message: unknown) => {
      if ((message as { type?: string }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
    });

    // The public close path would refuse the last tab; abort must not.
    await r.manager.abortPreparedTab(created.tab.tabId);

    expect(r.manager.getTab(created.tab.tabId)).toBeUndefined();
    expect(r.manager.sessionOpenInTab("s-abort")).toBeUndefined();
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.manager.atCapacity()).toBe(false);
    // The host was told to shut down and nothing was respawned.
    expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "shutdown" }));
    expect(r.hosts).toHaveLength(1);
    // Nothing was published on the way out either.
    expect(r.opened).toEqual([]);
    expect(r.registered).toEqual([]);
    expect(r.win.posted).toEqual([]);
  });

  it("stays hidden and un-respawned for the whole teardown, even if the host exits mid-teardown", async () => {
    const r = preparedRig();
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-sealed", resume: false, deferPublication: true });
    if (!created.ok) throw new Error("prepared creation refused");
    const host = r.hosts[0]!;

    const abort = r.manager.abortPreparedTab(created.tab.tabId);
    // Sealed synchronously, before the first await: the tab is still hidden
    // from the public API while its host is being drained.
    expect(r.manager.listTabs()).toEqual([]);
    // The host dies here — BEFORE the shutdown is even delivered, while the
    // teardown is still running. It is not a crash: no respawn may be forked.
    host.emit("exit", 1);
    await abort;

    expect(r.hosts).toHaveLength(1);
    expect(r.manager.getTab(created.tab.tabId)).toBeUndefined();
    // A deliberate teardown is never recorded as a host failure.
    expect(r.manager.listTabs()).toEqual([]);
  });

  it("keeps a prepared tab tracked, and its cleanup deferred, when the host outlives both reap deadlines", async () => {
    // A hung host: the shutdown deadline passes, the force kill does NOT land
    // it either. Releasing the tab (and thereby letting the caller delete the
    // session row) here would leave a live server free to write it back.
    const r = preparedRig({ exitDeadlineMs: 40 });
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-hung", resume: false, deferPublication: true });
    if (!created.ok) throw new Error("prepared creation refused");
    const host = r.hosts[0]!;
    host.kill.mockImplementation(() => true);
    const cleaned: string[] = [];

    const aborted = await r.manager.abortPreparedTab(created.tab.tabId, () => { cleaned.push("row"); });
    // Both deadlines are behind us and the abort itself is settled...
    expect(aborted).toBe(false);
    expect(host.kill).toHaveBeenCalled();
    // ...but the host may still be alive: the tab holds its slot and binding,
    // stays hidden, was never respawned, and its cleanup has NOT run.
    expect(r.manager.getTab(created.tab.tabId)).toBeDefined();
    expect(r.manager.sessionOpenInTab("s-hung")).toBe(created.tab.tabId);
    expect(r.manager.atCapacity()).toBe(true);
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.hosts).toHaveLength(1);
    expect(cleaned).toEqual([]);

    // The real exit is what releases everything — exactly once, no respawn.
    host.emit("exit", 0);
    await flush();
    expect(r.manager.getTab(created.tab.tabId)).toBeUndefined();
    expect(r.manager.sessionOpenInTab("s-hung")).toBeUndefined();
    expect(r.manager.atCapacity()).toBe(false);
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.hosts).toHaveLength(1);
    expect(cleaned).toEqual(["row"]);
    // A pending exit that never arrives must not leak a second cleanup on a
    // later, unrelated teardown either.
    expect(r.opened).toEqual([]);
    expect(r.registered).toEqual([]);
  });

  it("waits for the host's real exit before the abort reports itself finished", async () => {
    // Short reap deadline so the force-kill path (the one that used to return
    // without waiting) is reached quickly.
    const r = preparedRig({ exitDeadlineMs: 60 });
    const created = r.manager.createTab({ workspace: "/ws", sessionId: "s-wait", resume: false, deferPublication: true });
    if (!created.ok) throw new Error("prepared creation refused");
    const host = r.hosts[0]!;

    let finished = false;
    const abort = r.manager.abortPreparedTab(created.tab.tabId).then(() => { finished = true; });
    // Past the shutdown deadline: the host has been force-killed but has not
    // confirmed its exit yet. The caller deletes the session row right after
    // this resolves, so it must NOT resolve here.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(finished).toBe(false);
    expect(host.kill).toHaveBeenCalled();

    host.emit("exit", 0);
    await abort;
    expect(finished).toBe(true);
    expect(r.hosts).toHaveLength(1);
  });
});
