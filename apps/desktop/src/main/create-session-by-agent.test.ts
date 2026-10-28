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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionAccessStore } from "./communication-sessions.js";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MessagePortMain, UtilityProcess } from "electron";
import { createSessionForAgent, type CreateSessionByAgentDeps } from "./create-session-by-agent.js";
import { primeNewSessionPin, type ResumePinResult } from "./session-pin.js";
import { TabHostManager, type HostForkFn } from "./tabs.js";
import type { SessionAccessStore } from "./communication-sessions.js";
import type { AnycodeSettings } from "../shared/settings.js";

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

function rig(options: { failPrimingFor?: string; blocked?: () => boolean; pending?: Promise<void>; failFork?: boolean; sessions?: SessionAccessStore; workspaceMissing?: (workspace: string) => boolean } = {}) {
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
  const manager = new TabHostManager({
    fork,
    onSessionRegistered: ({ sessionId }) => {
      const added = options.sessions?.register({ sessionId });
      return () => { if (added) options.sessions?.remove(sessionId); };
    },
    waitForHostEnv: () => options.blocked?.() ? options.pending : undefined,
    hostEntry: "/fake/host.js",
    createChannel: fakeChannel,
    getWindow: () => null,
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
    agentOpenedSessions: new Set<string>(),
    agentSessionTitles: new Map<string, string>(),
    listTabs: () => manager.listTabs(),
    ...overrides,
  });
  return { manager, deps, forkEnvs, sessions, exposed };
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
});


describe("deferred agent session registration", () => {
  it.each([false, true])("keeps sharing and handle on success and removes them on failure (failure=%s)", async (failFork) => {
    const dir = mkdtempSync(join(tmpdir(), "anycode-access-test-"));
    try {
      const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
      let blocked = true;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const r = rig({ sessions, blocked: () => blocked, pending, failFork });
      const outcome = await createSessionForAgent({ workspace: "/ws", handle: "agent-one" }, r.deps());
      if (!outcome.ok) throw new Error("create refused");
      expect(sessions.isExposed(outcome.sessionId)).toBe(true);
      expect(sessions.getHandle(outcome.sessionId)).toBe("agent-one");
      blocked = false;
      release();
      if (failFork) {
        await vi.waitFor(() => expect(r.manager.getTab(outcome.tabId)).toBeUndefined());
        expect(sessions.set(outcome.sessionId, true)).toBe(false);
        expect(sessions.getHandle(outcome.sessionId)).toBeUndefined();
      } else {
        await vi.waitFor(() => expect(r.forkEnvs).toHaveLength(1));
        expect(sessions.isExposed(outcome.sessionId)).toBe(true);
        expect(sessions.getHandle(outcome.sessionId)).toBe("agent-one");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
