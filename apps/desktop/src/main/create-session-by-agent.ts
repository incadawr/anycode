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
  /**
   * Retains the accepted handle as the tab's durable title: pushes it to the
   * host now and keeps it for a retry when that push cannot land (a booting,
   * exiting or respawning host). Optional so a bare test bench stays valid;
   * `agentSessionTitles` is still the in-memory source the sidebar reads.
   */
  pushAgentTitle?(sessionId: string): void;
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
  const sessionId = deps.randomUUID();
  let handle: string | undefined;
  /**
   * Registers everything the FIRST port envelope (and the sidebar) attributes
   * this session by: agent ownership, the shared/exposed flag, and the handle
   * that doubles as the tab title. `deliverTabPort` builds that envelope from
   * live state, so this must run BEFORE the port is delivered — for a deferred
   * first fork that delivery happens inside the fork's own completion, before
   * `createTabAwaitingInitialSpawn` reports (GitHub #6). A SYNCHRONOUS fork has
   * not delivered anything yet at that point, so the success path below calls
   * it before delivering itself.
   */
  const registerAttribution = (): void => {
    deps.agentOpenedSessions.add(sessionId);
    // Registered synchronously by createTab (onSessionRegistered); "shared immediately".
    sessions.set(sessionId, true);
    if (request.handle === undefined) return;
    const normalized = normalizeHandle(request.handle);
    if (!normalized.ok || normalized.handle === null) return;
    const isLive = (id: string) => deps.listTabs().some((tab) => tab.sessionId === id);
    if (!sessions.setHandle(sessionId, normalized.handle, isLive).ok) return;
    handle = normalized.handle;
    deps.agentSessionTitles.set(sessionId, handle);
    // Never awaited or fatal; main retains the title for a later host generation.
    try {
      deps.pushAgentTitle?.(sessionId);
    } catch (error) {
      console.warn("[main] failed to push agent session title", error);
    }
  };
  let created: Awaited<ReturnType<TabHostManager["createTabAwaitingInitialSpawn"]>>;
  try {
    // GitHub #6: the first fork can be parked in a provider refresh. Await its
    // outcome — reporting the session as created before that fork ran let the
    // folder vanish during the wait while the API had already answered with a
    // session that could never receive a message (and spent its creation slot).
    created = await tabs.createTabAwaitingInitialSpawn({
      workspace: key,
      sessionId,
      resume: false,
      engine,
      ...(engine !== "core" && request.model !== undefined ? { engineModel: request.model } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
      // GitHub #6: a deferred fork delivers its port from its own completion,
      // i.e. before this await resolves — the attribution must already be
      // registered for that first envelope to carry the agent badge + title.
      beforeDeferredPortDelivery: () => registerAttribution(),
    });
  } finally {
    releasePin();
  }
  if (!created.ok) {
    // GitHub #6: the folder can vanish between the server's realpath check and
    // this asynchronous preparation (trust, secrets, connection priming) — or
    // while the first fork is parked in a provider refresh. Main then rolls the
    // half-made tab (and its binding) back instead of reporting a session that
    // can never receive a message; propagate that as the folder refusal, not the
    // generic not_ready. Nothing was registered and the caller's rate budget
    // stays unspent (only `ok` creations count).
    if (created.reason === "folder_not_found") return { ok: false, reason: "folder_not_found" };
    return { ok: false, reason: created.reason === "max_tabs" ? ("too_many" as const) : ("not_ready" as const) };
  }
  // A deferred first fork already registered its attribution and delivered its
  // own port from its completion (GitHub #6); a synchronous one has done
  // neither yet. Both must precede the delivery.
  if (created.deferred !== true) {
    registerAttribution();
    tabs.deliverTabPort(created.tab);
  }
  return { ok: true, sessionId, tabId: created.tab.tabId, ...(handle !== undefined ? { handle } : {}) };
}
