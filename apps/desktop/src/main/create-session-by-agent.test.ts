import * as childCleanup from "./child-worktree-cleanup.js";
import { createSessionPeerOpener } from "./session-peer-open.js";
import type { ChildWorktreeReceipt } from "./child-worktree-resource.js";
import type { TabHostManagerDeps } from "./tabs.js";
/**
 * the previous regression test called
 * `primeNewSessionPin` ITSELF and then `createTab`, so reverting the
 * `create_session` wiring left every test green while the reported defect —
 * a non-active connection tab dying as `crash_looped` — came back. These tests
 * drive the PRODUCTION function `main/index.ts` calls (`createSessionForAgent`
 * from ./create-session-by-agent.ts) against a REAL `TabHostManager` whose
 * per-connection env cache is fail-closed on a miss, exactly like main's
 * `hostEnvForConnection`. The assertion is the FORK env: what actually reaches
 * the host process, not an intermediate helper's return value.
 *
 * Two connections: the
 * active one and a non-active "GLM" one that only works when its env is primed
 * before `createTab`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionAccessStore } from "./communication-sessions.js";
import { createAgentProjectsStore } from "./communication-agent-projects.js";
import { handleSetSessionHandle, type CommunicationIpcDeps } from "./communication-ipc.js";
import { createAgentTitlePushes, createAgentTitleRecoveryDeps, recoverAgentSessionTitleOnRegister } from "./agent-session-title.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { Client, StreamableHTTPClientTransport } from "@anycode/core/communication-mcp";
import { startCommunicationServer } from "./communication-server.js";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { AGENT_MESSAGE_HEADER_PREFIX } from "../shared/communication.js";
import { createSessionPeerAccess } from "./session-peer-access.js";
import { forgetClosedAgentOpeners } from "./communication-creation-admission.js";
import { createSessionForAgent, type CreateSessionByAgentDeps } from "./create-session-by-agent.js";
import { offerEmptyFolderTrust } from "./workspace-trust-ipc.js";
import { resolveSkillsProfileHome } from "./dev-profile.js";
import { readTrustStore, defaultTrustStorePath } from "@anycode/core/workspace-trust";
import { primeNewSessionPin, type ResumePinResult } from "./session-pin.js";
import { TabHostManager, type HostForkFn, type WindowLike } from "./tabs.js";
import type { SessionAccessStore } from "./communication-sessions.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";

class FakeHost extends EventEmitter {
  readonly pid = 4242;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

const fakeChannel = () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain });
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

/** Two connections: DeepSeek is active, GLM coding plan is the non-active pin. */
function settings(): AnycodeSettings {
  return {
    version: 2,
    provider: {
      connections: [
        { id: "conn-active", providerId: "custom", model: "deepseek-flash", authOptional: true },
        { id: "conn-glm", providerId: "custom", model: "glm-5.3", authOptional: true },
        { id: "conn-gone", providerId: "custom", model: "gone-model", authOptional: true },
      ],
      activeConnectionId: "conn-active",
    },
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

/** A scripted answer to one internal control-plane request from the fake host. */
interface HostReply {
  result?: unknown;
  error?: string;
  delayMs?: number;
  /** Hold the answer until the test releases it (`deferredReplies[i].answer(...)`). */
  defer?: boolean;
}

interface DeferredReply {
  operation: string;
  payload: unknown;
  answer(result: unknown): void;
  fail(error: string): void;
}

function rig(options: {
  managerDeps?: Partial<TabHostManagerDeps>;
  failPrimingFor?: string;
  blocked?: () => boolean;
  pending?: Promise<void>;
  pendingFactory?: () => Promise<void>;
  workspaceMissing?: (workspace: string) => boolean;
  window?: boolean;
  failFork?: boolean;
  failAfterRoot?: boolean;
  sessions?: SessionAccessStore;
  /** The session id `create_session` assigns (deterministic when a row is pre-seeded). */
  sessionId?: string;
  onTabClosed?: () => void;
  /**
   * Replaces the registration callback main uses. The title test needs main's
   * REAL callback (store registration + resume-time recovery), so it passes one
   * here instead of re-implementing the manager wiring in the test body.
   */
  onSessionRegistered?: (info: { sessionId: string; parentSessionId?: string }) => void | (() => void);
  /**
   * Answers the created host's internal control-plane requests. Every
   * `communication_request` postMessage is answered on a microtask (or later,
   * when the reply is deferred), which is exactly how a real host behaves.
   */
  respond?: (operation: string, payload: unknown) => HostReply | undefined;
  /** Ordered breadcrumbs from the lifecycle the test cares about (registration, shutdown). */
  sequence?: string[];
  /** Reap deadline for the manager (tests shorten it to reach the force-kill branch). */
  limits?: { exitDeadlineMs?: number };
  /**
   * A host that does NOT exit on the shutdown message: only `kill()` lands it,
   * `killExitDelayMs` later. Models a hung host the reaper has to force-kill.
   */
  stubbornHost?: boolean;
  killExitDelayMs?: number;
  /** Even the force kill does not land the host: only the test's own `host.emit("exit")` does. */
  holdKillExit?: boolean;
} = {}) {
  // Mirrors main/index.ts: `hostEnvByConnection`, filled ONLY by ensurePinnedEnv
  // (through resolveResumePin) and read fail-closed by the fork's `env`.
  const cache = new Map<string, NodeJS.ProcessEnv>();
  const forkEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  /** Every fork's argv — the wire a tab really boots with (account/profile flags included). */
  const forkArgs: string[][] = [];
  const forkCwds: string[] = [];
  const hosts: FakeHost[] = [];
  /** Every internal control-plane operation the created hosts received, in order. */
  const operations: string[] = [];
  /** Answers waiting for the test to release them (deferred replies only). */
  const deferredReplies: DeferredReply[] = [];
  const fork: HostForkFn = (_entry, args, opts) => {
    if (options.failFork || (options.failAfterRoot && forkCwds.length > 0)) throw new Error("fork failed");
    forkEnvs.push(opts?.env as NodeJS.ProcessEnv | undefined);
    forkArgs.push([...args]);
    forkCwds.push(opts.cwd);
    const host = new FakeHost();
    hosts.push(host);
    host.postMessage.mockImplementation((message: unknown) => {
      const data = message as { type?: string; requestId?: string; operation?: string; payload?: unknown };
      if (data?.type === "shutdown") {
        options.sequence?.push("host-shutdown");
        if (options.stubbornHost !== true) {
          // A real host exits promptly on shutdown; the fake must too, or the
          // reap would sit on the breaker deadline.
          queueMicrotask(() => host.emit("exit", 0));
        }
        return;
      }
      if (data?.type !== "communication_request" || data.requestId === undefined) return;
      const operation = data.operation ?? "";
      operations.push(operation);
      const reply = options.respond?.(operation, data.payload);
      if (reply === undefined) return;
      const answer = (result: unknown) => host.emit("message", { type: "communication_response", requestId: data.requestId, result });
      const fail = (error: string) => host.emit("message", { type: "communication_response", requestId: data.requestId, error });
      if (reply.defer === true) {
        deferredReplies.push({ operation, payload: data.payload, answer, fail });
        return;
      }
      const deliver = () => (reply.error !== undefined ? fail(reply.error) : answer(reply.result));
      if (reply.delayMs !== undefined) setTimeout(deliver, reply.delayMs);
      else queueMicrotask(deliver);
    });
    queueMicrotask(() => host.emit("spawn"));
    host.once("exit", () => options.sequence?.push("host-exit"));
    if (options.stubbornHost === true) {
      // The only thing that lands this host is the reaper's force kill.
      host.kill.mockImplementation(() => {
        if (options.holdKillExit !== true) setTimeout(() => host.emit("exit", 0), options.killExitDelayMs ?? 0);
        return true;
      });
    }
    return host as unknown as UtilityProcess;
  };
  const resolveResumePin = async (meta: { connectionId?: string }): Promise<ResumePinResult> => {
    const id = meta.connectionId;
    if (id === undefined) return { ok: true, release: () => {} };
    if (id === options.failPrimingFor) throw new Error("vault read failed: sk-poison-password");
    if (id === "conn-gone") return { ok: false, connectionId: id };
    cache.set(id, { PATH: "/base", ANYCODE_API_KEY: `${id}-key` });
    return { ok: true, connectionId: id, release: vi.fn() };
  };
  // The attribution registries main wires into the manager (main/index.ts) —
  // shared with the deps bag below, so the port envelope a deferred fork
  // delivers is built from the very state the hook writes.
  const agentOpenedSessions = new Set<string>();
  const agentSessionTitles = new Map<string, string>();
  /** Every `webContents.postMessage` the delivered port envelopes go through. */
  const posted: Array<{ channel: string; payload: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      postMessage: (channel: string, payload: unknown) => posted.push({ channel, payload }),
      send: () => {},
    },
  };
  const manager = new TabHostManager({
    fork,
    onTabClosed: options.onTabClosed,
    onSessionRegistered: options.onSessionRegistered ?? (({ sessionId }) => {
      options.sequence?.push("registered");
      const added = options.sessions?.register({ sessionId });
      return () => { if (added) options.sessions?.remove(sessionId); };
    }),
    waitForHostEnv: () => options.blocked?.() ? (options.pendingFactory?.() ?? options.pending) : undefined,
    hostEntry: "/fake/host.js",
    createChannel: fakeChannel,
    // Only the envelope assertions need a window; the rest keep the historical
    // no-window rig (deliveries are no-ops there).
    getWindow: () => (options.window === true ? (window as unknown as WindowLike) : null),
    isAgentOpenedSession: (sessionId) => agentOpenedSessions.has(sessionId),
    agentTitleOf: (sessionId) => agentSessionTitles.get(sessionId),
    // fail-closed: an unprimed non-active pin refuses the fork.
    env: (connectionId) =>
      options.blocked?.() ? undefined : connectionId === undefined || connectionId === "conn-active" ? { PATH: "/active" } : cache.get(connectionId),
    engineEnv: (engine) => ({ ANYCODE_ENGINE: engine }),
    engineReady: () => true,
    ...(options.workspaceMissing !== undefined ? { workspaceMissing: options.workspaceMissing } : {}),
    logger: silentLogger,
    limits: { ...(options.limits ?? {}) },
    ...options.managerDeps,
  });
  const exposed = new Map<string, boolean>();
  const sessions: SessionAccessStore = options.sessions ?? {
    isExposed: (id) => exposed.get(id) === true,
    register: () => {},
    remove: () => {},
    set: (id, enabled) => (exposed.set(id, enabled), true),
    exposedCount: () => exposed.size,
    getHandle: () => undefined,
    setHandle: () => ({ ok: true }),
    sessionIdByHandle: () => undefined,
    getConfirmedTitle: () => undefined,
    confirmTitle: () => undefined,
  };
  const deps = (overrides: Partial<CreateSessionByAgentDeps> = {}): CreateSessionByAgentDeps => ({
    projects: { isAllowed: () => true },
    manager: () => manager,
    sessions: () => sessions,
    realpathSync: (path) => path,
    readTrustStore: async () => ({
      version: 1,
      folders: { "/ws": { decision: "trusted", hash: "h", decidedAt: "2026-10-26T00:00:00.000Z" } },
    }),
    mcpSecretPrime: async () => {},
    currentSettings: settings,
    primeNewSessionPin,
    resolveResumePin,
    randomUUID: () => options.sessionId ?? `sess-${forkEnvs.length}`,
    agentOpenedSessions,
    agentSessionTitles,
    listTabs: () => manager.listTabs(),
    ...overrides,
  });
  return { manager, deps, forkEnvs, forkArgs, forkCwds, sessions, exposed, posted, agentOpenedSessions, agentSessionTitles, hosts, operations, deferredReplies };
}

describe("create_session — the production creation path primes a non-active connection before the fork", () => {
  it("opens an empty folder after the owner trusts it", async () => {
    const files = new Map<string, string>();
    const fs = {
      exists: async (p: string) => files.has(p),
      readFile: async (p: string) => { const value = files.get(p); if (value === undefined) throw new Error("missing"); return value; },
      writeFile: async (p: string, value: string) => { files.set(p, value); },
      rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      stat: async (p: string) => ({ size: 0, mtimeMs: 0, isFile: p !== "/ws", isDirectory: p === "/ws" }),
      mkdir: async () => {}, readdir: async () => [],
    };
    const r = rig();
    const profile = resolveSkillsProfileHome({ ANYCODE_AUTOMATION: "1", ANYCODE_SKILLS_IMPORT_HOME: "/home/skills", ANYCODE_SUBAGENTS_HOME: "/home/agents" }, false)!;
    const deps = r.deps({ readTrustStore: () => readTrustStore(fs, defaultTrustStorePath(profile)) });
    expect(await createSessionForAgent({ workspace: "/ws" }, deps)).toEqual({ ok: false, reason: "not_trusted" });
    await offerEmptyFolderTrust(fs, fs, "/ws", profile, (p) => p, async () => true);
    expect((await readTrustStore(fs, defaultTrustStorePath("/home/agents"))).folders["/ws"]).toBeUndefined();
    expect((await createSessionForAgent({ workspace: "/ws" }, deps)).ok).toBe(true);
  });
  it("a core `model` naming the NON-active GLM connection forks with THAT connection's env", async () => {
    const r = rig();
    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "core", model: "glm-5.3" }, r.deps());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`create_session refused: ${JSON.stringify(outcome)}`);
    // The tab is RUNNING on the GLM connection, not crash_looped on the active one.
    const tab = r.manager.listTabs().find((entry) => entry.sessionId === outcome.sessionId);
    expect(tab?.state).toBe("running");
    expect(r.forkEnvs).toHaveLength(1);
    expect(r.forkEnvs[0]?.ANYCODE_API_KEY).toBe("conn-glm-key");
    expect(r.forkEnvs[0]?.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    // Shown immediately + owned by the agent (close_session may reach it).
    expect(r.exposed.get(outcome.sessionId)).toBe(true);
  });

  it("a priming failure is a clean refusal carrying a safe reason — never a crashed tab", async () => {
    const r = rig({ failPrimingFor: "conn-glm" });
    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "core", model: "glm-5.3" }, r.deps());
    expect(outcome).toMatchObject({ ok: false, reason: "not_ready" });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.detail).toContain("could not prepare connection conn-glm");
    // The raw vault error never rides the response…
    expect(outcome.detail).not.toMatch(/poison|password|vault read failed/);
    // …and no half-created tab is left behind (the fork never ran).
    expect(r.forkEnvs).toHaveLength(0);
    expect(r.manager.listTabs()).toHaveLength(0);
  });

  it("retains the accepted handle as the tab title and never fails the session on a broken push", async () => {
    const r = rig();
    const titles = new Map<string, string>();
    const pushed: string[] = [];
    const deps = r.deps({
      agentSessionTitles: titles,
      // The host is not ready to take the title (or the retainer itself is
      // wired to something broken): create_session must still succeed.
      pushAgentTitle: (sessionId) => { pushed.push(sessionId); throw new Error("host unavailable"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await createSessionForAgent({ workspace: "/ws", handle: "worker-1" }, deps);
      expect(outcome).toMatchObject({ ok: true, handle: "worker-1" });
      if (!outcome.ok) throw new Error("create refused");
      // The sidebar title is set for the tab's lifetime…
      expect(titles.get(outcome.sessionId)).toBe("worker-1");
      // …and the push was attempted (main retains it for the next host generation).
      expect(pushed).toEqual([outcome.sessionId]);
    } finally {
      warn.mockRestore();
    }
  });

  it("the no-model path keeps using the ACTIVE connection (no priming, no pin)", async () => {
    const r = rig();
    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "core" }, r.deps());
    expect(outcome.ok).toBe(true);
    expect(r.forkEnvs[0]?.ANYCODE_API_KEY).toBeUndefined();
    expect(r.forkEnvs[0]?.PATH).toBe("/active");
  });

  it("a folder that disappears during the async preparation refuses folder_not_found, not a session (GitHub #6)", async () => {
    // The server realpath'd the workspace, then the folder vanished while the
    // trust/secrets/pin preparation was still awaiting — the exact window the
    // API used to answer with a dead but "successful" session.
    let gone = false;
    const r = rig({ workspaceMissing: () => gone });
    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "core" }, r.deps({
      mcpSecretPrime: async () => {
        gone = true;
      },
    }));
    expect(outcome).toEqual({ ok: false, reason: "folder_not_found" });
    // No fork, no tab, no session registration/handle — nothing to roll forward.
    expect(r.forkEnvs).toHaveLength(0);
    expect(r.manager.listTabs()).toHaveLength(0);
    expect(r.exposed.size).toBe(0);
  });

  it("a folder that disappears while the first fork is parked in a provider refresh refuses folder_not_found and registers nothing (GitHub #6)", async () => {
    // The deferred half of the same window: the folder exists when createTab
    // starts, the first fork is parked in `waitForHostEnv`, and the folder is
    // gone by the time the refresh releases. Reporting success there answered
    // the API with a session that had no host and spent a creation slot.
    const dir = mkdtempSync(join(tmpdir(), "anycode-deferred-refusal-"));
    try {
      const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
      let blocked = true;
      let gone = false;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const r = rig({
        sessions,
        blocked: () => blocked,
        // The folder is still there when createTab checks it; it disappears while
        // the first fork waits for the provider refresh.
        pendingFactory: () => { gone = true; return pending; },
        workspaceMissing: () => gone,
      });
      const deps = r.deps();
      const creation = createSessionForAgent({ workspace: "/ws" }, deps);
      await vi.waitFor(() => expect(gone).toBe(true));
      // The refresh then lands with the folder already gone.
      blocked = false;
      release();
      expect(await creation).toEqual({ ok: false, reason: "folder_not_found" });
      // Nothing forked, nothing registered, no agent-owned session left behind.
      expect(r.forkEnvs).toHaveLength(0);
      expect(r.manager.listTabs()).toHaveLength(0);
      expect(deps.agentOpenedSessions.size).toBe(0);
      expect(sessions.set("sess-0", true)).toBe(false);
      expect(sessions.getHandle("sess-0")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe("deferred agent session registration", () => {
  it.each([false, true])("pushes the recorded title before first port delivery (deferred=%s)", async (deferred) => {
    let blocked = deferred;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const r = rig({ blocked: () => blocked, pending, window: true });
    const observations: Array<{ sessionId: string; title: string | undefined; deliveries: number }> = [];
    const creation = createSessionForAgent({ workspace: "/ws", handle: "worker-1" }, r.deps({
      pushAgentTitle: (sessionId) => observations.push({
        sessionId,
        title: r.agentSessionTitles.get(sessionId),
        deliveries: r.posted.length,
      }),
    }));
    if (deferred) {
      await vi.waitFor(() => expect(r.manager.listTabs()).toHaveLength(1));
      expect(observations).toEqual([]);
      blocked = false;
      release();
    }
    const outcome = await creation;
    if (!outcome.ok) throw new Error("create refused");
    expect(observations).toEqual([{ sessionId: outcome.sessionId, title: "worker-1", deliveries: 0 }]);
    expect(r.posted.some((entry) => entry.channel === PORT_ENVELOPE_TYPE)).toBe(true);
  });

  it("answers only once the deferred first fork ran, then shares the session and keeps its handle (GitHub #6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-access-test-"));
    try {
      const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
      let blocked = true;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const r = rig({ sessions, blocked: () => blocked, pending });
      let answered = false;
      const creation = createSessionForAgent({ workspace: "/ws", handle: "agent-one" }, r.deps())
        .then((outcome) => { answered = true; return outcome; });
      // NB: create_session must NOT answer while the first fork is still parked.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(answered).toBe(false);
      expect(r.forkEnvs).toHaveLength(0);
      expect(r.manager.listTabs().every((tab) => tab.pid === null)).toBe(true);
      blocked = false;
      release();
      const outcome = await creation;
      if (!outcome.ok) throw new Error("create refused");
      expect(r.forkEnvs).toHaveLength(1);
      expect(sessions.isExposed(outcome.sessionId)).toBe(true);
      expect(sessions.getHandle(outcome.sessionId)).toBe("agent-one");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a deferred first fork's FIRST envelope already carries the agent attribution and handle title (GitHub #6)", async () => {
    // A deferred fork delivers its port from its own completion — strictly
    // before `createTabAwaitingInitialSpawn` reports. Attribution registered
    // only after that await misses the first envelope: no agent badge, and the
    // sidebar shows the auto title instead of the requested handle.
    const dir = mkdtempSync(join(tmpdir(), "anycode-deferred-attribution-"));
    try {
      const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
      let blocked = true;
      const deferrals: Array<() => void> = [];
      const r = rig({
        sessions,
        blocked: () => blocked,
        pendingFactory: () => new Promise<void>((resolve) => { deferrals.push(resolve); }),
        window: true,
      });
      const creation = createSessionForAgent({ workspace: "/ws", handle: "agent-two" }, r.deps());
      await vi.waitFor(() => expect(deferrals).toHaveLength(1));
      // Still parked: nothing has been delivered to the renderer yet.
      expect(r.posted).toHaveLength(0);
      blocked = false;
      deferrals[0]!();
      const outcome = await creation;
      if (!outcome.ok) throw new Error("create refused");
      expect(outcome.handle).toBe("agent-two");
      const envelope = r.posted.find((entry) => entry.channel === PORT_ENVELOPE_TYPE);
      expect(envelope?.payload).toMatchObject({ tabId: outcome.tabId, workspace: "/ws", openedByAgent: true, agentTitle: "agent-two" });
      expect(sessions.getHandle(outcome.sessionId)).toBe("agent-two");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a deferred first fork that cannot run refuses not_ready and registers nothing (GitHub #6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-access-test-"));
    try {
      const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
      let blocked = true;
      const deferrals: Array<() => void> = [];
      const r = rig({
        sessions,
        blocked: () => blocked,
        pendingFactory: () => new Promise<void>((resolve) => { deferrals.push(resolve); }),
        failFork: true,
      });
      const creation = createSessionForAgent({ workspace: "/ws", handle: "agent-one" }, r.deps());
      await vi.waitFor(() => expect(deferrals).toHaveLength(1));
      blocked = false;
      deferrals[0]!();
      const outcome = await creation;
      expect(outcome).toEqual({ ok: false, reason: "not_ready" });
      expect(r.manager.listTabs()).toHaveLength(0);
      // Nothing to share, no handle reserved, no agent-owned session left behind.
      expect(sessions.set("sess-0", true)).toBe(false);
      expect(sessions.getHandle("sess-0")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Sessions API create_session — the deferred first fork (GitHub #6)", () => {
  it("a folder lost during the deferred fork is folder_not_found and spends none of the per-minute creation budget", async () => {
    // Driven through the REAL server + the real creation hook + a real
    // TabHostManager: five refusals must leave the 5/min window empty, so the
    // sixth attempt (folder back) is a normal success, not `rate_limited`.
    const dir = mkdtempSync(join(tmpdir(), "anycode-deferred-api-"));
    try {
      // The server realpath-checks the folder, so it must really exist.
      const workspace = mkdtempSync(join(dir, "ws-"));
      const resolved = realpathSync(workspace);
      let blocked = false;
      let gone = false;
      const deferrals: Array<() => void> = [];
      const r = rig({
        blocked: () => blocked,
        pendingFactory: () => new Promise<void>((resolve) => { deferrals.push(resolve); }),
        workspaceMissing: () => gone,
      });
      const deps = r.deps({
        readTrustStore: async () => ({
          version: 1,
          folders: { [resolved]: { decision: "trusted" as const, hash: "h", decidedAt: "2026-10-26T00:00:00.000Z" } },
        }),
      });
      const discoveryFile = join(dir, "communication.json");
      const service = await startCommunicationServer({
        manager: { listTabs: () => r.manager.listTabs(), communicationRequest: async () => ({ engine: "core", state: "idle" }) },
        userData: dir,
        config: { workspaces: [], discoveryFile },
        creatorOwnsAdmission: true,
        createSessionByAgent: (request) => createSessionForAgent(request, deps),
        readyTimeoutMs: 50,
        readyPollMs: 5,
      });
      const client = new Client({ name: "deferred-create", version: "1" });
      const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
      await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
      try {
        const errorText = (result: unknown) => (result as { isError?: boolean; content: Array<{ text: string }> }).content[0]!.text;
        for (let attempt = 0; attempt < 5; attempt++) {
          blocked = true;
          gone = false;
          const call = client.callTool({ name: "create_session", arguments: { workspace: resolved } });
          await vi.waitFor(() => expect(deferrals).toHaveLength(attempt + 1));
          // The folder disappears while the provider refresh is still pending.
          gone = true;
          blocked = false;
          deferrals[attempt]!();
          expect(errorText(await call)).toMatch(/^create_session folder_not_found:/);
        }
        // The window is still empty: the sixth creation is NOT rate_limited.
        gone = false;
        blocked = false;
        const created = await client.callTool({ name: "create_session", arguments: { workspace: resolved } });
        expect(created.isError ?? false).toBe(false);
        expect(r.manager.listTabs()).toHaveLength(1);
        expect(r.forkEnvs).toHaveLength(1);
      } finally {
        await client.close();
        await service.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * The resume wiring, driven end to end: a session created by the production
 * `create_session` path (agent-opened, with a handle), its row holding the
 * host's OWN automatic title, the handle renamed through the production IPC
 * handler, then a restart and a resume.
 *
 * Both boots build the repair dependencies with `createAgentTitleRecoveryDeps`
 * — the one factory `main/index.ts` uses — and register through
 * `recoverAgentSessionTitleOnRegister`, main's own `onSessionRegistered` title
 * step, instead of re-shaping either by hand here: a regression in main's
 * wiring of the store, the row reader or the adopted title is a regression in
 * this test too.
 *
 * Why the row's title is an automatic one and not the handle: the handle push
 * never landed (a booting host). The previous repair overwrote ANY non-handle
 * title of a session whose handle was saved, so this resume replaced the
 * host's automatic title with the handle the user had since renamed — the
 * defect this pins down.
 */
describe("agent title resume wiring (production create_session → handle rename → resume)", () => {
  /** What an automatic titling pass leaves in the row (never the delivery header). */
  const AUTOMATIC_TITLE = "Sidebar layout and focus";
  /** A pre-fix row's payload-derived title: the envelope header, capped. */
  const ENVELOPE_TITLE = `${AGENT_MESSAGE_HEADER_PREFIX}{"messageId":"m1","sender":"supervisor"`.slice(0, 80);

  /** Lets a fire-and-forget title push settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * One boot cycle: creation + rename happen on the first boot, the resume on
   * the second, over the SAME access/handles/confirmation files and the SAME
   * SQLite database — the durability the resume path depends on.
   */
  async function scenario(storedTitle: string) {
    const dir = mkdtempSync(join(tmpdir(), "anycode-title-resume-"));
    const dbPath = join(dir, "sessions.db");
    const storeFiles = {
      file: join(dir, "access.json"),
      handlesFile: join(dir, "handles.json"),
      titleConfirmationsFile: join(dir, "agent-titles.json"),
      defaultOn: () => false,
    };
    let persistence = new SqlitePersistenceAdapter(dbPath);
    let sessions = createSessionAccessStore(storeFiles);
    try {
      await persistence.createSession({ id: "sess-1", workspace: "/ws", model: "scripted-model", mode: "edit" });

      // ---- boot 1: create_session, then a handle rename ----
      /** This boot's store and row reader, as main's thunks read them. */
      const sessionsA = sessions;
      const persistenceA = persistence;
      const titlesA = new Map<string, string>();
      const pushedA: string[] = [];
      const pushesA = createAgentTitlePushes({
        titleOf: (sessionId) => titlesA.get(sessionId),
        // The host is still booting: the handle never lands, so the row keeps
        // whatever the host's own automatic titling wrote.
        request: async (_sessionId, title) => { pushedA.push(title); throw new Error("host booting"); },
        confirmed: (sessionId, title) => sessionsA.confirmTitle(sessionId, title),
        warn: () => {},
      });
      const createdRecoveries: Promise<unknown>[] = [];
      const boot1 = rig({
        sessions: sessionsA,
        sessionId: "sess-1",
        onSessionRegistered: (info) => {
          sessionsA.register(info);
          createdRecoveries.push(
            recoverAgentSessionTitleOnRegister(
              createAgentTitleRecoveryDeps({
                sessions: () => sessionsA,
                persistence: () => persistenceA,
                titles: titlesA,
                pushes: pushesA,
                warn: () => {},
              }),
              info,
            ),
          );
        },
      });
      const created = await createSessionForAgent(
        { workspace: "/ws", handle: "worker-1" },
        boot1.deps({ agentSessionTitles: titlesA, pushAgentTitle: (sessionId) => pushesA.retain(sessionId) }),
      );
      if (!created.ok) throw new Error(`create_session refused: ${JSON.stringify(created)}`);
      await Promise.all(createdRecoveries);
      expect(created).toMatchObject({ sessionId: "sess-1", handle: "worker-1" });
      expect(pushedA).toContain("worker-1");

      // The host's automatic title is what the row holds.
      await persistence.touchSession("sess-1", { title: storedTitle });

      // The user renames the handle through the production IPC handler.
      const status = { state: "off" as const, workspaces: 0, sessions: 0 };
      const ipc: CommunicationIpcDeps = {
        settingsPath: join(dir, "settings.json"),
        logger: silentLogger,
        controller: {
          apply: async () => status,
          regenerateToken: async () => ({ ok: false as const, reason: "not_running" as const }),
          status: () => status,
          discoveryFile: () => undefined,
        },
        sessions,
        approvals: createSessionAccessStore({ file: join(dir, "approvals.json"), defaultOn: () => false }),
        tabs: () => [{ tabId: created.tabId, sessionId: "sess-1" }],
        env: () => undefined,
        pickFolder: async () => undefined,
        stdioScriptPath: () => null,
        realpath: async (path) => path,
        agentProjects: createAgentProjectsStore({ file: join(dir, "projects.json"), realpathSync: (path) => path }),
        offerEmptyFolderTrust: async (folder) => ({ folder }),
        realpathSync: (path) => path,
        homedir: () => dir,
        stat: async () => ({ isDirectory: () => true }),
      };
      expect((await handleSetSessionHandle(ipc, { tabId: created.tabId, handle: "worker-2" })).ok).toBe(true);

      // ---- boot 2: a real restart re-reads the files and resumes ----
      await persistence.close();
      persistence = new SqlitePersistenceAdapter(dbPath);
      sessions = createSessionAccessStore(storeFiles);
      expect(sessions.getHandle("sess-1")).toBe("worker-2");

      const sessionsB = sessions;
      const persistenceB = persistence;
      const titlesB = new Map<string, string>();
      const pushedB: string[] = [];
      /** Commits of an accepted resume push (the push itself is fire-and-forget). */
      const pushWrites: Promise<unknown>[] = [];
      const pushesB = createAgentTitlePushes({
        titleOf: (sessionId) => titlesB.get(sessionId),
        request: async (sessionId, title) => {
          pushedB.push(title);
          pushWrites.push(persistenceB.touchSession(sessionId, { title }));
        },
        confirmed: (sessionId, title) => sessionsB.confirmTitle(sessionId, title),
        warn: () => {},
      });
      const resumeRecoveries: Promise<unknown>[] = [];
      const boot2 = rig({
        sessions: sessionsB,
        onSessionRegistered: (info) => {
          sessionsB.register(info);
          resumeRecoveries.push(
            recoverAgentSessionTitleOnRegister(
              createAgentTitleRecoveryDeps({
                sessions: () => sessionsB,
                persistence: () => persistenceB,
                titles: titlesB,
                pushes: pushesB,
                warn: () => {},
              }),
              info,
            ),
          );
        },
      });
      // The resume the renderer triggers: an already-persisted session, --resume.
      const resumed = boot2.manager.createTab({ workspace: "/ws", sessionId: "sess-1", resume: true });
      expect(resumed.ok).toBe(true);
      await Promise.all(resumeRecoveries);
      await settle();
      // The accepted push commits on its own; wait for that write, not for a timer.
      await Promise.all(pushWrites);
      return {
        titlesB,
        pushedB,
        storedTitle: (await persistence.getSessionById("sess-1"))?.title,
        confirmedTitle: sessions.getConfirmedTitle("sess-1"),
      };
    } finally {
      await persistence.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keeps the stored automatic title when a resumed agent session's handle was renamed", async () => {
    const result = await scenario(AUTOMATIC_TITLE);
    // No adoption: the in-memory title and the retained push stay empty…
    expect(result.titlesB.size).toBe(0);
    // …so nothing replaces the row's title on the resume.
    expect(result.pushedB).toEqual([]);
    expect(result.storedTitle).toBe(AUTOMATIC_TITLE);
    expect(result.confirmedTitle).toBeUndefined();
  });

  it("repairs a stored raw-envelope title with the saved handle on resume", async () => {
    const result = await scenario(ENVELOPE_TITLE);
    // The one title nobody typed is replaced by the current saved handle…
    expect(result.titlesB.get("sess-1")).toBe("worker-2");
    expect(result.pushedB).toEqual(["worker-2"]);
    // …and the push lands, so a later boot reads the handle.
    expect(result.storedTitle).toBe("worker-2");
  });
});

/**
 * Effort-bearing creation. The order is the contract: the new session's effort
 * is configured on the REAL new host, BEFORE the tab becomes visible, is
 * shared, gets a handle, or receives its renderer port — so no first message,
 * restored prompt or renderer prompt can start a turn at the wrong effort.
 */
describe("create_session — effort preparation before publication", () => {
  const IDLE_STATUS = { sessionId: "sess-1", engine: "codex", state: "idle", steering: { supported: true, ready: false }, model: "gpt-6.1-terra", effort: null, supportedEfforts: ["low", "xhigh"], appliedEffort: null, effortPending: false };

  it("confirms the model, then the effort, before sharing or delivering the tab", async () => {
    const sequence: string[] = [];
    const requests: Array<{ operation: string; payload: unknown }> = [];
    const r = rig({
      sequence,
      respond: (operation, payload) => {
        requests.push({ operation, payload });
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_model") {
          sequence.push("model-configured");
          return { result: { ok: true, status: IDLE_STATUS } };
        }
        if (operation === "set_session_effort") {
          sequence.push("effort-configured");
          return { result: { ok: true, status: { ...IDLE_STATUS, effort: "xhigh" } } };
        }
        return undefined;
      },
    });
    // Capture what the world looked like at the instant the port was delivered.
    const delivered: Array<{ published: boolean; exposed: boolean }> = [];
    vi.spyOn(r.manager, "deliverTabPort").mockImplementation((tab) => {
      delivered.push({
        published: r.manager.listTabs().some((entry) => entry.sessionId === tab.sessionId),
        exposed: r.sessions.isExposed(tab.sessionId),
      });
      sequence.push("port-delivered");
    });

    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "codex", model: "gpt-6.1-terra", effort: "xhigh" }, r.deps());
    expect(outcome.ok).toBe(true);

    // Readiness was probed first, then exactly one model mutation and one
    // effort mutation, each carrying the RAW requested value. The model comes
    // first: the effort is validated against the model the session really runs.
    expect(r.operations).toEqual(["get_session_status", "set_session_model", "set_session_effort"]);
    expect(requests[1]).toEqual({ operation: "set_session_model", payload: { model: "gpt-6.1-terra" } });
    expect(requests[2]).toEqual({ operation: "set_session_effort", payload: { effort: "xhigh" } });
    // Publication (registration) came after both, and the port last.
    expect(sequence).toEqual(["model-configured", "effort-configured", "registered", "port-delivered"]);
    expect(delivered).toEqual([{ published: true, exposed: true }]);
  });

  it("keeps deferred effort creation private until the requested effort is accepted", async () => {
    let blocked = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let parked = false;
    const sequence: string[] = [];
    const r = rig({ blocked: () => blocked, pendingFactory: () => { parked = true; return pending; }, window: true, sequence,
      respond: (operation, payload) => {
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_effort") {
          expect(payload).toEqual({ effort: "xhigh" });
          sequence.push("effort-configured");
          return { result: { ok: true, status: { ...IDLE_STATUS, effort: "xhigh" } } };
        }
        return undefined;
      },
    });
    const creation = createSessionForAgent({ workspace: "/ws", engine: "codex", effort: "xhigh", handle: "worker" }, r.deps());
    await vi.waitFor(() => expect(parked).toBe(true));
    blocked = false;
    release();
    const outcome = await creation;
    expect(outcome.ok).toBe(true);
    expect(sequence).toEqual(["effort-configured", "registered"]);
    expect(r.posted.filter((entry) => entry.channel === PORT_ENVELOPE_TYPE)).toHaveLength(1);
    expect(r.agentOpenedSessions.size).toBe(1);
  });

  it("does not register attribution when a deferred effort is refused", async () => {
    let blocked = true;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let parked = false;
    const r = rig({ blocked: () => blocked, pendingFactory: () => { parked = true; return pending; }, window: true,
      respond: (operation) => operation === "get_session_status" ? { result: IDLE_STATUS }
        : operation === "set_session_effort" ? { result: { ok: false, reason: "invalid_effort", detail: "invalid" } } : undefined,
    });
    const creation = createSessionForAgent({ workspace: "/ws", engine: "codex", effort: "bad", handle: "worker" }, r.deps());
    await vi.waitFor(() => expect(parked).toBe(true));
    blocked = false;
    release();
    const outcome = await creation;
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_effort" });
    expect(r.agentOpenedSessions.size).toBe(0);
    expect(r.agentSessionTitles.size).toBe(0);
    expect(r.posted).toHaveLength(0);
    expect(r.manager.listTabs()).toHaveLength(0);
  });

  it("aborts invalid effort creation without leaving a tab or session row", async () => {
    const sequence: string[] = [];
    const exposed = new Map<string, boolean>();
    const setHandle = vi.fn(() => ({ ok: true as const }));
    const sessions: SessionAccessStore = {
      isExposed: (id) => exposed.get(id) === true,
      register: () => {},
      remove: () => {},
      set: (id, enabled) => (exposed.set(id, enabled), true),
      exposedCount: () => exposed.size,
      getHandle: () => undefined,
      setHandle,
      sessionIdByHandle: () => undefined,
      getConfirmedTitle: () => undefined,
      confirmTitle: () => {},
    };
    const detail = 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","xhigh"]; reason=not_advertised';
    const r = rig({
      sessions,
      sequence,
      respond: (operation) => {
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_model") return { result: { ok: true, status: IDLE_STATUS } };
        if (operation === "set_session_effort") return { result: { ok: false, reason: "invalid_effort", detail } };
        return undefined;
      },
    });
    const deleted: string[] = [];

    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", model: "gpt-6.1-terra", effort: "turbo", handle: "worker-1" },
      r.deps({
        deleteSessionRow: async (sessionId) => {
          sequence.push(`row-deleted:${sessionId}`);
          deleted.push(sessionId);
        },
      }),
    );

    // The host's classification and detail come back unchanged.
    expect(outcome).toEqual({ ok: false, reason: "invalid_effort", detail });
    // The host was reaped BEFORE its row was deleted (a late host write can no
    // longer recreate it), and only the id this attempt minted was touched.
    expect(sequence).toEqual(["host-shutdown", "host-exit", "row-deleted:sess-0"]);
    expect(deleted).toEqual(["sess-0"]);
    // Nothing survives: no tab, no binding, no sharing, no handle.
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.manager.sessionOpenInTab("sess-0")).toBeUndefined();
    expect(exposed.size).toBe(0);
    expect(setHandle).not.toHaveBeenCalled();
  });

  it("deletes the failed session row only after a hung host has really exited", async () => {
    // The host ignores the shutdown message and only the reaper's force kill
    // lands it, well after the reap deadline. Deleting the row on the deadline
    // instead of on the real exit would leave the session that host is still
    // writing free to recreate the row.
    const sequence: string[] = [];
    const detail = 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","xhigh"]; reason=not_advertised';
    const r = rig({
      sequence,
      limits: { exitDeadlineMs: 40 },
      stubbornHost: true,
      killExitDelayMs: 30,
      respond: (operation) => {
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_model") return { result: { ok: true, status: IDLE_STATUS } };
        if (operation === "set_session_effort") return { result: { ok: false, reason: "invalid_effort", detail } };
        return undefined;
      },
    });

    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", model: "gpt-6.1-terra", effort: "turbo" },
      r.deps({ deleteSessionRow: async (sessionId) => { sequence.push(`row-deleted:${sessionId}`); } }),
    );

    expect(outcome).toEqual({ ok: false, reason: "invalid_effort", detail });
    expect(sequence).toEqual(["host-shutdown", "host-exit", "row-deleted:sess-0"]);
    expect(r.manager.listTabs()).toEqual([]);
  });

  it("keeps the failed session row until a host that outlives both reap deadlines really exits", async () => {
    // The hung host survives the shutdown deadline AND the post-kill exit
    // deadline. The refusal may return, but deleting the row here would free a
    // live server to write it straight back: the deletion has to wait for the
    // real exit event.
    const sequence: string[] = [];
    const detail = 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","xhigh"]; reason=not_advertised';
    const r = rig({
      sequence,
      limits: { exitDeadlineMs: 40 },
      stubbornHost: true,
      holdKillExit: true,
      respond: (operation) => {
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_model") return { result: { ok: true, status: IDLE_STATUS } };
        if (operation === "set_session_effort") return { result: { ok: false, reason: "invalid_effort", detail } };
        return undefined;
      },
    });

    const deleted: string[] = [];
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", model: "gpt-6.1-terra", effort: "turbo" },
      r.deps({ deleteSessionRow: async (sessionId) => { sequence.push(`row-deleted:${sessionId}`); deleted.push(sessionId); } }),
    );

    expect(outcome).toEqual({ ok: false, reason: "invalid_effort", detail });
    expect(r.hosts[0]!.kill).toHaveBeenCalled();
    // Still alive, so no row deletion and no respawn: the tab keeps its slot.
    expect(r.manager.listTabs()).toEqual([]);
    expect(deleted).toEqual([]);
    expect(sequence).not.toContain("row-deleted:sess-0");
    expect(r.hosts).toHaveLength(1);

    r.hosts[0]!.emit("exit", 0);
    await vi.waitFor(() => expect(deleted).toEqual(["sess-0"]));
    // Exactly once, and only after the exit landed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleted).toEqual(["sess-0"]);
    expect(sequence).toEqual(["host-shutdown", "host-exit", "row-deleted:sess-0"]);
    expect(r.manager.sessionOpenInTab("sess-0")).toBeUndefined();
    expect(r.hosts).toHaveLength(1);
  });

  it.each(["high", "xhigh"])("waits for Claude %s effort acknowledgement before publication", async (effort) => {
    const r = rig({
      respond: (operation) => {
        if (operation === "get_session_status") return { result: { ...IDLE_STATUS, engine: "claude", model: "opus" } };
        if (operation === "set_session_model") return { result: { ok: true, status: { ...IDLE_STATUS, engine: "claude", model: "opus" } } };
        // Hold the acknowledgement, exactly like a control request still in flight.
        if (operation === "set_session_effort") return { defer: true };
        return undefined;
      },
    });
    const delivered = vi.fn();
    vi.spyOn(r.manager, "deliverTabPort").mockImplementation(delivered);

    const creation = createSessionForAgent({ workspace: "/ws", engine: "claude", model: "opus", effort }, r.deps());
    await vi.waitFor(() => expect(r.deferredReplies).toHaveLength(1));

    // While the CLI has not acknowledged, the session does not exist for anyone.
    expect(r.deferredReplies[0]!.payload).toEqual({ effort });
    expect(r.manager.listTabs()).toEqual([]);
    expect(r.sessions.isExposed("sess-0")).toBe(false);
    expect(delivered).not.toHaveBeenCalled();

    r.deferredReplies[0]!.answer({ ok: true, status: { ...IDLE_STATUS, effort } });
    const outcome = await creation;

    expect(outcome.ok).toBe(true);
    expect(r.manager.listTabs().map((tab) => tab.sessionId)).toEqual(["sess-0"]);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("confirms a FULL Claude model id on the new host, verbatim, before publication", async () => {
    // The reported defect: `create_session {engine:"claude", model:"claude-haiku-5-5"}`
    // opened a session that really ran the default model, because the value was
    // resolved privately at boot and silently replaced. Now the SAME request is
    // handed to the host's own catalog (`set_session_model`) before the tab
    // exists for anyone, and an alias travels exactly the same way.
    const requests: Array<{ operation: string; payload: unknown }> = [];
    const r = rig({
      respond: (operation, payload) => {
        requests.push({ operation, payload });
        if (operation === "get_session_status") return { result: { ...IDLE_STATUS, engine: "claude", model: "default" } };
        if (operation === "set_session_model") {
          return { result: { ok: true, status: { ...IDLE_STATUS, engine: "claude", model: "haiku" } } };
        }
        return undefined;
      },
    });
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "claude", model: "claude-haiku-5-5" },
      r.deps(),
    );
    expect(outcome.ok).toBe(true);
    expect(r.operations).toEqual(["get_session_status", "set_session_model"]);
    expect(requests[1]).toEqual({ operation: "set_session_model", payload: { model: "claude-haiku-5-5" } });
    // The argv still carries the request to the fork (the boot applies it too).
    expect(r.forkArgs[0]).toEqual(expect.arrayContaining(["--engine-model", "claude-haiku-5-5"]));
  });

  it("an alias reaches the engine the same way, unchanged", async () => {
    const requests: Array<{ operation: string; payload: unknown }> = [];
    const r = rig({
      respond: (operation, payload) => {
        requests.push({ operation, payload });
        if (operation === "get_session_status") return { result: { ...IDLE_STATUS, engine: "claude", model: "default" } };
        if (operation === "set_session_model") return { result: { ok: true, status: { ...IDLE_STATUS, engine: "claude", model: "haiku" } } };
        return undefined;
      },
    });
    expect((await createSessionForAgent({ workspace: "/ws", engine: "claude", model: "haiku" }, r.deps())).ok).toBe(true);
    expect(requests[1]).toEqual({ operation: "set_session_model", payload: { model: "haiku" } });
  });

  it("an unusable model is refused invalid_model and the prepared tab is rolled back", async () => {
    // No silent default: a value the account offers nothing for is an explicit
    // refusal carrying the host's complete detail, and nothing survives —
    // no tab, no sharing, no handle, no leftover session row.
    const detail = 'engine=claude; model="claude-imaginary-9"; available=["default","haiku"]; reason=not_advertised';
    const sequence: string[] = [];
    const exposed = new Map<string, boolean>();
    const setHandle = vi.fn(() => ({ ok: true as const }));
    const sessions: SessionAccessStore = {
      isExposed: (id) => exposed.get(id) === true,
      register: () => {},
      remove: () => {},
      set: (id, enabled) => (exposed.set(id, enabled), true),
      exposedCount: () => exposed.size,
      getHandle: () => undefined,
      setHandle,
      sessionIdByHandle: () => undefined,
      getConfirmedTitle: () => undefined,
      confirmTitle: () => {},
    };
    const r = rig({
      sessions,
      sequence,
      respond: (operation) => {
        if (operation === "get_session_status") return { result: { ...IDLE_STATUS, engine: "claude", model: "default" } };
        if (operation === "set_session_model") return { result: { ok: false, reason: "invalid_model", detail } };
        return undefined;
      },
    });
    const deleted: string[] = [];
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "claude", model: "claude-imaginary-9", handle: "worker-1" },
      r.deps({ deleteSessionRow: async (sessionId) => { sequence.push(`row-deleted:${sessionId}`); deleted.push(sessionId); } }),
    );

    expect(outcome).toEqual({ ok: false, reason: "invalid_model", detail });
    expect(sequence).toEqual(["host-shutdown", "host-exit", "row-deleted:sess-0"]);
    expect(deleted).toEqual(["sess-0"]);
    expect(r.manager.listTabs()).toEqual([]);
    expect(exposed.size).toBe(0);
    expect(setHandle).not.toHaveBeenCalled();
    // No effort was attempted after the model was refused.
    expect(r.operations).toEqual(["get_session_status", "set_session_model"]);
  });

  it("a codex model the account does not offer is refused invalid_model, never replaced by the default", async () => {
    const detail = 'engine=codex; model="gpt-imaginary"; available=["gpt-6.1-terra"]; reason=not_advertised';
    const r = rig({
      respond: (operation) => {
        if (operation === "get_session_status") return { result: IDLE_STATUS };
        if (operation === "set_session_model") return { result: { ok: false, reason: "invalid_model", detail } };
        return undefined;
      },
    });
    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "codex", model: "gpt-imaginary" }, r.deps());
    expect(outcome).toEqual({ ok: false, reason: "invalid_model", detail });
    expect(r.manager.listTabs()).toEqual([]);
  });

  it("keeps non-active connection priming before host spawn", async () => {
    const sequence: string[] = [];
    const r = rig({
      sequence,
      respond: (operation) => {
        if (operation === "get_session_status") return { result: { ...IDLE_STATUS, engine: "core", model: "glm-5.3" } };
        if (operation === "set_session_effort") {
          sequence.push("effort-configured");
          return { result: { ok: true, status: { ...IDLE_STATUS, engine: "core" } } };
        }
        return undefined;
      },
    });

    const outcome = await createSessionForAgent({ workspace: "/ws", engine: "core", model: "glm-5.3", effort: "high" }, r.deps());

    expect(outcome.ok).toBe(true);
    // The pin was still primed and used for the fork BEFORE any effort
    // configuration: the fork env is the GLM connection's, not the active one.
    expect(r.forkEnvs).toHaveLength(1);
    expect(r.forkEnvs[0]?.ANYCODE_API_KEY).toBe("conn-glm-key");
    expect(r.forkEnvs[0]?.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    expect(sequence).toEqual(["effort-configured", "registered"]);
    expect(r.operations).toEqual(["get_session_status", "set_session_effort"]);
  });
});

describe("create_session — Codex account", () => {
  const accounts = [
    { id: "system", label: "System" },
    { id: "work", label: "Work" },
  ];
  const codexDeps = (overrides: Partial<CreateSessionByAgentDeps> = {}): Partial<CreateSessionByAgentDeps> => ({
    listCodexAccounts: async () => accounts,
    resolveCodexProfile: async (profileId) =>
      profileId === undefined || profileId === "system"
        ? { ok: true as const }
        : profileId === "work"
          ? { ok: true as const, codexProfile: { id: "work" } }
          : { ok: false as const },
    ...overrides,
  });

  it("an `account` label starts the tab on THAT profile (argv), not on the ambient account", async () => {
    const r = rig();
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", account: "Work" },
      r.deps(codexDeps()),
    );
    expect(outcome.ok).toBe(true);
    expect(r.forkArgs[0]).toContain("--codex-profile");
    expect(r.forkArgs[0]?.slice(r.forkArgs[0].indexOf("--codex-profile") + 1)).toContain("work");
  });

  it("an `account` id works the same way (ids are what a caller reads off the API list)", async () => {
    const r = rig();
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", account: "WORK" },
      r.deps(codexDeps()),
    );
    expect(outcome.ok).toBe(true);
    expect(r.forkArgs[0]).toContain("work");
  });

  it("with no `account` the DEFAULT account is resolved — `resolveCodexProfile(undefined)`, never a silent system spawn", async () => {
    const r = rig();
    const resolveCodexProfile = vi.fn(async (profileId: string | undefined) =>
      profileId === undefined ? { ok: true as const, codexProfile: { id: "work" } } : { ok: false as const },
    );
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex" },
      r.deps(codexDeps({ resolveCodexProfile })),
    );
    expect(outcome.ok).toBe(true);
    expect(resolveCodexProfile).toHaveBeenCalledWith(undefined);
    expect(r.forkArgs[0]).toContain("--codex-profile");
    expect(r.forkArgs[0]).toContain("work");
  });

  it("an unknown account is refused `invalid_account` with every candidate, and no tab is forked", async () => {
    const r = rig();
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", account: "nope" },
      r.deps(codexDeps()),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_account" });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.detail).toContain("System (system)");
    expect(outcome.detail).toContain("Work (work)");
    expect(r.forkEnvs).toHaveLength(0);
  });

  it("an account the registry refuses after matching is refused fail-closed, never spawned on the wrong home", async () => {
    const r = rig();
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "codex", account: "work" },
      r.deps(codexDeps({ resolveCodexProfile: async () => ({ ok: false as const }) })),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_account" });
    expect(r.forkEnvs).toHaveLength(0);
  });

  it("an `account` on a non-Codex engine is refused instead of being silently ignored", async () => {
    const r = rig();
    const listCodexAccounts = vi.fn(async () => accounts);
    const outcome = await createSessionForAgent(
      { workspace: "/ws", engine: "core", account: "Work" },
      r.deps(codexDeps({ listCodexAccounts })),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_account" });
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.detail).toContain("core");
    expect(listCodexAccounts).not.toHaveBeenCalled();
    expect(r.forkEnvs).toHaveLength(0);
  });
});


describe("create_session speed", () => {
  it("refuses speed on a different engine as an invalid argument", async () => {
    const r = rig();
    expect(await createSessionForAgent({ workspace: "/ws", engine: "core", fast: true }, r.deps())).toMatchObject({ ok: false, reason: "invalid_argument" });
  });
  it("preserves a host refusal for unsupported Fast", async () => {
    const r = rig({ respond: (operation) => operation === "get_session_status" ? { result: { state: "idle" } } : operation === "set_session_fast" ? { result: { ok: false, reason: "invalid_argument", detail: "unsupported" } } : undefined });
    expect(await createSessionForAgent({ workspace: "/ws", engine: "codex", fast: true }, r.deps())).toMatchObject({ ok: false, reason: "invalid_argument", detail: "unsupported" });
  });
  it("configures the override before publishing the session", async () => {
    const sequence: string[] = [];
    const r = rig({ sequence, respond: (operation, payload) => {
      if (operation === "get_session_status") return { result: { state: "idle" } };
      if (operation === "set_session_fast") { expect(payload).toBe(false); sequence.push("speed"); return { result: { ok: true } }; }
      return undefined;
    } });
    const result = await createSessionForAgent({ workspace: "/ws", engine: "codex", fast: false }, r.deps());
    expect(result.ok).toBe(true);
    expect(r.operations).toEqual(["get_session_status", "set_session_fast"]);
    expect(sequence.indexOf("speed")).toBeLessThan(sequence.indexOf("registered"));
  });
});

describe("shared creation admission", () => {
  const native = (allowed = true) => ({
    kind: "native" as const, openerSessionId: "opener",
    authorize: vi.fn(() => allowed),
  });
  it("native same-workspace opening preserves private sharing and opener identity", async () => {
    const r = rig();
    const openers = new Map<string, string>();
    const deps = r.deps({ projects: { isAllowed: () => false }, agentSessionOpeners: openers });
    const outcome = await createSessionForAgent({ workspace: "/ws", model: "glm-5.3" }, deps, native());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(r.exposed.get(outcome.sessionId)).not.toBe(true);
    expect(openers.get(outcome.sessionId)).toBe("opener");
    expect(r.forkEnvs[0]?.ANYCODE_CONNECTION_ID).toBe("conn-glm");
    expect(await createSessionForAgent({ workspace: "/ws" }, deps)).toMatchObject({ ok: false, reason: "not_allowed" });
  });
  it("normalizes Windows policy keys while preserving workspace casing", async () => {
    const r = rig();
    const workspace = "C:/Work/Repo";
    const key = "c:\\work\\repo";
    const access = createSessionPeerAccess({ platform: "win32", enabled: () => true,
      isTrusted: candidate => candidate === key, realpathSync: p => p,
      statSync: () => ({ isDirectory: () => true }),
      policy: { projectKeys: () => [], isNativeEnabled: () => true, hasPairGrant: () => false,
        setNativeEnabled: () => false, setPairGrant: () => false } });
    const caller = { workspace, workspaceKey: key, live: true, root: true, restricted: false, readOnly: false };
    const outcome = await createSessionForAgent({ workspace }, r.deps({ platform: "win32",
      readTrustStore: async () => ({ version: 1, folders: { [workspace]: { decision: "trusted", hash: "h", decidedAt: "now" } } }),
    }), { kind: "native", openerSessionId: "opener",
      authorize: (path, pinned, allowed) => access.canAccessWorkspace(caller, path, pinned, "open", allowed) });
    expect(outcome.ok).toBe(true);
    expect(r.manager.listTabs()[0]?.workspace).toBe(workspace);
  });
  it("releases creation admission before a hung native first-message delivery", async () => {
    const r = rig();
    let entered!: () => void;
    const delivering = new Promise<void>(resolve => { entered = resolve; });
    let settle!: (value: { state: string }) => void;
    const first = createSessionForAgent({ workspace: "/ws", firstMessage: "hello" }, r.deps(), {
      ...native(), deliverFirstMessage: () => { entered(); return new Promise(resolve => { settle = resolve; }); },
    });
    await delivering;
    try {
      expect(await createSessionForAgent({ workspace: "/ws" }, r.deps(), native())).toMatchObject({ ok: true, sessionId: "sess-1" });
      expect(r.forkEnvs).toHaveLength(2);
    } finally { settle({ state: "queued" }); }
    expect(await first).toMatchObject({ sessionId: "sess-0", delivery: { state: "queued" } });
  });
  it("forgets opener metadata only for closed tabs", async () => {
    const openers = new Map<string, string>();
    const r = rig({ onTabClosed: () => forgetClosedAgentOpeners(openers, new Set(r.manager.listTabs().map(t => t.sessionId))) });
    const deps = r.deps({ agentSessionOpeners: openers });
    await createSessionForAgent({ workspace: "/ws" }, deps, native());
    await createSessionForAgent({ workspace: "/ws" }, deps, native());
    await r.manager.closeTab(r.manager.listTabs()[0]!.tabId);
    expect([...openers]).toEqual([["sess-1", "opener"]]);
  });
  it("refuses native policy denial before forking", async () => {
    const r = rig();
    expect(await createSessionForAgent({ workspace: "/ws" }, r.deps(), native(false))).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(r.forkEnvs).toHaveLength(0);
  });
  it("serializes external and native calls through the same rate budget", async () => {
    const r = rig();
    const deps = r.deps();
    const outcomes = await Promise.all(Array.from({ length: 9 }, (_, i) =>
      createSessionForAgent({ workspace: "/ws" }, deps, i % 2 ? native() : undefined)));
    expect(outcomes.filter(o => o.ok)).toHaveLength(5);
    expect(r.forkEnvs).toHaveLength(5);
    expect(outcomes.filter(o => !o.ok && o.reason === "rate_limited")).toHaveLength(4);
  });
  it("returns actual ids when native first message cannot be delivered", async () => {
    const r = rig();
    const outcome = await createSessionForAgent({ workspace: "/ws", firstMessage: "hello" }, r.deps(), {
      ...native(), deliverFirstMessage: async () => { throw new Error("lost response"); },
    });
    expect(outcome).toMatchObject({ ok: true, sessionId: "sess-0", tabId: r.manager.listTabs()[0]?.tabId, delivery: { state: "unknown" } });
    expect(r.forkEnvs).toHaveLength(1);
    expect(r.exposed.get("sess-0")).not.toBe(true);
  });
});

it("cross-workspace native creation needs both pair grant and target opt-in", async () => {
  const r = rig();
  let grant = false;
  let optIn = false;
  const access = createSessionPeerAccess({
    enabled: () => true, isTrusted: () => true, realpathSync: p => p,
    statSync: () => ({ isDirectory: () => true }),
    policy: { projectKeys: () => [], isNativeEnabled: () => true, hasPairGrant: () => grant,
      setNativeEnabled: () => false, setPairGrant: () => false },
  });
  const caller = { workspace: "/source", workspaceKey: "/source", live: true, root: true, restricted: false, readOnly: false };
  const policy = { kind: "native" as const, openerSessionId: "opener",
    authorize: (path: string, key: string, allowed: boolean) => access.canAccessWorkspace(caller, path, key, "open", allowed) };
  const deps = r.deps({ projects: { isAllowed: () => optIn } });
  for (const [hasGrant, allowed] of [[false, false], [false, true], [true, false]]) {
    grant = hasGrant!; optIn = allowed!;
    expect(await createSessionForAgent({ workspace: "/ws" }, deps, policy)).toMatchObject({ reason: "not_allowed" });
  }
  expect(r.forkEnvs).toHaveLength(0);
  grant = optIn = true;
  expect((await createSessionForAgent({ workspace: "/ws" }, deps, policy)).ok).toBe(true);
  expect(r.exposed.get("sess-0")).not.toBe(true);
});

it("native failed effort preparation reports the allocated ids without exposing the session", async () => {
  const r = rig({ respond: operation => ({ result: operation === "set_session_effort"
    ? { ok: false, reason: "invalid_effort", detail: "unsupported effort" } : {} }) });
  const outcome = await createSessionForAgent({ workspace: "/ws", effort: "invalid" }, r.deps(), {
    kind: "native", openerSessionId: "opener", authorize: () => true,
  });
  expect(outcome).toMatchObject({ ok: false, reason: "invalid_effort", sessionId: "sess-0", tabId: expect.any(String) });
  expect(r.forkEnvs).toHaveLength(1);
  expect(r.exposed.get("sess-0")).not.toBe(true);
});

it("rechecks native authorization after asynchronous pin preparation and releases the pin", async () => {
  const r = rig();
  let allowed = true;
  const release = vi.fn();
  const outcome = await createSessionForAgent({ workspace: "/ws" }, r.deps({
    primeNewSessionPin: async () => { allowed = false; return { ok: true, release }; },
  }), { kind: "native", openerSessionId: "opener", authorize: () => allowed });
  expect(outcome).toMatchObject({ ok: false, reason: "not_allowed" });
  expect(release).toHaveBeenCalledOnce();
  expect(r.forkEnvs).toHaveLength(0);
});

it("HTTP and native entries share one creation budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anycode-shared-create-"));
  const r = rig();
  const deps = r.deps();
  const discoveryFile = join(dir, "communication.json");
  const service = await startCommunicationServer({
    manager: { listTabs: () => r.manager.listTabs(), communicationRequest: async () => ({ engine: "core", state: "idle" }) },
    userData: dir, config: { workspaces: [], discoveryFile }, realpath: async p => p,
    agentOpenedSessions: r.agentOpenedSessions,
    createSessionByAgent: request => createSessionForAgent(request, deps),
  });
  const client = new Client({ name: "shared-creation", version: "1" });
  try {
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    const native = { kind: "native" as const, openerSessionId: "opener", authorize: () => true };
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2
      ? createSessionForAgent({ workspace: "/ws" }, deps, native).then(result => result.ok)
      : client.callTool({ name: "create_session", arguments: { workspace: "/ws" } }).then(result => !result.isError)));
    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(r.forkEnvs).toHaveLength(5);
  } finally {
    await client.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("peer handler uses main's admitted creator adapter and primes the selected connection before root fork", async () => {
  const { createSessionPeerOpener } = await import("./session-peer-open.js");
  const { createSessionPeersHandler } = await import("./session-peers.js");
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("open: createSessionPeerOpener(createSessionDeps)");
  const r = rig(), openers = new Map<string, string>();
  const caller = { sessionId: "opener", tabId: "opener", proc: {}, generation: 1, workspace: "/ws", workspaceKey: "/ws",
    live: true, root: true, restricted: false, readOnly: false, engine: "core" as const, activity: "idle" as const };
  const access = createSessionPeerAccess({ enabled: () => true, policy: {
    isNativeEnabled: () => true, hasPairGrant: () => false, projectKeys: () => [],
    setNativeEnabled: () => false, setPairGrant: () => false,
  }, isTrusted: () => true, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) });
  const handler = createSessionPeersHandler({ current: () => caller, targets: () => [], access, prepare: async () => {},
    open: createSessionPeerOpener(r.deps({ projects: { isAllowed: () => false }, agentSessionOpeners: openers })) });
  expect(await handler(caller.tabId, caller.proc, { requestId: "open", operation: "open", input: { model: "glm-5.3" } }))
    .toMatchObject({ status: "opened", sessionId: "sess-0" });
  expect(r.forkEnvs[0]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_API_KEY: "conn-glm-key" });
  expect(openers.get("sess-0")).toBe("opener");
  expect(r.exposed.get("sess-0")).not.toBe(true);
});


describe("managed native SessionOpen", () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture(options: Parameters<typeof rig>[0] = {}) {
    const receipt: ChildWorktreeReceipt = { version: 1, id: "resource", appRunId: "run", parentSessionId: "opener",
      childSessionId: "sess-1", sourceRoot: "/ws", storageRoot: "/ws", projectRoot: "/project", baseSha: "a".repeat(40),
      path: "/ws/.anycode/worktrees/child-resource", branch: "anycode-wt/child-resource", phase: "active", reason: null };
    const resources = { read: vi.fn(async () => receipt), snapshot: vi.fn(async () => receipt), allocate: vi.fn(async () => receipt),
      update: vi.fn(async (_r: ChildWorktreeReceipt, phase: ChildWorktreeReceipt["phase"], reason: string) => ({ ...receipt, phase, reason })) };
    const r = rig({ ...options, managerDeps: { childWorktrees: resources, ...options.managerDeps } });
    const root = r.manager.createTab({ workspace: "/ws", projectRoot: "/project", sessionId: "opener", resume: false });
    if (!root.ok) throw new Error("fixture opener refused");
    root.tab.childWorktreePolicy = true;
    const policy = { kind: "native" as const, openerSessionId: "opener", authorize: vi.fn(() => true),
      deliverFirstMessage: vi.fn(async () => ({ state: "rejected" })) };
    const deps = r.deps();
    return { ...r, receipt, resources, parent: root.tab, policy, deps, open: createSessionPeerOpener(deps) };
  }

  it("canonicalizes the opener workspace before comparing a same-checkout request", async () => {
    const r = fixture(); r.parent.workspace = "/alias";
    r.deps.realpathSync = p => p === "/alias" ? "/ws" : p;
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(true);
  });

  it("does not record unrelated trust refusals and clears the previous refusal after success", async () => {
    const r = fixture(); r.parent.childWorktreeRefusal = "old worktree failure";
    const trust = r.deps.readTrustStore; r.deps.readTrustStore = async () => ({ version: 1, folders: {} });
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(false);
    expect(r.parent.childWorktreeRefusal).toBe("old worktree failure");
    r.deps.readTrustStore = trust; r.parent.childWorktreePolicy = false;
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(true);
    expect(r.parent.childWorktreeRefusal).toBeUndefined();
  });

  it("rechecks authorization immediately before publishing, after successful preparation", async () => {
    const r = fixture();
    r.policy.authorize.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const publish = vi.spyOn(r.manager, "publishPreparedTab");
    expect(await r.open({ workspace: "/ws" }, r.policy)).toMatchObject({ ok: false, detail: expect.stringContaining("authorized") });
    expect(r.resources.allocate).toHaveBeenCalledOnce(); expect(r.forkCwds).toHaveLength(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([false, true])("failed preparation settles on exit or bounded timeout (timeout=%s)", async timeout => {
    const settle = vi.spyOn(childCleanup, "settleChildWorktree").mockResolvedValue({ phase: timeout ? "unknown" : "removed", reason: "test disposition" });
    const r = fixture({ stubbornHost: true, holdKillExit: true, managerDeps: { limits: { exitDeadlineMs: 30 } },
      respond: op => ({ result: op === "get_session_status" ? {} : { ok: false, reason: "invalid_effort" } }) });
    const opening = r.open({ workspace: "/ws", effort: "high" }, r.policy);
    await vi.waitFor(() => expect(r.hosts[1]?.postMessage).toHaveBeenCalledWith({ type: "shutdown" }), { interval: 1 });
    expect(settle).not.toHaveBeenCalled();
    if (!timeout) r.hosts[1]!.emit("exit", 0);
    const result = await opening;
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining(`Worktree ${timeout ? "unknown" : "removed"}:`) });
    expect(settle).toHaveBeenCalledOnce();
    expect(settle.mock.calls[0]![0].permission.actualExit).toBe(!timeout);
    if (timeout) r.hosts[1]!.emit("exit", 0);
    await new Promise(resolve => setImmediate(resolve));
    expect(settle).toHaveBeenCalledOnce();
    expect(r.manager.listTabs().map(t => t.sessionId)).toEqual(["opener"]);
  });

  it("forks a new cwd, preserves projectRoot, keeps the pin, and reports rejected firstMessage without HTTP sharing", async () => {
    const r = fixture({ window: true });
    const result = await r.open({ workspace: "/ws", model: "conn-glm", firstMessage: "hello" }, r.policy);
    expect(result).toMatchObject({ ok: true, delivery: { state: "rejected" } });
    expect(r.forkCwds).toEqual(["/ws", r.receipt.path]);
    expect(r.forkEnvs[1]).toMatchObject({ ANYCODE_CONNECTION_ID: "conn-glm", ANYCODE_MANAGED_CHILD_WORKTREE: "1" });
    const child = r.manager.listTabs().find(t => t.sessionId === "sess-1")!;
    expect(r.manager.getTab(child.tabId)).toMatchObject({ projectRoot: "/project", childWorktree: r.receipt });
    expect(r.exposed.get("sess-1")).not.toBe(true);
    expect(r.policy.authorize).toHaveBeenCalledWith("/ws", "/ws", true);
    expect(r.policy.deliverFirstMessage).toHaveBeenCalledOnce();
  });

  it("captures ON before the creation queue, even when policy is switched OFF during trust await", async () => {
    const r = fixture();
    r.deps.readTrustStore = async () => { r.parent.childWorktreePolicy = false;
      return { version: 1, folders: { "/ws": { decision: "trusted", hash: "h", decidedAt: "now" } } }; };
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(true);
    expect(r.resources.allocate).toHaveBeenCalledOnce();
  });

  it("a request queued behind another creator retains its admitted ON policy", async () => {
    const r = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const prime = vi.fn(async () => { await pending; });
    r.deps.mcpSecretPrime = prime;
    const first = createSessionForAgent({ workspace: "/ws" }, r.deps);
    await vi.waitFor(() => expect(prime).toHaveBeenCalledOnce());
    const queued = r.open({ workspace: "/ws" }, r.policy);
    r.parent.childWorktreePolicy = false;
    release();
    expect((await first).ok).toBe(true);
    expect((await queued).ok).toBe(true);
    expect(r.resources.allocate).toHaveBeenCalledOnce();
    expect(r.forkCwds.at(-1)).toBe(r.receipt.path);
  });

  it("OFF and external HTTP creation retain the old cwd", async () => {
    const r = fixture();
    r.parent.childWorktreePolicy = false;
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(true);
    r.parent.childWorktreePolicy = true;
    expect((await createSessionForAgent({ workspace: "/ws" }, r.deps)).ok).toBe(true);
    expect(r.forkCwds).toEqual(["/ws", "/ws", "/ws"]);
    expect(r.resources.allocate).not.toHaveBeenCalled();
  });

  it.each(["foreign", "claude", "codex", "helper", "non-git", "add", "access", "trust"])("refuses %s before a child fork", async failure => {
    const r = fixture(failure === "helper" ? { managerDeps: { childWorktrees: undefined } } : {});
    if (failure === "non-git") r.resources.snapshot.mockRejectedValue(new Error("Git required"));
    if (failure === "add") r.resources.allocate.mockRejectedValue(new Error("allocation residue in receipt"));
    if (failure === "access") r.policy.authorize.mockReturnValue(false);
    if (failure === "foreign") r.deps.readTrustStore = async () => ({ version: 1,
      folders: { "/other": { decision: "trusted", hash: "h", decidedAt: "now" } } });
    if (failure === "trust") r.deps.readTrustStore = async () => ({ version: 1, folders: {} });
    const result = await r.open({ workspace: failure === "foreign" ? "/other" : "/ws",
      ...(failure === "claude" || failure === "codex" ? { engine: failure } : {}) }, r.policy);
    expect(result.ok).toBe(false);
    expect(r.forkCwds).toHaveLength(1);
    if (!["add", "non-git"].includes(failure)) expect(r.resources.allocate).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "add", "pin", "effort", "deferred"])("opener generation change during %s prevents publication and retains any receipt", async phase => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let blocked = false, pinEntered = false;
    const release = vi.fn();
    const r = fixture({ blocked: () => blocked, pending, respond: op => op === "get_session_status"
      ? { result: {} } : { defer: true } });
    if (phase === "snapshot") r.resources.snapshot.mockImplementation(async () => { await pending; return r.receipt; });
    if (phase === "add") r.resources.allocate.mockImplementation(async () => { await pending; return r.receipt; });
    if (phase === "pin") {
      r.deps.primeNewSessionPin = async () => { pinEntered = true; await pending; return { ok: true, release }; };
    }
    if (phase === "deferred") { r.deps.primeNewSessionPin = async () => ({ ok: true, release() {} }); blocked = true; }
    const creating = vi.spyOn(r.manager, "createTabAwaitingInitialSpawn");
    const opening = r.open({ workspace: "/ws", ...(phase === "effort" ? { effort: "high" } : {}) }, r.policy);
    await vi.waitFor(() => expect(phase === "pin" ? Number(pinEntered) : phase === "effort"
      ? r.deferredReplies.length : r.resources[phase === "snapshot" ? "snapshot" : "allocate"].mock.calls.length).toBeGreaterThan(0));
    if (phase === "deferred") await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce());
    r.parent.hostGeneration += 1;
    blocked = false;
    finish();
    if (phase === "effort") r.deferredReplies[0]!.answer({ ok: true });
    expect((await opening).ok).toBe(false);
    expect(r.manager.listTabs().map(t => t.sessionId)).toEqual(["opener"]);
    if (phase !== "effort") expect(r.forkCwds).toHaveLength(1);
    if (["add", "effort", "deferred"].includes(phase)) expect(r.resources.update).toHaveBeenCalled();
    if (phase === "pin") expect(release).toHaveBeenCalledOnce();
  });

  it.each(["fork", "effort"])("%s failure retains the receipt without leaking a creation slot", async failure => {
    const r = fixture({ failAfterRoot: failure === "fork", respond: op => ({ result: op === "get_session_status" ? {} : { ok: false, reason: "invalid_effort" } }) });
    const result = await r.open({ workspace: "/ws", ...(failure === "effort" ? { effort: "high" } : {}) }, r.policy);
    expect(result.ok).toBe(false);
    expect(r.manager.listTabs().map(t => t.sessionId)).toEqual(["opener"]);
    expect(r.resources.update).toHaveBeenCalledWith(r.receipt, failure === "fork" ? "retained" : "unknown", expect.any(String));
    expect(result).toMatchObject({ detail: expect.stringContaining(r.receipt.path) });
  });

  it("rechecks access after add and releases the pin on refusal", async () => {
    const r = fixture();
    const release = vi.fn();
    r.deps.primeNewSessionPin = async () => ({ ok: true, release });
    r.resources.allocate.mockImplementation(async () => { r.policy.authorize.mockReturnValue(false); return r.receipt; });
    expect((await r.open({ workspace: "/ws" }, r.policy)).ok).toBe(false);
    expect(r.forkCwds).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
    expect(r.resources.update).toHaveBeenCalledOnce();
  });

  it("actual opener close during add refuses the late result and a later open can still reserve", async () => {
    const r = fixture();
    r.manager.createTab({ workspace: "/other", sessionId: "other", resume: false });
    let finish!: (value: ChildWorktreeReceipt) => void;
    r.resources.allocate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const opening = r.open({ workspace: "/ws" }, r.policy);
    await vi.waitFor(() => expect(r.resources.allocate).toHaveBeenCalledOnce());
    expect(await r.manager.closeTab(r.parent.tabId)).toMatchObject({ ok: true });
    finish(r.receipt);
    expect((await opening).ok).toBe(false);
    expect(r.forkCwds).toHaveLength(2);
    expect(r.resources.update).toHaveBeenCalledOnce();
    expect((await createSessionForAgent({ workspace: "/ws" }, r.deps)).ok).toBe(true);
  });

  it("first-message access uses the new folder facts and receives no inherited trust or pair grant", async () => {
    const r = fixture();
    const grant = vi.fn(() => false);
    const access = createSessionPeerAccess({ enabled: () => true, realpathSync: p => p,
      statSync: () => ({ isDirectory: () => true }), isTrusted: key => key === "/ws",
      policy: { projectKeys: () => ["/ws"], isNativeEnabled: key => key === "/ws", hasPairGrant: () => false,
        setNativeEnabled: grant, setPairGrant: grant } });
    const from = { workspace: "/ws", workspaceKey: "/ws", root: true, live: true, restricted: false, readOnly: false };
    r.policy.deliverFirstMessage.mockImplementation(async () => {
      const target = r.manager.listTabs().find(t => t.sessionId === "sess-1")!;
      return { state: await access.canAccess(from, { ...from, workspace: target.workspace, workspaceKey: target.workspace }, "send") ? "queued" : "rejected" };
    });
    expect(await r.open({ workspace: "/ws", firstMessage: "hello" }, r.policy)).toMatchObject({ ok: true, delivery: { state: "rejected" } });
    expect(grant).not.toHaveBeenCalled();
    expect(r.exposed.get("sess-1")).not.toBe(true);
    expect(await r.manager.closeTab(r.parent.tabId)).toMatchObject({ ok: true });
    expect(r.manager.listTabs().map(t => t.sessionId)).toEqual(["sess-1"]);
  });

});
