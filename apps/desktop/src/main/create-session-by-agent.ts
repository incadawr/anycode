/**
 * the Sessions API `create_session` hook, extracted
 * from `main/index.ts` so the production path is directly testable with two
 * connections (the pin-before-spawn ordering is the load-bearing behaviour —
 * a non-active connection MUST be primed before `createTab`, or the fork env
 * cache misses and the tab dies fail-closed as `crash_looped`).
 *
 * Main owns every gate: the per-project switch, workspace trust, tab capacity,
 * engine readiness, and the core `model` -> provider connection resolution.
 */

import type { WorkspaceTrustStore } from "@anycode/core/workspace-trust";
import { canonicalWorkspaceKey } from "@anycode/core/workspace-trust";
import type { CreateSessionOutcome, CreateSessionRequest } from "./communication-server.js";
import { normalizeHandle, type SessionAccessStore } from "./communication-sessions.js";
import type { NewSessionPin, ResumePinResult } from "./session-pin.js";
import type { TabHostManager } from "./tabs.js";
import { resolveCoreConnectionForModel } from "../shared/core-model-connection.js";
import type { AnycodeSettings } from "../shared/settings.js";

export interface CreateSessionByAgentDeps {
  /** Per-project agent-open switch, or null before boot wires it. */
  projects: { isAllowed(key: string): boolean } | null;
  /**
   * Live tab manager, READ AT CALL TIME. Boot builds this deps bag BEFORE it
   * assigns `manager`; snapshotting the value here would freeze `null` into
   * every later `create_session` (always `not_ready`), so the bag carries a
   * thunk exactly like `createCommunicationController`'s own `manager`.
   */
  manager(): TabHostManager | null;
  /** Live session-access store, read at call time for the same reason. */
  sessions(): SessionAccessStore | null;
  /** Node realpath used to canonicalise the workspace trust key. */
  realpathSync(path: string): string;
  /** Reads the workspace trust store (fail-soft on the caller's side). */
  readTrustStore(): Promise<WorkspaceTrustStore>;
  /** Primes the MCP secret fork cache for a canonical workspace key. */
  mcpSecretPrime(key: string): Promise<void>;
  /** Live settings (or the empty v2 default before load). */
  currentSettings(): AnycodeSettings;
  /** Primes + reserves a NEW session's pinned connection before createTab. */
  primeNewSessionPin(
    connectionId: string | undefined,
    activeConnectionId: string | undefined,
    resolveResumePin: (meta: { connectionId?: string }) => Promise<ResumePinResult>,
  ): Promise<NewSessionPin>;
  /** Resolves a pinned connection for the resume path (shared with priming). */
  resolveResumePin(meta: { connectionId?: string }): Promise<ResumePinResult>;
  randomUUID(): string;
  agentOpenedSessions: Set<string>;
  agentSessionTitles: Map<string, string>;
  /** Live tab list, for handle-uniqueness checks against live sessions. */
  listTabs(): ReadonlyArray<{ sessionId: string }>;
}

/**
 * The full `create_session` admission + creation path. Mirrors the previous
 * `main/index.ts` closure exactly; the wiring (this function + the real deps
 * bag) lives in `main/index.ts`, and `create-session-by-agent.test.ts` drives
 * this function with two connections to prove a non-active pin is primed
 * before the fork, and that a priming failure refuses with a safe reason.
 */
export async function createSessionForAgent(
  request: CreateSessionRequest,
  deps: CreateSessionByAgentDeps,
): Promise<CreateSessionOutcome> {
  const projects = deps.projects;
  const tabs = deps.manager();
  const sessions = deps.sessions();
  if (projects === null || tabs === null || sessions === null) return { ok: false, reason: "not_ready" };
  const key = canonicalWorkspaceKey(request.workspace, deps.realpathSync);
  if (!projects.isAllowed(key)) return { ok: false, reason: "not_allowed" };
  const trust = await deps.readTrustStore();
  if (trust.folders[key]?.decision !== "trusted") return { ok: false, reason: "not_trusted" };
  if (tabs.atCapacity()) return { ok: false, reason: "too_many" };
  const engine = request.engine ?? "core";
  try {
    await deps.mcpSecretPrime(key);
  } catch {
    return { ok: false, reason: "not_ready" };
  }
  /**
   * for the CORE engine `model` selects the provider CONNECTION,
   * not an engine argv (see resolveCoreConnectionForModel).
   */
  let connectionId = engine === "core" ? deps.currentSettings().provider.activeConnectionId : undefined;
  let modelOverride: string | undefined;
  if (engine === "core" && request.model !== undefined) {
    const resolved = resolveCoreConnectionForModel(deps.currentSettings(), request.model);
    if (!resolved.ok) {
      return { ok: false, reason: "invalid_model", detail: resolved.detail };
    }
    connectionId = resolved.connectionId;
    modelOverride = resolved.model;
  }
  /**
   * a tab pinned to a NON-active connection spawns with that
   * connection's cached env; a cache miss is fail-closed (crash_looped). Prime
   * + reserve the pin BEFORE createTab. A priming failure is a clean refusal,
   * never a crashed tab, and carries a safe, actionable reason.
   */
  const pin = await deps.primeNewSessionPin(
    engine === "core" ? connectionId : undefined,
    deps.currentSettings().provider.activeConnectionId,
    deps.resolveResumePin,
  );
  if (!pin.ok) {
    return pin.reason === "connection_missing"
      ? { ok: false, reason: "invalid_model", detail: `connection ${pin.connectionId ?? "?"} no longer exists` }
      : { ok: false, reason: "not_ready", detail: pin.detail };
  }
  const releasePin = pin.release;
  let created: ReturnType<TabHostManager["createTab"]>;
  try {
    created = tabs.createTab({
      workspace: key,
      sessionId: deps.randomUUID(),
      resume: false,
      engine,
      ...(engine !== "core" && request.model !== undefined ? { engineModel: request.model } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
    });
  } finally {
    releasePin();
  }
  if (!created.ok) {
    // GitHub #6: the folder can vanish between the server's realpath check and
    // this asynchronous preparation (trust, secrets, connection priming). Main's
    // createTab then rolls the half-made tab (and its binding) back instead of
    // reporting a session that can never receive a message; propagate that as
    // the folder refusal, not the generic not_ready. Nothing was registered and
    // the caller's rate budget stays unspent (only `ok` creations count).
    if (created.reason === "folder_not_found") return { ok: false, reason: "folder_not_found" };
    return { ok: false, reason: created.reason === "max_tabs" ? ("too_many" as const) : ("not_ready" as const) };
  }
  const sessionId = created.tab.sessionId;
  deps.agentOpenedSessions.add(sessionId);
  // Registered synchronously by createTab (onSessionRegistered); "shared immediately".
  sessions.set(sessionId, true);
  let handle: string | undefined;
  if (request.handle !== undefined) {
    const normalized = normalizeHandle(request.handle);
    if (normalized.ok && normalized.handle !== null) {
      const isLive = (id: string) => deps.listTabs().some((tab) => tab.sessionId === id);
      if (sessions.setHandle(sessionId, normalized.handle, isLive).ok) handle = normalized.handle;
    }
  }
  if (handle !== undefined) deps.agentSessionTitles.set(sessionId, handle);
  tabs.deliverTabPort(created.tab);
  return { ok: true, sessionId, tabId: created.tab.tabId, ...(handle !== undefined ? { handle } : {}) };
}
