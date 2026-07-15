/**
 * TabHostManager (design/phase-2.md §2.2): the multi-host generalization of the
 * MVP single-host lifecycle. One window / one renderer / N host utilityProcesses
 * — one per tab, each with its own MessageChannelMain. Main stays thin: no agent
 * logic, only host lifecycle + channel routing + the session<->tab binding.
 *
 * The MVP module-level singletons (`host`, `hostSpawnedAt`, `rapidRespawns`,
 * `workspace`, `quitting`) collapse into a `TabHost` record + this manager. Each
 * tab carries its own circuit-breaker state; a global storm-breaker sits on top.
 *
 * Runtime-electron-free by construction: every Electron value (utilityProcess,
 * MessageChannelMain, the BrowserWindow) is INJECTED via `TabHostManagerDeps`,
 * and Electron is referenced type-only. That is what lets the breaker/accounting
 * logic (`decideRespawn`) and the manager itself be unit-tested under node
 * (vitest) with a fake fork, without ever spawning a real process.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { MessagePortMain, UtilityProcess } from "electron";
import {
  CREDENTIAL_REQUEST_TYPE,
  CREDENTIAL_RESPONSE_TYPE,
  type CredentialResponse,
} from "../shared/credentials.js";
import { HOST_EXITED_ENVELOPE_TYPE, PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { ENV_CONNECTION_ID } from "./host-env.js";
import type { CloseTabResult } from "../shared/tabs.js";
import {
  ENGINE_PROCESS_REGISTRATION_TYPE,
  type EngineId,
  type EngineProcessRegistration,
} from "../shared/engines.js";
import { TERMINAL_INIT_MESSAGE_TYPE, TERMINAL_PORT_ENVELOPE_TYPE } from "../shared/terminal.js";
import {
  WORKTREE_CLEANUP_ENV,
  WORKTREE_TRANSITION_MESSAGE_TYPE,
  type WorktreeCleanupIntent,
  type WorktreeIdentity,
  type WorktreeTransitionMessage,
} from "../shared/worktrees.js";

/**
 * Control-plane message types on the main<->host parentPort channel (mirrors the
 * MVP constants that lived in main/index.ts). The host matches `shutdown` on
 * `data.type` (load-bearing); it ignores the init `type` and reads only
 * `event.ports[0]`, so `init` is cosmetic to it but kept for parity.
 */
const HOST_INIT_MESSAGE_TYPE = "anycode:init";
const HOST_SHUTDOWN_MESSAGE_TYPE = "shutdown";

/**

 * them; production uses the defaults.
 *  - minHealthyUptimeMs / maxRapidRespawns: the MVP per-tab circuit breaker
 *    (RESPAWN_MIN_HEALTHY_UPTIME_MS=2000 / MAX_RAPID_RESPAWNS=5).
 *  - globalMaxRapidRespawns: the storm-breaker cap on total forks within one
 *    storm window across ALL tabs (a broken build crashes every tab at once;
 *    12 ≈ two tabs each maxing their per-tab budget of 6 forks).


 *    >= SIGKILL_GRACE_MS 750 + teardown headroom, preserved per-tab).
 */
export interface BreakerLimits {
  minHealthyUptimeMs: number;
  maxRapidRespawns: number;
  globalMaxRapidRespawns: number;
  maxTabs: number;
  exitDeadlineMs: number;
}

export const DEFAULT_BREAKER_LIMITS: BreakerLimits = {
  minHealthyUptimeMs: 2000,
  maxRapidRespawns: 5,
  globalMaxRapidRespawns: 12,
  maxTabs: 8,
  exitDeadlineMs: 2000,
};

/**
 * Synchronous refcount of pinned connections a resume has RESERVED but not yet
 * registered a live tab for (TASK.45 W10-FIX F3, layer a). `resolveResumePin`
 * reserves a pin BEFORE the first await of its env-prime and releases it once
 * `manager.createTab` has registered the tab (or on any failure), so the pin is
 * continuously "in use" — reserved OR registered — with no TOCTOU gap a
 * concurrent connection-delete could slip through. Kept a pure factory (no
 * Electron) so the refcount semantics are unit-testable directly; `main/index.ts`
 * owns the single instance and unions it with the registered set for the
 * delete-guard (`connectionInUse` = registered ∪ pending).
 */
export interface PinReservations {
  /** Reserves one in-flight hold on `connectionId` (refcount +1). */
  reserve(connectionId: string): void;
  /** Releases one hold (refcount -1; the key is dropped at zero). Never goes negative. */
  release(connectionId: string): void;
  /** True while at least one hold is outstanding for `connectionId`. */
  has(connectionId: string): boolean;
}

export function createPinReservations(): PinReservations {
  const counts = new Map<string, number>();
  return {
    reserve(connectionId: string): void {
      counts.set(connectionId, (counts.get(connectionId) ?? 0) + 1);
    },
    release(connectionId: string): void {
      const next = (counts.get(connectionId) ?? 0) - 1;
      if (next > 0) {
        counts.set(connectionId, next);
      } else {
        counts.delete(connectionId);
      }
    },
    has(connectionId: string): boolean {
      return (counts.get(connectionId) ?? 0) > 0;
    },
  };
}

/** Bounds a draft engine id before it becomes argv; mirrors the host-side parser's own bound. */
const MAX_ENGINE_ARG_LENGTH = 128;

/**
 * An id-shaped argv value, or null. This is a SHAPE guard, not a validation: main
 * has no catalog and no preset table, and must not pretend to — an id that
 * survives this is still checked by the host against the live catalog/table
 * (host-authoritative, TASK.39 DoD-4). It only refuses values that could not be
 * an id at all (empty, oversized, whitespace-bearing) so junk never reaches argv.
 */
function argvId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ENGINE_ARG_LENGTH || /\s/.test(trimmed)) return null;
  return trimmed;
}

function canonicalWorkspace(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** A tab's host process + its lifecycle/breaker state (design §2.2). */
export interface TabHost {
  /** uuid, lives from createTab to closeTab. */
  tabId: string;
  /** = host cwd, known before fork. */
  workspace: string;
  /** Stable project grouping identity while workspace may relocate. */
  projectRoot: string;
  worktree?: WorktreeIdentity;
  /** Delivered once to the first host booted after an exit transition. */
  pendingWorktreeCleanup?: WorktreeCleanupIntent;
  /* */
  sessionId: string;
  /**
   * The provider connection pinned to this session (TASK.45 W10, core engine
   * only). Fixed at createTab from the active connection (new) or the session's
   * stored connectionId (resume), and retained across every respawn — a respawn
   * never silently follows a default-switch to another account. Absent = a
   * legacy/unpinned tab (env-override boot, or a pre-W10 resumed session):
   * the host runs on the current default and no ANYCODE_CONNECTION_ID is stamped.
   */
  connectionId?: string;
  /** Engine choice is main-owned and retained across every host respawn. */
  engine: EngineId;
  /**
   * The draft (pre-session) engine model/preset choice, forwarded to the host as
   * argv on the FIRST spawn of a NEW session only (TASK.39, cut §3.8). Never on a
   * resume or a respawn: from then on the session row is the authority, and
   * re-imposing a stale draft would silently undo a mid-session change the user
   * made. Both are opaque ids here — main validates NOTHING; the host checks them
   * against the live model catalog / frozen preset table (host-authoritative).
   */
  engineModel: string | null;
  enginePreset: string | null;
  proc: UtilityProcess | null;
  /** Monotonic generation of this tab's utility-process instance. */
  hostGeneration: number;
  /** A future external-engine child group, accepted only for this exact host generation. */
  engineProcess: EngineProcessRegistration | null;
  /** Wall-clock spawn time of the current host, for the per-tab breaker. */
  spawnedAt: number;
  /** Consecutive rapid (sub-healthy-uptime) crashes; reset by any healthy run. */
  rapidRespawns: number;
  state: "running" | "crash_looped" | "closing";
  /**
   * Whether this tab was opened as a resume (first spawn uses --resume) vs a new

   */
  initialResume: boolean;
}

/**
 * Pure respawn decision + counter accounting for a single host exit (design

 * the current per-tab + global-storm counters, applies the returned counters,
 * and performs (or skips) the fork.
 *
 * Semantics:
 *  - Healthy run (uptime >= minHealthyUptimeMs): always respawn; clears BOTH the
 *    per-tab counter and the global storm window (`resetStorm`).
 *  - Rapid crash: per-tab counter increments; exceeding maxRapidRespawns gives
 *    up on THIS tab. Otherwise, if the global storm window has already reached
 *    globalMaxRapidRespawns forks, give up (storm). Otherwise respawn.
 *
 * The global storm counter is a fork counter, not a crash counter: the caller
 * increments it on every actual fork (spawnTabHost), so a rapid crash-loop
 * across N tabs performs at most globalMaxRapidRespawns total forks before every
 * tab gives up. A healthy run of any tab opens a fresh window.
 */
export type RespawnDecision =
  | { action: "respawn"; rapidRespawns: number; resetStorm: boolean }
  | {
      action: "give_up";
      reason: "per_tab_crash_loop" | "global_storm";
      rapidRespawns: number;
      resetStorm: boolean;
    };

export function decideRespawn(args: {
  uptimeMs: number;
  rapidRespawns: number;
  stormForks: number;
  limits?: Partial<BreakerLimits>;
}): RespawnDecision {
  const limits = { ...DEFAULT_BREAKER_LIMITS, ...args.limits };
  if (args.uptimeMs >= limits.minHealthyUptimeMs) {
    return { action: "respawn", rapidRespawns: 0, resetStorm: true };
  }
  const rapidRespawns = args.rapidRespawns + 1;
  if (rapidRespawns > limits.maxRapidRespawns) {
    return { action: "give_up", reason: "per_tab_crash_loop", rapidRespawns, resetStorm: false };
  }
  if (args.stormForks >= limits.globalMaxRapidRespawns) {
    return { action: "give_up", reason: "global_storm", rapidRespawns, resetStorm: false };
  }
  return { action: "respawn", rapidRespawns, resetStorm: false };
}

/** Fork options for the host utilityProcess (cwd = the tab's workspace). */
export interface HostForkOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit";
}

/** Injected wrapper over utilityProcess.fork (real) / a fake (tests). */
export type HostForkFn = (
  entry: string,
  args: readonly string[],
  opts: HostForkOptions,
) => UtilityProcess;

/** A fresh MessageChannel: port1 -> host, port2 -> renderer. */
export interface TabChannel {
  port1: MessagePortMain;
  port2: MessagePortMain;
}

/** Minimal structural view of the window the manager posts envelopes into. */
export interface WebContentsLike {
  postMessage(channel: string, message: unknown, transfer?: MessagePortMain[]): void;
  send(channel: string, ...args: unknown[]): void;
}
export interface WindowLike {
  isDestroyed(): boolean;
  webContents: WebContentsLike;
}

export interface TabLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface TabHostManagerDeps {
  /** utilityProcess.fork (or a fake). */
  fork: HostForkFn;
  /** Resolved host entry script path. */
  hostEntry: string;
  /** new MessageChannelMain() (or a fake). */
  createChannel: () => TabChannel;
  /** The renderer window, or null when there is none (destroyed/pre-create). */
  getWindow: () => WindowLike | null;
  /**

   * its current host env so a key rotation persisted to the vault is picked up by
   * the next respawn without a manager restart. Defaults to `() => process.env`.
   *
   * TASK.45 W10: main resolves the env for a SPECIFIC pinned connection id when
   * given one (a resumed non-active connection, or a tab whose default has since
   * changed), falling back to the active-connection env for `undefined`. Called
   * at every spawn/respawn with `tab.connectionId`, so a mutation-refreshed
   * per-connection env (fresh key after a replace) is picked up on respawn.
   *
   * TASK.45 W10-FIX F3 (layer c, fail-closed fork): returns `undefined` for a
   * pinned NON-active connection whose per-connection env is unavailable (its
   * connection was deleted out from under a mid-flight resume). The spawn path
   * REFUSES to fork on `undefined` rather than falling back to the active
   * connection's env — forking with one connection's credentials while stamping
   * ANOTHER connection's ANYCODE_CONNECTION_ID is the custody defect this closes.
   */
  env?: (connectionId?: string) => NodeJS.ProcessEnv | undefined;
  /**

   * refuses with `not_ready` instead of spawning a keyless host. Absent = always
   * ready (preserves the pre-2.2 behaviour).
   */
  providerReady?: () => boolean;
  /** Availability of a reviewed non-core engine; defaults fail-closed. */
  engineReady?: (engine: EngineId) => boolean;
  /** Fresh, engine-specific host-env overlay. It must contain no credentials. */
  engineEnv?: (engine: EngineId, generation: number) => NodeJS.ProcessEnv;
  /**
   * Platform-specific group reaper. Not wired until W0 process-tree evidence
   * exists; tests inject it to prove ownership and stale-message rejection.
   */
  reapEngineProcess?: (registration: EngineProcessRegistration) => void;
  /**
   * Resolves a fresh credential for a host's credential-request (design §3.3,
   * slice 2.5). main injects `() => TokenBroker.getAccessToken(selectedOauthId)`;
   * the resolved token is posted back to the SAME host process (per-proc routing —
   * the host is tab-agnostic). Absent OR resolving `undefined` -> the response
   * carries no `apiKey` and the host falls back to its fork's static env key.
   * Only oauth-mode hosts ever send a request; api_key hosts never do.
   *
   * TASK.45 W10: called with the requesting tab's pinned `connectionId` so the
   * fresh oauth token is minted for THAT connection, not merely the current
   * active one (a resumed session stays on its own account).
   */
  resolveCredential?: (connectionId?: string) => Promise<string | undefined>;
  /**
   * A core host's real request outcome for its pinned connection (TASK.45 W11:
   * runtime auth failure/rate limit/network-server error/successful generation).
   * Called ONLY for a tab with a `connectionId` — an unpinned (legacy) tab has no
   * saved plaquette to paint, so its event is dropped here rather than forwarded
   * with an undefined id. Absent = health tracking off (legacy tests unaffected).
   */
  onProviderHealthEvent?: (connectionId: string, event: ProviderHealthEvent) => void;
  now?: () => number;
  genId?: () => string;
  limits?: Partial<BreakerLimits>;
  logger?: TabLogger;
}

export type CreateTabResult =
  | { ok: true; tab: TabHost }
  | { ok: false; reason: "max_tabs" | "already_open" | "not_ready"; focusTabId?: string };

export type { CloseTabResult };

/**
 * Read-only main-plane view of one live tab (design/phase-2-smoke-channel.md
 * §3.1/§4.1): the smoke channel puts this beside the renderer-plane snapshot so
 * a divergence is itself assertable. `pid` (the host utilityProcess pid) lets
 * the smoke matrix target a specific tab's host with `kill -9` in the crash
 * cases (V8), and `state` exposes the breaker verdict (running/crash_looped/
 * closing) that the renderer never sees.
 */
export interface TabSummary {
  tabId: string;
  workspace: string;
  sessionId: string;
  state: TabHost["state"];
  pid: number | null;
}

export class TabHostManager {
  private readonly tabs = new Map<string, TabHost>();
  /* */
  private readonly bindings = new Map<string, string>();
  private readonly limits: BreakerLimits;
  private readonly env: (connectionId?: string) => NodeJS.ProcessEnv | undefined;
  private readonly isReady: () => boolean;
  private readonly isEngineReady: (engine: EngineId) => boolean;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly logger: TabLogger;
  /** Fork count within the current storm window; reset by any healthy run. */
  private stormForks = 0;
  /** Set once quit begins: suppresses all respawn and host-exited notifications. */
  private quitting = false;

  constructor(private readonly deps: TabHostManagerDeps) {
    this.limits = { ...DEFAULT_BREAKER_LIMITS, ...deps.limits };
    this.env = deps.env ?? (() => process.env);
    this.isReady = deps.providerReady ?? (() => true);
    this.isEngineReady = deps.engineReady ?? ((engine) => engine === "core" && this.isReady());
    this.now = deps.now ?? Date.now;
    this.genId = deps.genId ?? randomUUID;
    this.logger = deps.logger ?? console;
  }

  /** Number of live tabs. */
  count(): number {
    return this.tabs.size;
  }

  /**
   * Read-only snapshot of every live tab's main-plane facts (design
   * §3.1/§4.1). Additive, no side effects — the automation server's `GET
   * /state` reads this to sit the pid/state main-view next to the renderer's
   * store projection.
   */
  listTabs(): ReadonlyArray<TabSummary> {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.tabId,
      workspace: tab.workspace,
      sessionId: tab.sessionId,
      state: tab.state,
      pid: tab.proc?.pid ?? null,
    }));
  }

  atCapacity(): boolean {
    return this.tabs.size >= this.limits.maxTabs;
  }

  /**

   * the tab-ipc create path can refuse `not_ready` BEFORE prompting for a
   * workspace; createTab enforces it authoritatively regardless.
   */
  canSpawn(engine: EngineId = "core"): boolean {
    return this.isEngineReady(engine);
  }

  getTab(tabId: string): TabHost | undefined {
    return this.tabs.get(tabId);
  }

  /* */
  sessionOpenInTab(sessionId: string): string | undefined {
    return this.bindings.get(sessionId);
  }

  /**
   * The set of provider connection ids pinned to a LIVE session (TASK.45 W10).
   * Main reads it to (a) keep each pinned connection's fork-env fresh across a
   * settings mutation, and (b) refuse deleting a connection an open session still
   * depends on (delete-guard). Excludes legacy/unpinned tabs (no connectionId).
   */
  pinnedConnectionIds(): Set<string> {
    const ids = new Set<string>();
    for (const tab of this.tabs.values()) {
      if (tab.connectionId !== undefined) {
        ids.add(tab.connectionId);
      }
    }
    return ids;
  }

  /**
   * Creates a tab, binds its session, and spawns the first host. Enforces the
   * session->tab binding (already_open) and MAX_TABS. Does NOT deliver the port
   * — the caller does that once (createTab flow) after the renderer exists.
   */
  createTab(params: {
    workspace: string;
    projectRoot?: string;
    worktree?: WorktreeIdentity;
    sessionId: string;
    resume: boolean;
    engine?: EngineId;
    /** Draft engine model/preset ids (TASK.39). Opaque here; the host validates them. */
    engineModel?: string;
    enginePreset?: string;
    /** Pinned provider connection (TASK.45 W10, core only); stamped into the fork env + persisted by the host. */
    connectionId?: string;
  }): CreateTabResult {

    // secret-clear on an open window lets `+` spawn a host with no provider key.
    const engine = params.engine ?? "core";
    if (!this.canSpawn(engine)) {
      return { ok: false, reason: "not_ready" };
    }
    const existing = this.bindings.get(params.sessionId);
    if (existing !== undefined) {
      return { ok: false, reason: "already_open", focusTabId: existing };
    }
    if (this.atCapacity()) {
      return { ok: false, reason: "max_tabs" };
    }
    const workspace = canonicalWorkspace(params.workspace);
    const projectRoot = canonicalWorkspace(params.projectRoot ?? params.workspace);
    const worktree = params.worktree === undefined
      ? undefined
      : { ...params.worktree, path: canonicalWorkspace(params.worktree.path) };
    const tab: TabHost = {
      tabId: this.genId(),
      workspace,
      projectRoot,
      ...(worktree !== undefined ? { worktree } : {}),
      sessionId: params.sessionId,
      ...(params.connectionId !== undefined ? { connectionId: params.connectionId } : {}),
      engine,
      engineModel: argvId(params.engineModel),
      enginePreset: argvId(params.enginePreset),
      proc: null,
      hostGeneration: 0,
      engineProcess: null,
      spawnedAt: 0,
      rapidRespawns: 0,
      state: "running",
      initialResume: params.resume,
    };
    this.tabs.set(tab.tabId, tab);
    this.bindings.set(params.sessionId, tab.tabId);
    this.spawnTabHost(tab, { firstSpawn: true });
    return { ok: true, tab };
  }

  /**
   * Forks the host for a tab with the session-bearing argv (§3.5): first spawn
   * of a new session uses `--session <id>`, a resume or ANY respawn uses

   */
  private spawnTabHost(tab: TabHost, opts: { firstSpawn: boolean }): void {
    const resume = tab.initialResume || !opts.firstSpawn;
    const args = resume ? ["--resume", tab.sessionId] : ["--session", tab.sessionId];
    // TASK.39: the draft choice rides argv only on the spawn that CREATES the
    // session. Every later spawn is a `--resume`, where the persisted session row
    // is the authority — replaying the draft there would resurrect it over a
    // mid-session change. argv is an array (no shell), and the ids were bounded
    // at createTab; the host validates them regardless.
    if (!resume) {
      if (tab.engineModel !== null) args.push("--engine-model", tab.engineModel);
      if (tab.enginePreset !== null) args.push("--engine-preset", tab.enginePreset);
    }
    // TASK.45 W10-FIX F3 (layer c): resolve the pinned base env BEFORE forking. A
    // `undefined` here means the tab is pinned to a connection whose per-connection
    // env is no longer available (deleted mid-resume). Refuse to fork rather than
    // silently fall back to the active connection's env while still stamping this
    // pin's ANYCODE_CONNECTION_ID — that would run the WRONG account's credentials
    // under this pin (the custody defect). Surface it as a host-exit so the
    // renderer's replacement flow (F1) can recover; never respawn a refused fork.
    const baseEnv = this.env(tab.connectionId);
    if (baseEnv === undefined) {
      this.logger.error(
        `[main] tab ${tab.tabId} pinned to unavailable connection ${tab.connectionId ?? "?"}; refusing to spawn`,
      );
      tab.proc = null;
      tab.state = "crash_looped";
      this.notifyHostExited(tab.tabId);
      return;
    }
    tab.hostGeneration += 1;
    tab.engineProcess = null;
    const cleanup = tab.pendingWorktreeCleanup;
    const child = this.deps.fork(this.deps.hostEntry, args, {
      cwd: tab.workspace,
      env: {
        // TASK.45 W10: base env resolved for THIS tab's pinned connection (main
        // keeps a per-connection env fresh across mutations); ANYCODE_CONNECTION_ID
        // is stamped per-fork from `tab.connectionId` (never baked into the shared
        // base env — a legacy/unpinned tab must not inherit another tab's pin).
        ...baseEnv,
        ...(tab.connectionId !== undefined ? { [ENV_CONNECTION_ID]: tab.connectionId } : {}),
        ...(this.deps.engineEnv?.(tab.engine, tab.hostGeneration) ?? {}),
        ...(cleanup !== undefined ? { [WORKTREE_CLEANUP_ENV]: JSON.stringify(cleanup) } : {}),
      },
      stdio: "inherit",
    });
    tab.proc = child;
    tab.spawnedAt = this.now();
    tab.state = "running";
    delete tab.pendingWorktreeCleanup;
    this.stormForks += 1;

    child.on("spawn", () => {
      this.logger.log(`[main] tab ${tab.tabId} host spawned (pid ${child.pid ?? "?"})`);
    });
    child.once("exit", (code: number) => {
      this.handleExit(tab, child, code);
    });
    // Credential channel (design §3.3): an oauth-mode host asks main for a fresh
    // access token per attempt; main answers THIS proc (per-proc routing).
    child.on("message", (message: unknown) => {
      void this.handleHostMessage(tab, child, message);
    });
  }

  /**
   * Answers a host's control-plane message on the parentPort channel. Only the
   * credential-request is handled (anything else is ignored); main resolves the
   * token via the injected `resolveCredential` and posts a CREDENTIAL_RESPONSE

   * on the response, correlated by `requestId`.
   */
  private async handleHostMessage(tab: TabHost, child: UtilityProcess, message: unknown): Promise<void> {
    if (message === null || typeof message !== "object") {
      return;
    }
    const data = message as { type?: unknown; requestId?: unknown };
    if (data.type === WORKTREE_TRANSITION_MESSAGE_TYPE) {
      await this.relocateTab(tab, child, message as WorktreeTransitionMessage);
      return;
    }
    if (data.type === ENGINE_PROCESS_REGISTRATION_TYPE) {
      this.registerEngineProcess(tab, child, message);
      return;
    }
    if (data.type === PROVIDER_HEALTH_EVENT_TYPE) {
      // TASK.45 W11: bind to THIS proc's pinned connectionId — never the active
      // one, never a sibling tab's. No pin (legacy/env-override boot) -> nothing
      // to paint, the event is dropped.
      if (tab.connectionId !== undefined) {
        this.deps.onProviderHealthEvent?.(tab.connectionId, message as ProviderHealthEvent);
      }
      return;
    }
    if (data.type !== CREDENTIAL_REQUEST_TYPE || typeof data.requestId !== "string") {
      return;
    }
    const requestId = data.requestId;
    let apiKey: string | undefined;
    try {
      apiKey =
        this.deps.resolveCredential !== undefined ? await this.deps.resolveCredential(tab.connectionId) : undefined;
    } catch (error) {
      this.logger.warn(`[main] credential resolution failed`, error);
      apiKey = undefined;
    }
    const response: CredentialResponse = {
      type: CREDENTIAL_RESPONSE_TYPE,
      requestId,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
    try {
      child.postMessage(response);
    } catch (error) {
      this.logger.warn(`[main] failed to post credential response`, error);
    }
  }

  /** Gracefully replaces one host with a resume host rooted at the transition target. */
  private async relocateTab(
    tab: TabHost,
    child: UtilityProcess,
    message: WorktreeTransitionMessage,
  ): Promise<void> {
    const current = tab.proc === child;
    const entering = message.worktree !== undefined;
    const cleanupShapeValid = message.cleanup === undefined || (
      message.cleanup.path === message.fromWorkspace &&
      (!message.cleanup.ownedByAnyCode || message.cleanup.branch === undefined || (
        tab.worktree?.ownedByAnyCode === true &&
        message.cleanup.branch === tab.worktree.branch
      ))
    );
    const shapeValid = entering
      ? message.toWorkspace === message.worktree!.path && message.cleanup === undefined
      : message.toWorkspace === message.projectRoot &&
        cleanupShapeValid;
    const valid =
      current &&
      tab.state === "running" &&
      message.sessionId === tab.sessionId &&
      message.fromWorkspace === tab.workspace &&
      message.projectRoot === tab.projectRoot &&
      shapeValid &&
      typeof message.toWorkspace === "string" &&
      message.toWorkspace.length > 0 &&
      typeof message.projectRoot === "string" &&
      message.projectRoot.length > 0;
    if (!valid) {
      this.logger.warn(`[main] rejected stale or malformed worktree transition for tab ${tab.tabId}`);
      return;
    }
    await this.shutdownTabHost(tab);
    tab.workspace = message.toWorkspace;
    tab.projectRoot = message.projectRoot;
    if (message.worktree !== undefined) tab.worktree = message.worktree;
    else delete tab.worktree;
    if (message.cleanup !== undefined && message.cleanup.mode !== "keep") {
      tab.pendingWorktreeCleanup = message.cleanup;
    } else {
      delete tab.pendingWorktreeCleanup;
    }
    tab.initialResume = true;
    tab.rapidRespawns = 0;
    this.spawnTabHost(tab, { firstSpawn: false });
    this.deliverTabPort(tab);
  }

  /**
   * Host exit handler (per-tab, mirrors the MVP single-host logic). Ignores
   * expected exits (quit / graceful close) and stale exits from an
   * already-replaced host; otherwise notifies the page, runs the breaker, and
   * respawns (with a fresh channel) unless a per-tab or global breaker tripped.
   */
  private handleExit(tab: TabHost, child: UtilityProcess, code: number): void {
    this.reapEngineProcess(tab, child);
    if (this.quitting || tab.state === "closing") {
      this.logger.log(`[main] tab ${tab.tabId} host exited during shutdown (code ${code})`);
      return;
    }
    if (tab.proc !== child) {
      // Stale exit from an already-replaced host; ignore.
      return;
    }
    tab.proc = null;

    const uptime = this.now() - tab.spawnedAt;
    const decision = decideRespawn({
      uptimeMs: uptime,
      rapidRespawns: tab.rapidRespawns,
      stormForks: this.stormForks,
      limits: this.limits,
    });
    tab.rapidRespawns = decision.rapidRespawns;
    if (decision.resetStorm) {
      this.stormForks = 0;
    }


    // its host-exited banner and awaits the replacement port below.
    this.notifyHostExited(tab.tabId);

    if (decision.action === "give_up") {
      tab.state = "crash_looped";
      this.logger.error(
        `[main] tab ${tab.tabId} host giving up respawn (${decision.reason}, code ${code})`,
      );
      return;
    }

    this.logger.error(`[main] tab ${tab.tabId} host exited unexpectedly (code ${code}); respawning`);
    this.spawnTabHost(tab, { firstSpawn: false });
    this.deliverTabPort(tab);
  }

  /**
   * Registers an external engine process only if the reporting utility process
   * is still this tab's live child and its host pid/generation agree. A stale
   * child cannot replace the new generation's reaper target.
   */
  private registerEngineProcess(tab: TabHost, child: UtilityProcess, message: unknown): void {
    const data = message as Partial<EngineProcessRegistration>;
    const valid =
      typeof data.hostPid === "number" &&
      typeof data.generation === "number" &&
      typeof data.enginePid === "number" &&
      typeof data.pgid === "number" &&
      Number.isInteger(data.hostPid) &&
      Number.isInteger(data.generation) &&
      Number.isInteger(data.enginePid) &&
      Number.isInteger(data.pgid) &&
      data.hostPid > 0 &&
      data.enginePid > 0 &&
      data.pgid > 0;
    if (!valid || tab.proc !== child || child.pid !== data.hostPid || tab.hostGeneration !== data.generation) {
      this.logger.warn(`[main] rejected stale or malformed engine-process registration for tab ${tab.tabId}`);
      return;
    }
    tab.engineProcess = {
      hostPid: data.hostPid!,
      generation: data.generation!,
      enginePid: data.enginePid!,
      pgid: data.pgid!,
    };
  }

  private reapEngineProcess(tab: TabHost, child: UtilityProcess): void {
    const registration = tab.engineProcess;
    if (
      registration === null ||
      tab.proc !== child ||
      child.pid !== registration.hostPid ||
      tab.hostGeneration !== registration.generation
    ) {
      return;
    }
    tab.engineProcess = null;
    try {
      this.deps.reapEngineProcess?.(registration);
    } catch (error) {
      this.logger.warn(`[main] failed to reap external engine for tab ${tab.tabId}`, error);
    }
  }

  private notifyHostExited(tabId: string): void {
    const win = this.deps.getWindow();
    if (win === null || win.isDestroyed()) {
      return;
    }
    win.webContents.send(HOST_EXITED_ENVELOPE_TYPE, { tabId });
  }

  /**
   * Delivers a fresh MessageChannel to one tab's host + the renderer (design
   * §2.2, former deliverPorts): port1 -> host over parentPort (init), port2 ->
   * renderer via webContents.postMessage carrying { tabId, workspace } (§3.1).
   *
   * Slice 2.4.2 (design §3.2): additively delivers a SECOND, disjoint
   * MessageChannel for the per-tab terminal alongside the UI one above — same
   * guards (no proc / no window -> skip BOTH), same redelivery points (initial
   * delivery, respawn, deliverAllTabPorts), zero changes to the UI channel's
   * bytes. term-port1 goes to the host tagged with TERMINAL_INIT_MESSAGE_TYPE
   * (host/terminal.ts, task 2.4.3, recognizes the marker and binds the port);
   * term-port2 goes to the renderer as a { tabId }-keyed envelope on the
   * TERMINAL_PORT_ENVELOPE_TYPE channel (renderer routing is task 2.4.4). The
   * host stays tab-agnostic on the term channel — no tabId travels on it.
   */
  deliverTabPort(tab: TabHost): void {
    if (tab.proc === null) {
      this.logger.warn(`[main] deliverTabPort skipped: tab ${tab.tabId} has no host`);
      return;
    }
    const win = this.deps.getWindow();
    if (win === null || win.isDestroyed()) {
      this.logger.warn(`[main] deliverTabPort skipped: no window`);
      return;
    }
    const channel = this.deps.createChannel();
    tab.proc.postMessage({ type: HOST_INIT_MESSAGE_TYPE }, [channel.port1]);
    win.webContents.postMessage(
      PORT_ENVELOPE_TYPE,
      { tabId: tab.tabId, workspace: tab.workspace },
      [channel.port2],
    );
    this.logger.log(`[main] delivered fresh MessageChannel to tab ${tab.tabId}`);

    const termChannel = this.deps.createChannel();
    tab.proc.postMessage({ type: TERMINAL_INIT_MESSAGE_TYPE }, [termChannel.port1]);
    win.webContents.postMessage(TERMINAL_PORT_ENVELOPE_TYPE, { tabId: tab.tabId }, [
      termChannel.port2,
    ]);
    this.logger.log(`[main] delivered fresh terminal MessageChannel to tab ${tab.tabId}`);
  }

  /** Fresh channel to EVERY live host (design §2.2, on did-finish-load). */
  deliverAllTabPorts(): void {
    for (const tab of this.tabs.values()) {
      if (tab.proc !== null) {
        this.deliverTabPort(tab);
      }
    }
  }

  /**

   * up to exitDeadlineMs for the exit, then force-kill. Marks the tab "closing"
   * first so the exit handler does not respawn it. The host aborts its turn
   * (starting core's SIGTERM->SIGKILL child kill-chain at t=0), so a force-kill
   * at the deadline cannot orphan Bash children.
   */
  async shutdownTabHost(tab: TabHost): Promise<void> {
    const child = tab.proc;
    tab.state = "closing";
    if (child === null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.postMessage({ type: HOST_SHUTDOWN_MESSAGE_TYPE });
    } catch (error) {
      this.logger.error(`[main] tab ${tab.tabId} shutdown: failed to signal host`, error);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.limits.exitDeadlineMs);
    });
    const result = await Promise.race([exited.then(() => "exited" as const), deadline]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (result === "timeout") {
      this.logger.error(
        `[main] tab ${tab.tabId} host did not exit within ${this.limits.exitDeadlineMs}ms; force killing`,
      );
      child.kill();
    } else {
      this.logger.log(`[main] tab ${tab.tabId} host exited gracefully within deadline`);
    }
    tab.proc = null;
  }

  /**
   * Closes a single tab (design §2.2/§4.1): refuses the last remaining tab (no
   * "window with zero hosts" state) and unknown ids; otherwise gracefully shuts
   * the host and drops the tab + its binding.
   */
  async closeTab(tabId: string): Promise<CloseTabResult> {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) {
      return { ok: false, reason: "unknown_tab" };
    }
    if (this.tabs.size <= 1) {
      return { ok: false, reason: "last_tab" };
    }
    await this.shutdownTabHost(tab);
    this.tabs.delete(tabId);
    this.bindings.delete(tab.sessionId);
    return { ok: true };
  }

  /**
   * Shuts every host down in PARALLEL (design §2.2): quit with 8 tabs costs the
   * same ~2s wall-clock as one, because each host aborts its own turn and runs
   * its own SIGTERM->SIGKILL child chain from t=0. Called by before-quit.
   */
  async shutdownAllTabHosts(): Promise<void> {
    this.quitting = true;
    await Promise.allSettled([...this.tabs.values()].map((tab) => this.shutdownTabHost(tab)));
  }

  /**
   * TASK.33 FIX-A dev-only smoke lever: force-kills the tab's current host
   * child WITHOUT marking it "closing" first, so `handleExit`'s normal
   * unexpected-exit path runs unmodified — the exact respawn (breaker
   * accounting, fresh port pair, `--resume`) a real crash triggers. Deliberately
   * distinct from `shutdownTabHost` (which sets `state = "closing"` precisely
   * to SUPPRESS that respawn); this route exists to force the respawn, not
   * avoid it. `tab.proc` can already be null between an exit and its respawn
   * landing — a no-op kill in that narrow window is fine, the respawn is
   * already in flight.
   */
  killHost(tabId: string): { ok: true } | { ok: false; reason: "unknown_tab" } {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) {
      return { ok: false, reason: "unknown_tab" };
    }
    tab.proc?.kill();
    return { ok: true };
  }
}
