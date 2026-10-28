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
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { Client, StreamableHTTPClientTransport } from "@anycode/core/communication-mcp";
import { startCommunicationServer } from "./communication-server.js";
import { createSessionForAgent, type CreateSessionByAgentDeps } from "./create-session-by-agent.js";
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

function rig(options: { failPrimingFor?: string; blocked?: () => boolean; pending?: Promise<void>; pendingFactory?: () => Promise<void>; failFork?: boolean; sessions?: SessionAccessStore; workspaceMissing?: (workspace: string) => boolean; window?: boolean } = {}) {
  // Mirrors main/index.ts: `hostEnvByConnection`, filled ONLY by ensurePinnedEnv
  // (through resolveResumePin) and read fail-closed by the fork's `env`.
  const cache = new Map<string, NodeJS.ProcessEnv>();
  const forkEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const hosts: FakeHost[] = [];
  const fork: HostForkFn = (_entry, _args, opts) => {
    if (options.failFork) throw new Error("fork failed");
    forkEnvs.push(opts?.env as NodeJS.ProcessEnv | undefined);
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
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
    onSessionRegistered: ({ sessionId }) => {
      const added = options.sessions?.register({ sessionId });
      return () => { if (added) options.sessions?.remove(sessionId); };
    },
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
    limits: {},
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
    randomUUID: () => `sess-${forkEnvs.length}`,
    agentOpenedSessions,
    agentSessionTitles,
    listTabs: () => manager.listTabs(),
    ...overrides,
  });
  return { manager, deps, forkEnvs, sessions, exposed, posted, agentOpenedSessions, agentSessionTitles };
}

describe("create_session — the production creation path primes a non-active connection before the fork", () => {
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
