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
import type { PermissionMode } from "@anycode/core";
import {
  CREDENTIAL_REQUEST_TYPE,
  CREDENTIAL_RESPONSE_TYPE,
  type CredentialResponse,
} from "../shared/credentials.js";
import { HOST_EXITED_ENVELOPE_TYPE, PORT_ENVELOPE_TYPE } from "../shared/envelopes.js";
import {
  CHILD_PROGRESS_TYPE,
  CHILD_READY_TYPE,
  CHILD_RUNS_GLOBAL_MAX,
  CHILD_RUNS_PER_PARENT_MAX,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_SPAWN_QUEUE_MAX,
  CHILD_SPAWN_REQUEST_TYPE,
  CHILD_START_DEADLINE_MS,
  CHILD_START_TYPE,
  CHILD_TERMINAL_TYPE,
  parseChildProgress,
  parseChildReady,
  parseChildRunCancel,
  parseChildSpawnRequest,
  parseChildTerminal,
  type ChildProgress,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildRunRejectReason,
  type ChildRunStatus,
  type ChildSpawnRequest,
  type ChildStart,
  type ChildTerminal,
} from "../shared/child-sessions.js";
import {
  PREVIEW_ARTIFACTS_TYPE,
  PREVIEW_REQUEST_TYPE,
  type PreviewArtifactsMessage,
  type PreviewRequestMessage,
} from "../shared/preview.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { ENV_CONNECTION_ID, ENV_MODEL } from "./host-env.js";
import type { CloseTabResult } from "../shared/tabs.js";
import {
  ENGINE_PROCESS_REGISTRATION_TYPE,
  ENV_ENGINE,
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
 * Model-visible rejection/terminal texts for the child-session admission path
 * (TASK.102 CUT-S2 §2.6.4/§2.7/§10.8.2). Every text below is now VERBATIM-
 * frozen by a cut authority — review checks byte-for-byte equality, not
 * paraphrase: limit_parent/limit_global/recursion/the provider-not-ready
 * template/closing/spawn_failed/the crash text are §2.7's own wording (the
 * model reads them through `tools/agent.ts`'s outcome mapping);
 * CHILD_ENGINE_NOT_READY_MESSAGE and CHILD_START_TIMEOUT_MESSAGE are
 * §10.8.2 п.1/п.2's ratified REPLACEMENTS of the original S2b build-report
 * wording (that wording stated a fact with no actionable next step); and
 * CHILD_CANCELLED_MESSAGE and CHILD_DUPLICATE_SPAWN_MESSAGE are §10.8.2
 * п.3/п.4's ratifications of the S2b wording AS-IS. None of these four is a
 * main-side style choice.
 */
const CHILD_LIMIT_PARENT_MESSAGE =
  'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".';
const CHILD_LIMIT_GLOBAL_MESSAGE =
  'Agent: application-wide session-subagent limit reached (8 running child sessions). No child was started. Wait for one to finish, or use tier "inline".';
const CHILD_RECURSION_MESSAGE = 'Agent: a child session cannot spawn its own child sessions. Use tier "inline".';
const CHILD_CLOSING_MESSAGE = "Agent: the child session could not be started (host is closing).";
const CHILD_SPAWN_FAILED_MESSAGE = "Agent: the child session failed to start.";
const CHILD_HOST_EXITED_MESSAGE = "Agent: the child session host exited before completing.";
/**
 * §10.8.2 п.1 — ratified verbatim replacement for the builder's fact-only
 * draft: the model gets an explicit next step (only the EXPLICIT-`provider`
 * not_ready variant, `childProviderNotReadyMessage` below, had its own
 * §2.7 template before this ratification).
 */
const CHILD_ENGINE_NOT_READY_MESSAGE =
  'Agent: the core engine is not available in this host, so a child session could not be started. Use tier "inline".';
/**
 * TASK.102 CUT-S4 §3.2 п.2: the core text above stays byte-identical (it is
 * ratified §10.8.2 п.1 wording), so a non-core engine gets its OWN not_ready
 * text that actually names the engine — the core text's "the core engine" is
 * simply false for a claude/codex child.
 */
function childEngineNotReadyMessage(engine: EngineId): string {
  if (engine === "core") {
    return CHILD_ENGINE_NOT_READY_MESSAGE;
  }
  return `Agent: the "${engine}" engine is not available in this host, so a child session could not be started. Use tier "inline".`;
}
/**
 * TASK.102 CUT-S4 §3.2 п.3: main never trusts payload identity (file header)
 * — an engine child is core-side already refused a `provider` (tools/agent.ts
 * §2.2 п.1), and main refuses it independently here rather than resolving it.
 */
const CHILD_ENGINE_PROVIDER_MESSAGE =
  'Agent: "provider" is not valid for an engine child — it runs on its own CLI account, not an AnyCode provider connection.';
/**
 * §10.8.2 п.2 — ratified verbatim replacement: names the load-bearing fact
 * that the builder's draft lost — the prompt only ships to the child on
 * `child-ready` (§2.6.4, held in the ledger until then), so a deadline-miss
 * means the task GUARANTEED never started, and retrying is therefore safe.
 */
const CHILD_START_TIMEOUT_MESSAGE =
  'Agent: the child session did not become ready in time and was shut down; it never started on the task. Retry, or use tier "inline".';
/** §10.8.2 п.3 — ratified verbatim as-is; reused for both the drain-cascade and the explicit `child-run-cancel` path. */
const CHILD_CANCELLED_MESSAGE = "Agent: the child session was cancelled.";
/**
 * §10.11.2's ratified tombstone text for the ADMINISTRATIVE reap: a
 * `drainChildren` deadline expiring on a child whose host was force-killed
 * but never actually exited (or a ghost `childTabId` `cancelChildRun` can
 * never otherwise finalize, cut §0.7's carve-out). Text fixed by the
 * ratification — not a main-side style choice.
 */
const CHILD_UNREAPED_MESSAGE =
  "Agent: the child session was cancelled; its host process did not exit and was abandoned.";
/**
 * §10.8.2 п.4 — ratified verbatim as-is. TASK.102 CUT-S2 §10.5 п.3's
 * in-flight admission-time dedup of a `(parentSessionId, spawnToolCallId)`
 * pair (see `childSpawnKeys` below). Reuses the existing `spawn_failed`
 * reason (§10.5 п.3 names it explicitly) rather than minting a new
 * `ChildRunRejectReason` member.
 */
const CHILD_DUPLICATE_SPAWN_MESSAGE =
  "Agent: a session-subagent for this Agent tool call is already running. Wait for it to finish before retrying.";

function childProviderNotReadyMessage(provider: string): string {
  return `Agent: provider connection "${provider}" is not available in this host. Omit "provider" to use the parent session's connection.`;
}

/**
 * Composite in-flight-dedup key for a `(parentSessionId, spawnToolCallId)`
 * pair (TASK.102 CUT-S2 §10.5 п.3). `\u0000` (NUL) is a safe join
 * character: `shared/child-sessions.ts`'s `isIdString` forbids C0 control
 * characters (including NUL) anywhere inside an id-shaped string, so
 * neither `parentSessionId` (main-minted via `genId()`) nor a well-formed
 * `spawnToolCallId` can ever itself contain one — no ambiguous collision
 * between e.g. `("ab", "c")` and `("a", "bc")` is possible.
 */
function childSpawnKey(parentSessionId: string, spawnToolCallId: string): string {
  return `${parentSessionId}\u0000${spawnToolCallId}`;
}

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
 * Bounds `drainChildren`'s cascade (review T1) against a child whose process
 * was force-killed but never actually emits "exit" — `finalizeChildRun` then
 * never runs, the sibling set never empties, and an unbounded loop would
 * revisit it forever, one real macrotask at a time, pinning whichever caller
 * is awaiting the drain (`closeTab`, `relocateTab`) indefinitely. A generous
 * multiple of the per-child force-kill deadline: a healthy shutdown/force-kill
 * sequence resolves well within `exitDeadlineMs` alone.
 */
const DRAIN_CHILDREN_DEADLINE_MULTIPLIER = 5;

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
  /**
   * A per-fork ANYCODE_MODEL override (codex-profiles S4-1 arm 2, W4-F1). Set
   * ONLY on the first resume of a rollout-imported session, from the model the
   * user picked in the import dialog: the base fork env's ANYCODE_MODEL is the
   * ACTIVE connection's model (core resume takes the live model from the env, not
   * the session row — global by-design behaviour), so without this stamp the
   * imported tab would boot on the wrong model. Lives on the tab object, so it
   * rides every respawn. Absent = no override (every non-import spawn), stamping
   * nothing — byte-identical to today.
   */
  modelOverride?: string;
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
  /**
   * The resolved Codex account-profile argv (codex-profiles cut §3.3,
   * TASK.50): READY values from main's profile registry (lane A resolves the
   * renderer's opaque `codexProfileId`; tabs.ts only forwards). Unlike
   * `engineModel`/`enginePreset` above this rides argv on EVERY spawn —
   * respawns included — because `CODEX_HOME` is frozen into the session (cut
   * §2.6.4) and no session row records it: a respawn without the profile
   * would resume the native thread against the ambient home, i.e. the wrong
   * account. Values are forwarded verbatim (argv is an array, no shell); the
   * HOST is the single fail-closed validation authority (host/engines/codex/
   * codex-home.ts refuses any malformed value instead of falling back to the
   * ambient account). null = the `system` pseudo-profile (no argv delta).
   */
  codexProfile: { id?: string; home?: string; authLink?: string } | null;
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
  /**
   * Present ONLY on a child-session tab (TASK.102 CUT-S2 §2.6.4): the whole
   * non-recursion lock #3 and the cascade/quota machinery key off this field's
   * presence, never off anything in an inbound message's payload. `requestId`
   * correlates this tab's OWN control-plane messages (ChildReady/Progress/
   * Terminal) back to its `ChildRunLedgerEntry` — a child never states its own
   * ids on the wire (shared/child-sessions.ts's file header). `permissionMode`
   * is the §0.8 snapshot, carried here (rather than only inside the ledger
   * entry, which is deleted on the terminal transition) so `spawnTabHost` can
   * read it for the child's ONE fork's `--child-mode` argv regardless of when
   * that fork happens relative to ledger bookkeeping.
   */
  childOf?: {
    parentTabId: string;
    parentSessionId: string;
    spawnToolCallId: string;
    requestId: string;
    permissionMode: PermissionMode;
  };
}

/**
 * One admitted (or starting) child-session run, keyed by `requestId` in
 * `TabHostManager.childRuns` (TASK.102 CUT-S2 §2.6.4). Its mere PRESENCE in
 * that map is the quota reservation — `state` distinguishes "still occupies
 * the slot" (starting/running/cancelling, cut §0.7) from "gone" (removed by
 * `finalizeChildRun`, exactly once, freeing the slot). `prompt` is held here
 * (never sent to the child at spawn time) until `child-ready` releases it as
 * a `ChildStart` message (§2.6.2/§2.6.4's "prompt хранится в леджере до этого
 * момента"). `spawnToolCallId` (added CUT-S2 §10.5) is carried here — not
 * merely on the child `TabHost.childOf` — so `finalizeChildRun` can release
 * this entry's `childSpawnKeys` reservation without a second `tabs` lookup.
 */
interface ChildRunLedgerEntry {
  requestId: string;
  parentTabId: string;
  parentSessionId: string;
  spawnToolCallId: string;
  childTabId: string;
  childSessionId: string;
  state: "starting" | "running" | "cancelling";
  prompt: string;
  /** Cleared (and the field deleted) on `child-ready`; fires `handleChildStartTimeout` otherwise. */
  startDeadline?: ReturnType<typeof setTimeout>;
}

/**
 * One spawn request parked past the per-parent/global cap (TASK.147 срез 1),
 * keyed by `requestId` in `TabHostManager.childSpawnWaiters` and ordered by
 * `childSpawnQueue`. Unlike `ChildRunLedgerEntry`, a waiter never held a fork
 * — it is pure bookkeeping for a request `spawnChild` has neither accepted
 * nor rejected yet, so it carries the ORIGINAL `req` verbatim (needed intact
 * once `admitChildSpawn` finally runs) and `spawnKey`, which is ALREADY
 * reserved in `childSpawnKeys` from the moment this waiter is created — the
 * in-flight dedup check must see a still-queued request exactly as it sees a
 * running one (TASK.147's "Дедуп спавна сохраняется"). `parentTabId` is all
 * that is needed to re-resolve the live `TabHost` at wake time (never a
 * captured `TabHost` reference, which a respawn would make stale).
 */
interface ChildSpawnWaiter {
  requestId: string;
  parentTabId: string;
  spawnKey: string;
  req: ChildSpawnRequest;
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
  /**
   * Availability of a reviewed non-core engine; defaults fail-closed. Codex
   * readiness is per PROFILE (codex-profiles cut §4.2, TASK.50): the optional
   * `codexProfileId` is the profile the spawn will actually run under — the
   * draft's pick on a new tab, the persisted meta pick on a resume — so the gate
   * answers about THAT account, not merely the active one. Absent id = the
   * active profile answers (today's single-profile behaviour; no symmetry).
   */
  engineReady?: (engine: EngineId, codexProfileId?: string) => boolean;
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
  /**
   * Resolves the immutable providerId of a pinned connection for the tab-port
   * envelope (TASK.45 W10-FIX F2): main injects `(id) => connectionById(...)?.providerId`.
   * Absent OR returning undefined -> the envelope omits BOTH pin fields (an
   * unpinned/legacy tab, or a since-deleted connection), and the renderer's
   * ModelPill falls back to the active connection's catalog + write-target.
   */
  describeConnection?: (connectionId: string) => { providerId: string } | undefined;
  /**
   * Resolves an EXPLICIT `Agent(tier:"session", provider:…)` request's provider
   * id to a live connection id (TASK.102 CUT-S2 §2.6.4), called synchronously
   * from inside the admission section — main already holds the connections
   * registry in memory (the same fact `env(connectionId)` relies on), so this
   * never needs to be async. Returning `undefined` (unknown/deleted provider
   * id) fails the spawn closed with `not_ready` (§2.7) rather than silently
   * falling back to the parent's own connection. Absent = no explicit
   * `provider` request can ever succeed (every `provider` value is treated as
   * unresolvable) — every test/host that never wires this simply cannot honor
   * a cross-connection spawn, which is the safe default.
   */
  resolveProviderConnection?: (provider: string) => string | undefined;
  /**
   * Preview control-plane delegate (night-track wave-1 cut §2.3/§2.5, TASK.96
   * 96-A): main routes a host's `PREVIEW_REQUEST_TYPE`/`PREVIEW_ARTIFACTS_TYPE`
   * control-plane messages here unchanged, tabId-scoped — `main/index.ts` binds
   * both to the same `PreviewHost` instance (`preview/preview-host.ts`). Neither
   * is awaited here: `PreviewHost.handleRequest` never rejects (it always posts
   * its own correlated response) and `handleArtifacts` is fire-and-forget by
   * design (turn-end auto-open is best-effort). Absent = preview support is not
   * wired (both messages are silently dropped, matching every other
   * as-yet-unhandled control-plane type here).
   */
  onPreviewRequest?: (tabId: string, message: PreviewRequestMessage) => void;
  onPreviewArtifacts?: (tabId: string, message: PreviewArtifactsMessage) => void;
  /**
   * Fires once a tab is actually gone (closeTab, NOT a host respawn — the two
   * are never the same thing here, design §2.2). main wires this to
   * `PreviewHost.closeForTab`, so a closed tab's preview windows never outlive
   * it. Absent = no-op (every pre-96-A caller/test).
   */
  onTabClosed?: (tabId: string) => void;
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
  /**
   * Present only for a child-session tab (TASK.102 CUT-S2 §2.6.4's "listTabs()
   * — добавить childOf-проекцию"), for the automation `/state` projection
   * (S2d, not this slice) — never surfaced to the ordinary renderer, which
   * only ever sees root tabs via the port-envelope/tab-registry path.
   */
  childOf?: { parentTabId: string; requestId: string };
}

/**
 * Read-only projection of one admitted child-session run (TASK.102 CUT-S2
 * §2.6.4 S2d, `automation/handlers.ts`'s `GET /state` `childRuns`): a
 * field-for-field read of the manager's private `childRuns` ledger entry,
 * excluding what does not belong outside the manager (the held `prompt`,
 * the internal `startDeadline` timer) and adding the child tab's own live
 * host `pid` (joined off `tabs`), which the ledger entry itself does not
 * carry. Declared structurally identical to (but independent of)
 * `automation/handlers.ts`'s own local `ChildRunSummary` — that module
 * cannot import this one without a circular dependency (tabs.ts sits below
 * automation/).
 */
export interface ChildRunSummary {
  requestId: string;
  parentSessionId: string;
  childTabId: string;
  childSessionId: string;
  state: "starting" | "running" | "cancelling";
  pid: number | null;
}

export class TabHostManager {
  private readonly tabs = new Map<string, TabHost>();
  /* */
  private readonly bindings = new Map<string, string>();
  /**
   * parentTabId -> the set of that parent's currently-tracked child tabIds
   * (TASK.102 CUT-S2 §2.6.4). A childTabId lives in this set for EXACTLY the
   * same span it lives in `childRuns` under its own requestId (added
   * together at admission, removed together by `finalizeChildRun`) — this is
   * the per-parent quota index AND the drain-cascade's iteration surface.
   */
  private readonly childrenByParentTab = new Map<string, Set<string>>();
  /** requestId -> the one admitted run it correlates (§2.6.4); its SIZE is the global quota's live count. */
  private readonly childRuns = new Map<string, ChildRunLedgerEntry>();
  /**
   * `childSpawnKey(parentSessionId, spawnToolCallId)` -> the one live
   * requestId currently holding that pair (TASK.102 CUT-S2 §10.5 п.3). The
   * SQLite v13 unique index (`idx_sessions_parent_spawn`) only guards the
   * DURABLE row once a child session has actually been persisted — it
   * cannot see a second spawn for the SAME pair racing the first inside
   * this process's memory, before either child's row exists yet. This map
   * is `childRuns`'s admission-time twin for that pair: reserved in the
   * exact same synchronous admission section (`spawnChild`) that reserves
   * `childRuns`/`childrenByParentTab`, and released by the exact same single
   * `finalizeChildRun` (or `spawnChild`'s own fork-failure rollback) — so a
   * pair can never outlive the run it names, on ANY of the terminal paths
   * (completed/error/cancelled/crash/start-deadline) that lead there.
   *
   * TASK.147 срез 1 amendment: `spawnChild` now reserves a pair's entry HERE
   * the moment the dedup check passes — one step BEFORE it is known whether
   * the request will admit immediately or park in `childSpawnQueue` — rather
   * than only once `childRuns`/`childrenByParentTab` are also written. A
   * parked request is therefore just as dedup-protected as a running one; it
   * is released by the same `finalizeChildRun`/rollback paths above, plus
   * `purgeChildSpawnWaiters` for a waiter that dies before ever admitting.
   */
  private readonly childSpawnKeys = new Map<string, string>();
  /**
   * FIFO arrival order of currently-queued `requestId`s (TASK.147 срез 1) —
   * one manager-wide queue, not one per parent: a slot freed by ANY parent's
   * `finalizeChildRun` can admit a waiter belonging to a DIFFERENT parent
   * (it was blocked on the GLOBAL cap, not its own per-parent one), so
   * wake-up must scan arrival order across every parent at once rather than
   * only the freed parent's own backlog. Bounded by `CHILD_SPAWN_QUEUE_MAX`.
   */
  private readonly childSpawnQueue: string[] = [];
  /** requestId -> the parked spawn request `childSpawnQueue` orders (TASK.147 срез 1); see `ChildSpawnWaiter`'s own doc for why this is not simply folded into `childRuns`. */
  private readonly childSpawnWaiters = new Map<string, ChildSpawnWaiter>();
  /**
   * Parent tabIds with a `drainChildren` pass currently in flight, refcounted
   * because two teardown paths can legally overlap on one tab (`handleExit`
   * fires its drain with `void` and does not await it, so a `closeTab` or
   * `rebindTab` arriving mid-respawn starts a second pass while the first is
   * still awaiting reaps) — a plain Set would let whichever pass finished
   * first clear the flag out from under the other.
   *
   * A drain is exactly the window in which the per-parent cap is guaranteed
   * FULL and yet meaningless: every child is `cancelling`, and §0.7 has
   * `cancelling` hold its slot until a real reap. Parking a request there
   * would therefore park it in every case rather than the rare one, and the
   * waiter would then be admitted by `pumpChildSpawnQueue` as those very
   * reaps land — forking a brand-new child into a parent that is midway
   * through being torn down, rebound to a different account, or rehosted to
   * a different workspace. `rebindTab` and the rehost path hold no `closing`
   * seal while they drain (only `closeTab` does, and `handleExit` instead
   * nulls `proc`), so tab state alone cannot distinguish this window.
   */
  private readonly drainingParents = new Map<string, number>();
  /**
   * `UtilityProcess` references whose `shutdownTabHost` call hit its
   * `exitDeadlineMs` timeout and force-killed rather than seeing a real exit
   * (TASK.102 fix-wave F2), mapped to whatever `tab.engineProcess`
   * registration existed for that tab AT THE MOMENT of the force-kill (`null`
   * if none) — review T3's snapshot, taken before `shutdownTabHost` nulls
   * `tab.proc` and before any later respawn could reset `tab.engineProcess`
   * out from under it. Populated right before that same nulling — the moment
   * `handleChildExit`'s (children) and `reapEngineProcess`'s (all tabs)
   * ordinary `tab.proc !== child` staleness guards would otherwise treat the
   * process's LATE, genuinely-still-pending exit as belonging to an
   * already-superseded generation and drop it: for a child, never calling
   * `finalizeChildRun` (the slot/dedup-key leak, F2); for any tab with an
   * external engine, never reaping it (the orphaned process-group leak, T3).
   * Consumed (and removed) the first time that late exit is actually
   * processed by `handleExit`, whether the tab turns out to be a child or a
   * root — a root's OWN `state === "closing"` respawn-suppression guard
   * never needed the F2 half of this (children never respawn, so `forceKilled`
   * is the only legitimate cause of staleness there), but a root CAN carry an
   * `engineProcess`, so the T3 half applies to roots specifically.
   */
  private readonly forceKilledExits = new Map<UtilityProcess, EngineProcessRegistration | null>();
  private readonly limits: BreakerLimits;
  private readonly env: (connectionId?: string) => NodeJS.ProcessEnv | undefined;
  private readonly isReady: () => boolean;
  private readonly isEngineReady: (engine: EngineId, codexProfileId?: string) => boolean;
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

  /**
   * Number of live ROOT tabs (TASK.102 CUT-S2 §2.6.4: "atCapacity()/count()
   * — только roots"). A child session is not an application "tab" from
   * MAX_TABS's perspective — it never counted against it, and never will.
   */
  count(): number {
    return this.rootCount();
  }

  private rootCount(): number {
    let n = 0;
    for (const tab of this.tabs.values()) {
      if (tab.childOf === undefined) {
        n++;
      }
    }
    return n;
  }

  /**
   * Read-only snapshot of every live tab's main-plane facts (design
   * §3.1/§4.1), root AND child alike — the automation server's `GET /state`
   * (S2d, not this slice) needs to see children too, tagged via `childOf`, to
   * project the child-run ledger next to the renderer's (child-blind) store.
   */
  listTabs(): ReadonlyArray<TabSummary> {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.tabId,
      workspace: tab.workspace,
      sessionId: tab.sessionId,
      state: tab.state,
      pid: tab.proc?.pid ?? null,
      ...(tab.childOf !== undefined
        ? { childOf: { parentTabId: tab.childOf.parentTabId, requestId: tab.childOf.requestId } }
        : {}),
    }));
  }

  /**
   * Read-only snapshot of every live admitted child-session run (design
   * §3.1/§4.1, TASK.102 CUT-S2 §2.6.4 S2d), for the automation server's
   * `GET /state` `childRuns` projection — the ledger's own admission
   * `state` ("starting"|"running"|"cancelling"), not a tab's breaker
   * `state` ("running"|"crash_looped"|"closing").
   */
  listChildRuns(): ReadonlyArray<ChildRunSummary> {
    return [...this.childRuns.values()].map((e) => ({
      requestId: e.requestId,
      parentSessionId: e.parentSessionId,
      childTabId: e.childTabId,
      childSessionId: e.childSessionId,
      state: e.state,
      pid: this.tabs.get(e.childTabId)?.proc?.pid ?? null,
    }));
  }

  atCapacity(): boolean {
    return this.rootCount() >= this.limits.maxTabs;
  }

  /**

   * the tab-ipc create path can refuse `not_ready` BEFORE prompting for a
   * workspace; createTab enforces it authoritatively regardless.
   */
  canSpawn(engine: EngineId = "core", codexProfileId?: string): boolean {
    // SLICE-CC C5 (cut §1.4): the CC-A hard refusal of `claude` is REMOVED here
    // now that `host/index.ts`'s boot() switch dispatches a real `bootClaude`
    // branch — a claude spawn can no longer land on the core boot path. Claude
    // now answers from the same authority every other engine does:
    // `isEngineReady`, which main/index.ts wires to the doctor's confirmed
    // readiness (version-compatible AND signed in).
    return this.isEngineReady(engine, codexProfileId);
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
    /**
     * Resolved Codex profile argv values (codex-profiles TASK.50) — id plus,
     * when the registry says so, a linkedHome path (`home`) or an auth-link
     * target. Already resolved/validated by main's registry; the host
     * re-validates fail-closed. See TabHost.codexProfile.
     */
    codexProfile?: { id?: string; home?: string; authLink?: string };
    /** Pinned provider connection (TASK.45 W10, core only); stamped into the fork env + persisted by the host. */
    connectionId?: string;
    /** Per-fork ANYCODE_MODEL override (S4-1 arm 2): the imported-session model pick; see TabHost.modelOverride. */
    modelOverride?: string;
  }): CreateTabResult {

    // secret-clear on an open window lets `+` spawn a host with no provider key.
    const engine = params.engine ?? "core";
    // Gate on the profile this spawn will actually run under (codex-profiles
    // S3-1), not merely the active one — a ready non-active pick must be able to
    // spawn even while the active account is signed out.
    if (!this.canSpawn(engine, params.codexProfile?.id)) {
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
      ...(params.modelOverride !== undefined ? { modelOverride: params.modelOverride } : {}),
      engine,
      engineModel: argvId(params.engineModel),
      enginePreset: argvId(params.enginePreset),
      codexProfile: params.codexProfile ?? null,
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
    // Codex-profiles TASK.50 (cut §2.6.4): the profile rides EVERY spawn —
    // resume and respawn included — because CODEX_HOME is frozen into the
    // session and no session row records it; a respawn without these flags
    // would resume the thread against the ambient (wrong) account. Values go
    // out verbatim: the host's codex-home.ts is the fail-closed authority.
    if (tab.codexProfile !== null) {
      if (tab.codexProfile.id !== undefined) args.push("--codex-profile", tab.codexProfile.id);
      if (tab.codexProfile.home !== undefined) args.push("--codex-home", tab.codexProfile.home);
      if (tab.codexProfile.authLink !== undefined) args.push("--codex-auth-link", tab.codexProfile.authLink);
    }
    // TASK.102 CUT-S2 §2.6.2/§2.6.4: a child session's ONE spawn (children
    // never respawn, cut §0.6) carries its parent linkage + inherited
    // permission-mode snapshot as argv, for the child host's boot
    // (`parseHostArgs`/`resolveBootSession`, S2b/B4) to create its session row
    // with `parentSessionId`/`spawnToolCallId` and the correct initial mode.
    if (tab.childOf !== undefined) {
      args.push(
        "--child-parent",
        tab.childOf.parentSessionId,
        "--child-spawn-call",
        tab.childOf.spawnToolCallId,
        "--child-mode",
        tab.childOf.permissionMode,
      );
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
    // TASK.102 S4 gate-fix (F4, latent): resolve the engine env overlay BEFORE
    // forking, same layer as the baseEnv check above. registry.ts's
    // `selectEnginePlugin` treats an absent ANYCODE_ENGINE as core, SILENTLY —
    // an `engineEnv` dep that is absent or omits it would otherwise fork a
    // non-core tab as a full core session on the ambient connection, with
    // every card/quota/terminal staying green. Refuse to fork rather than let
    // that downgrade happen unnoticed (production's own `engineEnv` always
    // stamps it, main/index.ts:1462, so this only ever trips a missing/broken
    // overlay). The generation is computed but NOT yet committed to `tab`, so
    // a refusal here leaves the tab's breaker state exactly as a rejected
    // baseEnv check would.
    const nextGeneration = tab.hostGeneration + 1;
    const engineEnvOverlay = this.deps.engineEnv?.(tab.engine, nextGeneration) ?? {};
    if (tab.engine !== "core" && engineEnvOverlay[ENV_ENGINE] !== tab.engine) {
      this.logger.error(
        `[main] tab ${tab.tabId} engine ${tab.engine} but the composed fork env omits/mismatches ANYCODE_ENGINE; refusing to spawn`,
      );
      tab.proc = null;
      tab.state = "crash_looped";
      this.notifyHostExited(tab.tabId);
      return;
    }
    tab.hostGeneration = nextGeneration;
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
        // S4-1 arm 2 (W4-F1): an imported session's picked model, stamped over
        // the base env's ANYCODE_MODEL (the active connection's model). Per-fork
        // like ANYCODE_CONNECTION_ID above and rides every respawn (lives on the
        // tab). Absent for every non-import spawn ⇒ nothing stamped.
        ...(tab.modelOverride !== undefined ? { [ENV_MODEL]: tab.modelOverride } : {}),
        ...engineEnvOverlay,
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
    if (data.type === PREVIEW_REQUEST_TYPE) {
      this.deps.onPreviewRequest?.(tab.tabId, message as PreviewRequestMessage);
      return;
    }
    if (data.type === PREVIEW_ARTIFACTS_TYPE) {
      this.deps.onPreviewArtifacts?.(tab.tabId, message as PreviewArtifactsMessage);
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
    // TASK.102 CUT-S2 §2.6.4: the child-session control plane. Every parser
    // below is fail-closed (shared/child-sessions.ts) — a malformed message is
    // silently dropped, same discipline as every other as-yet-unrecognized
    // control-plane type on this channel. `spawnChild`/the handlers do their
    // OWN sender-authority checks (tab.proc === sender, tab.childOf presence)
    // — never trust anything about identity from the payload itself.
    if (data.type === CHILD_SPAWN_REQUEST_TYPE) {
      const req = parseChildSpawnRequest(message);
      if (req !== null) {
        this.spawnChild(tab, child, req);
      }
      return;
    }
    if (data.type === CHILD_RUN_CANCEL_TYPE) {
      const cancel = parseChildRunCancel(message);
      if (cancel !== null) {
        this.handleChildRunCancel(tab, child, cancel);
      }
      return;
    }
    if (data.type === CHILD_READY_TYPE) {
      const ready = parseChildReady(message);
      if (ready !== null) {
        this.handleChildReady(tab, child);
      }
      return;
    }
    if (data.type === CHILD_PROGRESS_TYPE) {
      const progress = parseChildProgress(message);
      if (progress !== null) {
        this.handleChildProgress(tab, child, progress);
      }
      return;
    }
    if (data.type === CHILD_TERMINAL_TYPE) {
      const terminal = parseChildTerminal(message);
      if (terminal !== null) {
        this.handleChildTerminal(tab, child, terminal);
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

  /** Posts one `ChildRunEvent` to a tab's live process; best-effort (swallows a dead-proc postMessage throw). */
  private replyChildRunEvent(tab: TabHost, event: ChildRunEvent): void {
    if (tab.proc === null) {
      return;
    }
    try {
      tab.proc.postMessage(event);
    } catch (error) {
      this.logger.warn(`[main] failed to relay child-run event to tab ${tab.tabId}`, error);
    }
  }

  /**
   * Admits, queues, or refuses a session-tier `Agent` spawn request from a
   * root tab (TASK.102 CUT-S2 §2.6.4, TASK.147 срез 1). Everything from the
   * stale-sender check through either the fork attempt or the park decision
   * below is ONE synchronous section — no `await` anywhere in it — so that
   * two spawn requests processed back to back (the SAME parent issuing
   * several `Agent(tier:"session")` calls in one turn) always see each
   * other's reservation: admission atomicity (cut §5.9) depends on there
   * being no yield point between "check the quota" and "reserve the slot",
   * and that now applies equally to a request that ends up queued rather
   * than forked immediately.
   */
  private spawnChild(parentTab: TabHost, sender: UtilityProcess, req: ChildSpawnRequest): void {
    const reject = (reason: ChildRunRejectReason, message: string): void => {
      this.replyChildRunEvent(parentTab, {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: req.requestId,
        kind: "rejected",
        reason,
        message,
      });
    };

    if (parentTab.proc !== sender) {
      // Stale-generation sender (the tab respawned since this message was
      // sent) — not even a reply, mirroring registerEngineProcess's precedent
      // for a stale/foreign control-plane message.
      return;
    }
    if (parentTab.childOf !== undefined) {
      // Non-recursion lock #3 (cut §0.2): main refuses a spawn from a tab that
      // is ITSELF a child, regardless of what locks #1/#2 (restricted schema,
      // absent ctx.sessionSubagents) already should have prevented core-side.
      reject("recursion", CHILD_RECURSION_MESSAGE);
      return;
    }
    if (this.quitting || parentTab.state !== "running") {
      reject("closing", CHILD_CLOSING_MESSAGE);
      return;
    }
    // In-flight dedup of the (parentSessionId, spawnToolCallId) pair (cut
    // §10.5 п.3): `parentSessionId` is the ACTUAL sender's tab, never
    // `req`'s payload (same law as everything else in this section) —
    // `spawnToolCallId` is the only piece that comes from `req`, and it is
    // exactly the durable spawn identity §10.5 established. A second spawn
    // for a pair whose first run is still starting/running/cancelling — OR
    // still QUEUED (TASK.147 срез 1: `childSpawnKeys` is reserved the moment
    // a waiter parks, below) — is refused HERE, synchronously, rather than
    // being left to the SQLite v13 unique index (which only fires once a
    // child session row exists) or the 30s start-deadline path.
    const spawnKey = childSpawnKey(parentTab.sessionId, req.spawnToolCallId);
    if (this.childSpawnKeys.has(spawnKey)) {
      reject("spawn_failed", CHILD_DUPLICATE_SPAWN_MESSAGE);
      return;
    }
    const capBlock = this.childSpawnCapBlock(parentTab.tabId);
    if (capBlock !== undefined) {
      // TASK.147 срез 1: the cap itself is unchanged (`childSpawnCapBlock`
      // runs the EXACT same two checks the pre-queue code ran inline here) —
      // only the RESPONSE to hitting it changes, from an immediate reject to
      // a park, UNLESS the queue itself is already full, in which case this
      // request gets the same honest refusal a cap-exceeding request always
      // got (the two frozen texts stay reachable exactly on this path).
      // A parent mid-drain refuses exactly as it did before this task: its
      // cap is full only because every child is `cancelling`, and admitting
      // the waiter once those reaps land would fork a child into a parent
      // that is already being torn down (see `drainingParents`). The
      // immediate, under-cap path is deliberately NOT gated on draining —
      // that behaviour stays byte-identical to pre-TASK.147.
      if (this.childSpawnQueue.length >= CHILD_SPAWN_QUEUE_MAX || this.drainingParents.has(parentTab.tabId)) {
        reject(capBlock.reason, capBlock.message);
        return;
      }
      this.childSpawnKeys.set(spawnKey, req.requestId);
      this.childSpawnWaiters.set(req.requestId, {
        requestId: req.requestId,
        parentTabId: parentTab.tabId,
        spawnKey,
        req,
      });
      this.childSpawnQueue.push(req.requestId);
      // No reply yet: this request has been neither accepted nor rejected —
      // `pumpChildSpawnQueue` (from `finalizeChildRun`) or
      // `purgeChildSpawnWaiters` (parent death) settles it later.
      return;
    }

    this.childSpawnKeys.set(spawnKey, req.requestId);
    this.admitChildSpawn(parentTab, req, spawnKey);
  }

  /**
   * The per-parent/global cap check (TASK.147 срез 1 extraction — byte-
   * identical to the two checks `spawnChild` ran inline before this task):
   * shared by `spawnChild`'s own immediate admission and by
   * `pumpChildSpawnQueue`'s per-waiter check, so a queued request is
   * evaluated against EXACTLY the rule an immediate one is, never a
   * relaxed or stricter twin.
   */
  private childSpawnCapBlock(
    parentTabId: string,
  ): { reason: "limit_parent" | "limit_global"; message: string } | undefined {
    const perParent = this.childrenByParentTab.get(parentTabId)?.size ?? 0;
    if (perParent >= CHILD_RUNS_PER_PARENT_MAX) {
      return { reason: "limit_parent", message: CHILD_LIMIT_PARENT_MESSAGE };
    }
    if (this.childRuns.size >= CHILD_RUNS_GLOBAL_MAX) {
      return { reason: "limit_global", message: CHILD_LIMIT_GLOBAL_MESSAGE };
    }
    return undefined;
  }

  /**
   * Runs the engine-readiness/provider-resolution/fork sequence for a spawn
   * request that has ALREADY cleared the per-parent/global cap (TASK.147
   * срез 1 extraction) — either because `spawnChild` found it under cap
   * immediately, or because `pumpChildSpawnQueue` just dequeued it once a
   * slot freed. `spawnKey` is ALREADY reserved in `childSpawnKeys` by the
   * caller in both cases. Checking engine-readiness/provider resolution HERE
   * rather than at park time is deliberate: a request that waited is
   * re-checked against whatever is true NOW — an engine that came up or went
   * down, a provider connection that was deleted, while it sat in the queue
   * — never against a stale answer computed before the wait began.
   */
  private admitChildSpawn(parentTab: TabHost, req: ChildSpawnRequest, spawnKey: string): void {
    const reject = (reason: ChildRunRejectReason, message: string): void => {
      this.childSpawnKeys.delete(spawnKey);
      this.replyChildRunEvent(parentTab, {
        type: CHILD_RUN_EVENT_TYPE,
        requestId: req.requestId,
        kind: "rejected",
        reason,
        message,
      });
    };

    // TASK.102 CUT-S4 §3.2 п.1-2: `req.engine` chooses which readiness
    // authority gates this spawn — the SAME `isEngineReady` a root tab's
    // `createTab` consults, never a second authority. Absent = core, byte-
    // compatible with every S2 producer.
    const engine: EngineId = req.engine ?? "core";
    if (!this.isEngineReady(engine)) {
      reject("not_ready", childEngineNotReadyMessage(engine));
      return;
    }
    if (req.provider !== undefined && engine !== "core") {
      // §3.2 п.3: an engine child runs on its own CLI account — "provider" is
      // a core-connection concept and is meaningless here. core-side already
      // refuses it (tools/agent.ts §2.2 п.1); main refuses independently.
      reject("not_ready", CHILD_ENGINE_PROVIDER_MESSAGE);
      return;
    }
    let connectionId = parentTab.connectionId;
    if (req.provider !== undefined) {
      // Explicit resolve, synchronous (deps doc: main already holds the
      // connections registry in memory) — an unknown/deleted provider id
      // fails closed rather than silently falling back to the parent's own
      // connection (cut §2.6.4's "неизвестный provider ⇒ not_ready").
      const resolved = this.deps.resolveProviderConnection?.(req.provider);
      if (resolved === undefined) {
        reject("not_ready", childProviderNotReadyMessage(req.provider));
        return;
      }
      connectionId = resolved;
    }

    // Reservation: the child's tabId/sessionId are minted and the ledger
    // entry + per-parent index are written HERE, before the fork is even
    // attempted — the slot exists from this point regardless of whether the
    // fork below succeeds (a throw rolls it back explicitly). `spawnKey`
    // itself is NOT (re-)written here — the caller already holds it, from
    // before this request was even known to fit under cap (TASK.147 срез 1).
    const childTabId = this.genId();
    const childSessionId = this.genId();
    const entry: ChildRunLedgerEntry = {
      requestId: req.requestId,
      parentTabId: parentTab.tabId,
      parentSessionId: parentTab.sessionId,
      spawnToolCallId: req.spawnToolCallId,
      childTabId,
      childSessionId,
      state: "starting",
      prompt: req.prompt,
    };
    this.childRuns.set(req.requestId, entry);
    let siblings = this.childrenByParentTab.get(parentTab.tabId);
    if (siblings === undefined) {
      siblings = new Set<string>();
      this.childrenByParentTab.set(parentTab.tabId, siblings);
    }
    siblings.add(childTabId);
    const rollback = (): void => {
      this.childRuns.delete(req.requestId);
      this.childSpawnKeys.delete(spawnKey);
      siblings!.delete(childTabId);
      if (siblings!.size === 0) {
        this.childrenByParentTab.delete(parentTab.tabId);
      }
    };

    // Main NEVER trusts payload identity (cut §2.3's own header): workspace,
    // projectRoot and the parent linkage below all come from the ACTUAL
    // parentTab record, never from `req`. A child never has a worktree and
    // never resumes (children never respawn, cut §0.6). CUT-S4 §3.2 п.4: a
    // CORE child keeps every S2 field byte-identical (modelOverride,
    // connectionId inherited); an ENGINE child instead carries its model as
    // `engineModel` (rides `--engine-model` on the child's one, always-first
    // spawn) and NEVER an `enginePreset`/`codexProfile`/`connectionId` — the
    // preset comes from `--child-mode` (§4.2, host-side), the account is
    // ambient (RS4-0-4), and `connectionId` is "Never consulted for a
    // non-core engine" (tab-ipc law).
    const childTab: TabHost = {
      tabId: childTabId,
      workspace: parentTab.workspace,
      projectRoot: parentTab.projectRoot,
      sessionId: childSessionId,
      ...(engine === "core" && connectionId !== undefined ? { connectionId } : {}),
      ...(engine === "core" && req.model !== undefined ? { modelOverride: req.model } : {}),
      engine,
      engineModel: engine !== "core" ? (req.model ?? null) : null,
      enginePreset: null,
      codexProfile: null,
      proc: null,
      hostGeneration: 0,
      engineProcess: null,
      spawnedAt: 0,
      rapidRespawns: 0,
      state: "running",
      initialResume: false,
      childOf: {
        parentTabId: parentTab.tabId,
        parentSessionId: parentTab.sessionId,
        spawnToolCallId: req.spawnToolCallId,
        requestId: req.requestId,
        permissionMode: req.permissionMode,
      },
    };

    try {
      this.spawnTabHost(childTab, { firstSpawn: true });
    } catch (error) {
      rollback();
      this.logger.error(`[main] child spawn threw for request ${req.requestId}`, error);
      reject("spawn_failed", CHILD_SPAWN_FAILED_MESSAGE);
      return;
    }
    if (childTab.proc === null) {
      // spawnTabHost's own fail-closed path (W10-FIX F3: the resolved
      // connection's env is unavailable) already logged and marked
      // crash_looped without throwing — treat it the same as a throwing fork.
      rollback();
      reject("spawn_failed", CHILD_SPAWN_FAILED_MESSAGE);
      return;
    }

    this.tabs.set(childTabId, childTab);
    // TASK.147 срез 1: this timer starts HERE, at the REAL fork, whether the
    // request forked immediately or spent time queued first — never at
    // park/enqueue time. A long wait therefore never eats into the window a
    // child gets to answer `child-ready` once it actually starts.
    entry.startDeadline = setTimeout(() => this.handleChildStartTimeout(req.requestId), CHILD_START_DEADLINE_MS);
    this.deliverTabPort(childTab);
    // TASK.102 S4 gate-fix (L1): connectionId is "Never consulted for a
    // non-core engine" (§1249's own law) — an engine child's omitted model
    // reports the SAME placeholder describeChildModel falls back to, never
    // the parent connection's ANYCODE_MODEL (describeChildModel(connectionId)
    // would read a CORE model string for an engine that has none, since an
    // omitted req.model boots the engine host with no --engine-model at all).
    this.replyChildRunEvent(parentTab, {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: req.requestId,
      kind: "accepted",
      childSessionId,
      childTabId,
      model: req.model ?? (engine === "core" ? this.describeChildModel(connectionId) : "default"),
    });
  }

  /**
   * Tries to admit as many queued spawn requests as currently fit, in FIFO
   * arrival order (TASK.147 срез 1) — called from `finalizeChildRun`, the
   * ONLY honest slot-release point. A single freed slot can unblock a waiter
   * belonging to a DIFFERENT parent than the one whose child just finished
   * (the waiter was blocked on the GLOBAL cap, not its own per-parent one),
   * so this scans the WHOLE queue in arrival order rather than only the
   * freed parent's own backlog — skipping (not stopping at) a waiter that
   * still does not fit, so one parent's still-full per-parent cap can never
   * starve a different parent's otherwise-eligible waiter behind it. Each
   * admission consumes exactly the capacity it needed, updating the very
   * maps `childSpawnCapBlock` reads, so a later waiter's check in the SAME
   * pass automatically reflects it — no separate "how many slots freed"
   * bookkeeping is needed.
   */
  private pumpChildSpawnQueue(): void {
    if (this.quitting) {
      // Mirrors `spawnChild`'s own immediate-path guard: never fork a NEW
      // child once shutdown has been signalled. `shutdownAllTabHosts`
      // already purges the whole queue before this could matter in
      // practice; this is a defensive second guard, not the primary one.
      return;
    }
    let i = 0;
    while (i < this.childSpawnQueue.length) {
      const requestId = this.childSpawnQueue[i]!;
      const waiter = this.childSpawnWaiters.get(requestId);
      if (waiter === undefined) {
        // Already purged (parent closed/quit) but not yet spliced out here.
        this.childSpawnQueue.splice(i, 1);
        continue;
      }
      const parentTab = this.tabs.get(waiter.parentTabId);
      if (parentTab === undefined || parentTab.state !== "running" || this.drainingParents.has(waiter.parentTabId)) {
        // Should not happen — `purgeChildSpawnWaiters` runs synchronously
        // before any parent state change that would cause this — but fail
        // closed rather than fork against a dead/foreign tab.
        this.childSpawnQueue.splice(i, 1);
        this.childSpawnWaiters.delete(requestId);
        this.childSpawnKeys.delete(waiter.spawnKey);
        continue;
      }
      if (this.childSpawnCapBlock(waiter.parentTabId) !== undefined) {
        i += 1;
        continue;
      }
      this.childSpawnQueue.splice(i, 1);
      this.childSpawnWaiters.delete(requestId);
      this.admitChildSpawn(parentTab, waiter.req, waiter.spawnKey);
      // Do not advance `i` — the next element has shifted into this index.
    }
  }

  /**
   * Rejects (reason `closing`, the existing verbatim text) and releases
   * every currently-queued spawn request belonging to `parentTabId` — or, if
   * omitted, every queued request application-wide (TASK.147 срез 1's
   * "Отменяемость": a waiter must die with its parent, exactly like a
   * running/starting child already does via the cascade below it). Called
   * from `drainChildren`'s own synchronous prefix (so it runs before ANY of
   * that same call's awaits — before a respawn's `spawnTabHost` could ever
   * observe a stale waiter surviving a generation change, the same
   * synchronous-prefix discipline `handleExit`'s own comment relies on for
   * `drainChildren` itself) and from `shutdownAllTabHosts` (no
   * `parentTabId` — the whole app is going down). A waiter never held a
   * `childRuns`/`childrenByParentTab` reservation (only `admitChildSpawn`
   * writes those), so releasing `childSpawnKeys` plus the queue/map
   * bookkeeping here is this function's entire cleanup — there is no ledger
   * entry to finalize.
   */
  private purgeChildSpawnWaiters(parentTabId?: string): void {
    if (this.childSpawnQueue.length === 0) {
      return;
    }
    const remaining: string[] = [];
    for (const requestId of this.childSpawnQueue) {
      const waiter = this.childSpawnWaiters.get(requestId);
      if (waiter === undefined) {
        continue;
      }
      if (parentTabId !== undefined && waiter.parentTabId !== parentTabId) {
        remaining.push(requestId);
        continue;
      }
      this.childSpawnWaiters.delete(requestId);
      this.childSpawnKeys.delete(waiter.spawnKey);
      const parentTab = this.tabs.get(waiter.parentTabId);
      if (parentTab !== undefined) {
        // Best-effort, same discipline as `finalizeChildRun`'s own terminal
        // relay: the parent may already be gone (dead-generation crash path,
        // where `tab.proc` is already null and `replyChildRunEvent` no-ops).
        this.replyChildRunEvent(parentTab, {
          type: CHILD_RUN_EVENT_TYPE,
          requestId,
          kind: "rejected",
          reason: "closing",
          message: CHILD_CLOSING_MESSAGE,
        });
      }
    }
    this.childSpawnQueue.length = 0;
    this.childSpawnQueue.push(...remaining);
  }

  /**
   * The model string reported on `accepted` when the request omitted an
   * explicit `model` (cut §2.6.4's "model — существующий ENV_MODEL-механизм
   * modelOverride"): the resolved connection's OWN currently-configured
   * model, read off the same `env()` the fork itself just used — not a
   * value main invents. Falls back to a placeholder only if the connection's
   * env carries no model at all (an incompletely configured connection).
   */
  private describeChildModel(connectionId: string | undefined): string {
    const env = this.env(connectionId);
    const model = env?.[ENV_MODEL];
    return typeof model === "string" && model.length > 0 ? model : "default";
  }

  /** requestId -> its owning parent's cancel of a still-live run (Agent tool abort/timeout, cut §0.5's ctx.abortSignal). */
  private handleChildRunCancel(tab: TabHost, sender: UtilityProcess, msg: ChildRunCancel): void {
    if (tab.proc !== sender) {
      return;
    }
    const entry = this.childRuns.get(msg.requestId);
    // Authorization by ownership, not merely existence: a tab can only cancel
    // a run IT spawned. Since only a root tab can ever be a run's
    // `parentTabId` (recursion lock #3 above), this also naturally rejects a
    // child tab that tries to cancel anything — no separate childOf check needed.
    if (entry === undefined || entry.parentTabId !== tab.tabId) {
      return;
    }
    void this.cancelChildRun(entry.childTabId);
  }

  /**
   * Marks a run `cancelling` (idempotent) and starts shutting down its
   * child's host. `cancelling` holds the quota slot (cut §0.7's "держит слот
   * до реального реапа") — this does NOT touch `childRuns`/`childrenByParentTab`;
   * only `finalizeChildRun` (on the child's actual terminal transition, or
   * §10.11.2's ratified carve-out: `drainChildren`'s own deadline branch
   * administratively finalizing a child whose real reap never lands) does.
   * For a LIVE child, `cancelChildRun` itself never releases anything; the
   * unknown-tab branch below is the ONE exception — an unreapable ghost is
   * tombstoned immediately through the same `finalizeChildRun` funnel
   * (§10.12.5).
   */
  private cancelChildRun(childTabId: string): Promise<void> {
    const childTab = this.tabs.get(childTabId);
    if (childTab === undefined) {
      // A childTabId with no tab can never finalize itself (no host, no
      // late exit ever coming) — tombstone it now through the SAME single
      // release funnel §10.11.2 established for `drainChildren`'s own
      // deadline branch (Luna review R4 / N5), rather than only scrubbing
      // the sibling set below and leaving `childRuns`/`childSpawnKeys`/the
      // ledger entry's start-deadline timer to leak the quota slot forever.
      const requestId = this.findChildRunRequestId(childTabId);
      if (requestId !== undefined) {
        this.finalizeChildRun(requestId, {
          status: "cancelled",
          finalText: CHILD_UNREAPED_MESSAGE,
          truncated: false,
          turns: 0,
          toolCalls: 0,
          durationMs: 0,
        });
      } else {
        // A genuine ghost (no ledger entry either) — drop it from
        // whichever parent's sibling set still names it, rather than let
        // `drainChildren` revisit this ghost on every pass.
        for (const [parentTabId, siblings] of this.childrenByParentTab) {
          if (siblings.delete(childTabId) && siblings.size === 0) {
            this.childrenByParentTab.delete(parentTabId);
          }
        }
      }
      // Settle via a REAL macrotask, for the identical reason the "already
      // closing" branch below does (review T1): a bare `Promise.resolve()`
      // here feeds straight back into `drainChildren`'s `for(;;)` loop and
      // starves the event loop on THIS branch exactly as F1 fixed on that one.
      return new Promise<void>((resolve) => setImmediate(resolve));
    }
    const requestId = childTab.childOf?.requestId;
    const entry = requestId !== undefined ? this.childRuns.get(requestId) : undefined;
    if (entry !== undefined) {
      entry.state = "cancelling";
    }
    if (childTab.state === "closing") {
      // Already shutting down (a second cancel, or the drain loop revisiting
      // a child it already reached) — do not re-send the shutdown message.
      // TASK.102 fix-wave F1: this must NOT settle on a bare microtask. A
      // bare `Promise.resolve()` here fed straight back into `drainChildren`'s
      // `for(;;)` loop turns a revisit into a self-sustaining chain of
      // already-settled microtasks: the loop reschedules itself before the
      // event loop ever reaches a macrotask phase, so the real "exit" (or
      // `ChildTerminal`) that would eventually clear this child from
      // `childrenByParentTab` never gets a turn to run — starving not just
      // this cascade but the whole main-process event loop (IPC, timers,
      // windows, quit). `setImmediate` forces at least one real macrotask
      // per revisit, so the loop can only ever spin bounded by real ticks.
      return new Promise<void>((resolve) => setImmediate(resolve));
    }
    return this.shutdownTabHost(childTab);
  }

  /**
   * Cancels every child currently tracked under `parentTab`, looping until
   * the index is empty (cut §2.6.4's cascade "снапшот-цикл"): a snapshot,
   * not a live iteration, so a run that finalizes mid-batch cannot corrupt
   * the `Set` this function is reading. Reused by `closeTab` (parent closing
   * gracefully), a crashed root's `handleExit` (parent gone unexpectedly),
   * and `relocateTab` (parent about to move workspaces) — same mechanism,
   * cut §0.6's "sync-join невосстановим" applies equally to all three.
   *
   * Postcondition (§10.11.2, ratified): this NEVER returns while
   * `parentTab`'s entry in `childrenByParentTab` is non-empty. A reap
   * deadline expiring on a child whose host never actually exits is an
   * ADMINISTRATIVE reap, not a silent "the next drain retries it" — there
   * may BE no next drain for this child (`closeTab`'s very next line deletes
   * the parent). Every remaining child is tombstoned via `finalizeChildRun`,
   * the SAME single release funnel every other terminal path already uses —
   * §0.7's carve-out: this is the one place a `cancelling` slot is released
   * without a real process reap ever landing.
   *
   * TASK.147 срез 1: also purges `parentTab`'s own queued (not yet
   * admitted) spawn requests, synchronously, as the very first thing this
   * function does — before the loop below, before this call's own first
   * `await`. A waiter is not a running child (it has no host to cancel), so
   * it needs none of the cascade below; it only needs to stop existing.
   */
  private async drainChildren(parentTab: TabHost): Promise<void> {
    this.purgeChildSpawnWaiters(parentTab.tabId);
    this.drainingParents.set(parentTab.tabId, (this.drainingParents.get(parentTab.tabId) ?? 0) + 1);
    try {
      return await this.drainChildrenInner(parentTab);
    } finally {
      const depth = (this.drainingParents.get(parentTab.tabId) ?? 1) - 1;
      if (depth <= 0) this.drainingParents.delete(parentTab.tabId);
      else this.drainingParents.set(parentTab.tabId, depth);
    }
  }

  /** The cascade itself; `drainChildren` wraps it only to hold the `drainingParents` window across every one of its exits. */
  private async drainChildrenInner(parentTab: TabHost): Promise<void> {
    const deadline = this.now() + this.limits.exitDeadlineMs * DRAIN_CHILDREN_DEADLINE_MULTIPLIER;
    for (;;) {
      const childIds = this.childrenByParentTab.get(parentTab.tabId);
      if (childIds === undefined || childIds.size === 0) {
        return;
      }
      if (this.now() >= deadline) {
        // §10.11.2: administrative reap, not a silent continue. Every
        // remaining child (already had its own shutdown/force-kill started
        // by `cancelChildRun` above) is tombstoned here, synchronously,
        // through `finalizeChildRun` — no parallel manual map cleanup, the
        // one release funnel stays the one release funnel.
        const unreaped = childIds.size;
        for (const childTabId of [...childIds]) {
          const requestId = this.findChildRunRequestId(childTabId);
          if (requestId !== undefined) {
            const childTab = this.tabs.get(childTabId);
            this.finalizeChildRun(requestId, {
              status: "cancelled",
              finalText: CHILD_UNREAPED_MESSAGE,
              truncated: false,
              turns: 0,
              toolCalls: 0,
              durationMs: childTab !== undefined ? Math.max(0, this.now() - childTab.spawnedAt) : 0,
            });
          } else {
            // A genuine ghost (no tab, no ledger entry either) — nothing
            // will ever finalize it; drop it directly, same as
            // `cancelChildRun`'s own ghost branch below.
            const siblings = this.childrenByParentTab.get(parentTab.tabId);
            if (siblings?.delete(childTabId) === true && siblings.size === 0) {
              this.childrenByParentTab.delete(parentTab.tabId);
            }
          }
        }
        this.logger.error(
          `[main] drainChildren for tab ${parentTab.tabId}: reap deadline (${this.limits.exitDeadlineMs * DRAIN_CHILDREN_DEADLINE_MULTIPLIER}ms) expired; ${unreaped} child(ren) administratively finalized (cancelled)`,
        );
        return;
      }
      const snapshot = [...childIds];
      await Promise.allSettled(snapshot.map((childTabId) => this.cancelChildRun(childTabId)));
    }
  }

  /**
   * Resolves a childTabId to its owning run's requestId without trusting the
   * tab to still exist (§10.11.2's administrative-reap lookup, shared by
   * `drainChildren`'s deadline branch and `cancelChildRun`'s unknown-tab
   * branch below — the same lookup, not a second one per caller): the tab's
   * own `childOf.requestId` when the tab is still live, else a scan of
   * `childRuns` for the matching `childTabId` (the ghost case — tab already
   * gone, ledger entry not yet finalized).
   */
  private findChildRunRequestId(childTabId: string): string | undefined {
    const childTab = this.tabs.get(childTabId);
    if (childTab?.childOf !== undefined) {
      return childTab.childOf.requestId;
    }
    for (const entry of this.childRuns.values()) {
      if (entry.childTabId === childTabId) {
        return entry.requestId;
      }
    }
    return undefined;
  }

  /**
   * The ONE place a child run's quota slot AND its in-flight
   * `(parentSessionId, spawnToolCallId)` dedup key (cut §10.5 п.3) are freed,
   * and its `terminal` event is relayed to the parent — called at most once
   * per `requestId` (an entry already gone is a no-op, the first-wins
   * discipline that makes a ChildTerminal-message-vs-process-exit race
   * harmless regardless of which arrives first, cut §0.6/anti-facade §5.12).
   * Every terminal path funnels through here — the happy `ChildTerminal`
   * (`handleChildTerminal`), an unreaped crash (`handleChildExit`'s
   * fallback), and a missed `child-ready` (`handleChildStartTimeout`) — so
   * `childSpawnKeys` can never carry a zombie entry past any of them; the
   * ONLY other place that entry is released is `spawnChild`'s own
   * fork-failure `rollback`, for a run that never got this far. Reaps the
   * child's host (fire-and-forget `shutdownTabHost` — skipped if the process
   * is already gone) and removes the child tab from `tabs`: a finished child
   * never holds a live utilityProcess (cut §0's "Завершённый ребёнок НЕ
   * держит utilityProcess").
   *
   * TASK.147 срез 1: this is also the ONE honest slot-release point the
   * queue wakes up on — `pumpChildSpawnQueue` runs at the very end, after
   * every map above has already reached its new steady state, so the
   * waiter(s) it may admit see the SAME freed capacity a caller reading the
   * maps right after this function returns would see.
   */
  private finalizeChildRun(
    requestId: string,
    terminal: {
      status: ChildRunStatus;
      finalText: string;
      truncated: boolean;
      turns: number;
      toolCalls: number;
      durationMs: number;
      /** Additive (CUT-S2 §10.7 п.4/§10.8.2); present only when the caller relays one (>0 at the source). */
      activitySuppressed?: number;
    },
  ): void {
    const entry = this.childRuns.get(requestId);
    if (entry === undefined) {
      return;
    }
    this.childRuns.delete(requestId);
    this.childSpawnKeys.delete(childSpawnKey(entry.parentSessionId, entry.spawnToolCallId));
    if (entry.startDeadline !== undefined) {
      clearTimeout(entry.startDeadline);
    }
    const siblings = this.childrenByParentTab.get(entry.parentTabId);
    siblings?.delete(entry.childTabId);
    if (siblings !== undefined && siblings.size === 0) {
      this.childrenByParentTab.delete(entry.parentTabId);
    }

    const parentTab = this.tabs.get(entry.parentTabId);
    if (parentTab !== undefined) {
      // Best-effort: the parent may already be gone (a drain-cascade running
      // because the parent itself is closing/crashed, cut §2.6.4's "родитель
      // всё равно закрывается").
      this.replyChildRunEvent(parentTab, {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "terminal",
        childSessionId: entry.childSessionId,
        ...terminal,
      });
    }

    // TASK.102 fix-wave F3: tell the renderer THIS tab's host is done, same
    // channel `handleExit` uses for a root — without it, a finished child's
    // `ChildRelation.live` flag in the UI never flips false (no root-tab
    // path ever sends this for a child; the only other caller of this
    // channel is gated behind `tab.childOf === undefined`).
    this.notifyHostExited(entry.childTabId);

    const childTab = this.tabs.get(entry.childTabId);
    if (childTab !== undefined) {
      this.tabs.delete(entry.childTabId);
      if (childTab.proc !== null) {
        void this.shutdownTabHost(childTab);
      }
    }

    this.pumpChildSpawnQueue();
  }

  /** No `child-ready` within CHILD_START_DEADLINE_MS of a successful fork (cut §2.3/§2.6.4). */
  private handleChildStartTimeout(requestId: string): void {
    const entry = this.childRuns.get(requestId);
    if (entry === undefined) {
      return; // already finalized (ready arrived just as the timer fired, or otherwise)
    }
    const childTab = this.tabs.get(entry.childTabId);
    const durationMs = childTab !== undefined ? Math.max(0, this.now() - childTab.spawnedAt) : 0;
    this.finalizeChildRun(requestId, {
      status: "error",
      finalText: CHILD_START_TIMEOUT_MESSAGE,
      truncated: false,
      turns: 0,
      toolCalls: 0,
      durationMs,
    });
  }

  /** child host -> main: sent on the child Session's first ui_ready (§2.6.3), releasing the held initial prompt. */
  private handleChildReady(tab: TabHost, sender: UtilityProcess): void {
    if (tab.proc !== sender || tab.childOf === undefined) {
      return;
    }
    const entry = this.childRuns.get(tab.childOf.requestId);
    if (entry === undefined || entry.state !== "starting") {
      // Unknown (already finalized), or a late/duplicate ready after the run
      // already moved on (e.g. a cancel raced in) — never restart a run that
      // is not, in fact, still starting.
      return;
    }
    if (entry.startDeadline !== undefined) {
      clearTimeout(entry.startDeadline);
      delete entry.startDeadline;
    }
    entry.state = "running";
    const startMsg: ChildStart = { type: CHILD_START_TYPE, prompt: entry.prompt };
    try {
      tab.proc?.postMessage(startMsg);
    } catch (error) {
      this.logger.warn(`[main] failed to post child-start to tab ${tab.tabId}`, error);
    }
  }

  /** child host -> main: coarse progress, relayed to the parent verbatim (minus the ids main already owns). */
  private handleChildProgress(tab: TabHost, sender: UtilityProcess, msg: ChildProgress): void {
    if (tab.proc !== sender || tab.childOf === undefined) {
      return;
    }
    const entry = this.childRuns.get(tab.childOf.requestId);
    if (entry === undefined) {
      return; // already finalized; drop stray progress from a child mid-teardown
    }
    const parentTab = this.tabs.get(entry.parentTabId);
    if (parentTab === undefined) {
      return;
    }
    const base = { type: CHILD_RUN_EVENT_TYPE, requestId: entry.requestId } as const;
    let event: ChildRunEvent;
    switch (msg.kind) {
      case "progress":
        event = {
          ...base,
          kind: "progress",
          turns: msg.turns,
          toolCalls: msg.toolCalls,
          ...(msg.lastTool !== undefined ? { lastTool: msg.lastTool } : {}),
        };
        break;
      case "activity":
        event = { ...base, kind: "activity", toolName: msg.toolName, summary: msg.summary };
        break;
      case "attention":
        event = { ...base, kind: "attention", waiting: msg.waiting };
        break;
      default: {
        // Exhaustiveness guard (mirrors host/child-session-port.ts's own):
        // a new ChildProgress kind fails to compile here.
        const _exhaustive: never = msg;
        void _exhaustive;
        return;
      }
    }
    this.replyChildRunEvent(parentTab, event);
  }

  /**
   * child host -> main: sent exactly once, only after the child's history is
   * durably flushed (cut §0.5). This is the HAPPY/ERROR/self-reported-cancel
   * path; a child that dies WITHOUT ever sending this is caught by
   * `handleChildExit`'s fallback below instead — whichever arrives first
   * finalizes (first-wins, see `finalizeChildRun`).
   */
  private handleChildTerminal(tab: TabHost, sender: UtilityProcess, msg: ChildTerminal): void {
    if (tab.proc !== sender || tab.childOf === undefined) {
      return;
    }
    const requestId = tab.childOf.requestId;
    // TASK.102 fix-wave F6: a self-reported ChildTerminal can race an
    // in-flight `child-run-cancel` — the child's own turn finished (or was
    // already computing its result) right as main told it to stop. Once the
    // ledger has moved to `cancelling`, main already committed to cancelling
    // this run; the child's self-reported status must not un-commit that,
    // or the parent sees a stale "completed"/"error" terminal for a run it
    // was just told is cancelled.
    const cancelling = this.childRuns.get(requestId)?.state === "cancelling";
    this.finalizeChildRun(requestId, {
      status: cancelling ? "cancelled" : msg.status,
      finalText: cancelling ? CHILD_CANCELLED_MESSAGE : msg.finalText,
      truncated: msg.truncated,
      turns: msg.turns,
      toolCalls: msg.toolCalls,
      durationMs: msg.durationMs,
      // Verbatim passthrough (CUT-S2 §10.7 п.4/§10.8.2's §3 B3 relay matrix):
      // main never recomputes or reinterprets the count, it only relays what
      // the child itself reported. Not overridden by the cancel-race above:
      // it is orthogonal to `status`/`finalText`, both of which the cut's
      // §10.8.2 п.3 wording ratifies verbatim for a cancelled run.
      ...(msg.activitySuppressed !== undefined ? { activitySuppressed: msg.activitySuppressed } : {}),
    });
  }

  /**
   * A child tab's host exited without ever sending its own `ChildTerminal`
   * (crash, or a force-kill past `shutdownTabHost`'s deadline). Children
   * NEVER respawn (cut §0.6) — this is the fallback finalize, not a
   * decision point. `cancelling` at the time of exit means WE killed it
   * (cascade/explicit cancel) -> `cancelled`; any other state means it died
   * on its own -> `error` (cut §2.7's crash text).
   */
  private handleChildExit(tab: TabHost, child: UtilityProcess, _code: number, forceKilled = false): void {
    if (tab.proc !== child && !forceKilled) {
      // Stale-generation exit from an already-superseded reference — UNLESS
      // this is the late, real exit of a process `shutdownTabHost`'s own
      // timeout branch force-killed and pre-emptively nulled `tab.proc` for
      // (TASK.102 fix-wave F2). A child tab never respawns, so `forceKilled`
      // is the ONLY legitimate reason `tab.proc` can differ from `child`
      // here while this is still the exit we are waiting on.
      return;
    }
    tab.proc = null;
    tab.state = "closing";
    const requestId = tab.childOf?.requestId;
    if (requestId === undefined) {
      this.tabs.delete(tab.tabId); // defensive; a child tab always carries childOf
      return;
    }
    const entry = this.childRuns.get(requestId);
    if (entry === undefined) {
      // Already finalized via ChildTerminal (or a previous exit) — this is
      // the fire-and-forget reap's own exit landing; nothing left to do
      // beyond making sure the tab is not left registered.
      this.tabs.delete(tab.tabId);
      return;
    }
    const status: ChildRunStatus = entry.state === "cancelling" ? "cancelled" : "error";
    const finalText = entry.state === "cancelling" ? CHILD_CANCELLED_MESSAGE : CHILD_HOST_EXITED_MESSAGE;
    this.finalizeChildRun(requestId, {
      status,
      finalText,
      truncated: false,
      turns: 0,
      toolCalls: 0,
      durationMs: Math.max(0, this.now() - tab.spawnedAt),
    });
  }

  /**
   * Re-binds a running tab to another provider connection (TASK.106 cut-2 §D1):
   * the provider is baked into the fork env (base env, `ANYCODE_API_KEY`,
   * `ANYCODE_MODEL`, the proxy family — TASK.132/TASK.133 measured that mutating
   * a live process's env does NOT take effect), so the only honest switch is the
   * one `relocateTab` already performs for a workspace move — drain children,
   * shut the host down, mutate the tab's own fields, re-spawn on the resume path,
   * deliver a fresh port. The session id, tab row, and terminal panel all survive;
   * the transcript re-hydrates from history exactly as it does after a respawn.
   *
   * Fail-closed BEFORE any mutation: a target whose per-connection fork env is not
   * primed refuses `not_ready` with the tab still running on its original host —
   * mutating first would leave the tab shut down and unspawnable (`spawnTabHost`
   * refuses a missing env, W10-FIX F3), i.e. a broken tab as the price of a typo.
   *
   * The breakers do not count this: `shutdownTabHost` marks the tab `closing`, and
   * `handleExit` returns on that guard before `decideRespawn` ever runs.
   * `rapidRespawns` is reset for the same reason `relocateTab` resets it — a new
   * process on a new account is a new epoch, not a continuation of a crash streak.
   */
  async rebindTab(tab: TabHost, connectionId: string): Promise<{ ok: true } | { ok: false; reason: "not_ready" }> {
    if (this.env(connectionId) === undefined) {
      this.logger.error(
        `[main] tab ${tab.tabId} rebind to ${connectionId} refused: no primed fork env for that connection`,
      );
      return { ok: false, reason: "not_ready" };
    }
    // A rebind is as terminal for an in-flight child as a rehost is (cut §0.6):
    // the parent is about to run on a different account entirely.
    await this.drainChildren(tab);
    await this.shutdownTabHost(tab);
    tab.connectionId = connectionId;
    // The target connection's own env model is the authority for the new host
    // (core reads its model off the fork env on a resume boot); a stale per-fork
    // override from an imported session must not follow the tab to another account.
    delete tab.modelOverride;
    tab.initialResume = true;
    tab.rapidRespawns = 0;
    tab.state = "running";
    this.spawnTabHost(tab, { firstSpawn: false });
    this.deliverTabPort(tab);
    return { ok: true };
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
    // TASK.102 fix-wave F5 / cut §0.6: a rehost is, from the CHILD's point of
    // view, exactly as terminal as a graceful close or a crash — the master
    // is about to run at a different workspace/branch entirely, so any
    // in-flight child must be cancelled first (`closeTab` and the crashed-
    // root respawn path in `handleExit` both already do this; only this
    // rehost path was missing it, leaving live children running against a
    // parent that has since moved on).
    await this.drainChildren(tab);
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
    // TASK.102 fix-wave F2 / review T3: read the snapshot BEFORE deleting —
    // consumed once, regardless of root/child. A root never needed the F2
    // half (its own `state === "closing"` guard below already short-circuits
    // before any staleness check), but must not leave a stale entry behind
    // either; the T3 half (the engine-process registration snapshot) applies
    // to roots specifically, since only a root ever carries one.
    const forceKilledRegistration = this.forceKilledExits.get(child);
    const forceKilled = this.forceKilledExits.delete(child);
    this.reapEngineProcess(tab, child, forceKilledRegistration);
    if (tab.childOf !== undefined) {
      // TASK.102 CUT-S2 §2.6.4: a child tab's exit is never a respawn
      // decision — it is caught (and finalized) here unconditionally,
      // regardless of `quitting`/`state`, since there is no "unexpected
      // respawn" to guard against for a tab that never respawns.
      this.handleChildExit(tab, child, code, forceKilled);
      return;
    }
    if (this.quitting || tab.state === "closing") {
      this.logger.log(`[main] tab ${tab.tabId} host exited during shutdown (code ${code})`);
      return;
    }
    if (tab.proc !== child) {
      // Stale exit from an already-replaced host; ignore.
      return;
    }
    tab.proc = null;

    // TASK.102 CUT-S2 §0.6: a dead root cannot resume its children's
    // sync-join ("sync-join невосстановим") — cancel them before any
    // respawn attempt, whether respawn actually happens or the breaker gives
    // up below. Fire-and-forget: an async function's synchronous PREFIX
    // (state flip + shutdown postMessage for every currently-tracked child)
    // runs to completion before this call returns control here — JS runs an
    // async function body synchronously up to its first `await` — so this
    // reliably precedes `spawnTabHost` below without making `handleExit`
    // itself async (every synchronous respawn assertion in this suite
    // depends on `handleExit` staying fully synchronous end to end).
    void this.drainChildren(tab);

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

  /**
   * `forceKilledRegistration` is `undefined` for an ordinary (non-force-
   * killed) exit — the ordinary `tab.proc === child` staleness check below
   * applies. It is `EngineProcessRegistration | null` for a force-killed
   * exit (review T3): `tab.proc` was already nulled by `shutdownTabHost`'s
   * timeout branch, before this late exit ever arrived, so `tab.proc ===
   * child` can never be true for it again — that check would otherwise
   * always fail closed and leak the external engine process group forever.
   * Reap the SNAPSHOT taken at force-kill time instead: it names exactly the
   * child that was force-killed, so it can never be confused with a newer
   * (respawned) generation's own engine — that one gets reaped on ITS OWN
   * eventual exit, off ITS OWN snapshot, never this one.
   */
  private reapEngineProcess(
    tab: TabHost,
    child: UtilityProcess,
    forceKilledRegistration?: EngineProcessRegistration | null,
  ): void {
    if (forceKilledRegistration !== undefined) {
      if (forceKilledRegistration === null) {
        return; // nothing was registered for this tab when it was force-killed
      }
      try {
        this.deps.reapEngineProcess?.(forceKilledRegistration);
      } catch (error) {
        this.logger.warn(`[main] failed to reap external engine for tab ${tab.tabId}`, error);
      }
      return;
    }
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
    // TASK.45 W10-FIX F2: additive control-plane pin metadata. Both fields ride
    // together or not at all — a since-deleted pin (describeConnection -> undefined)
    // omits both so the renderer falls back to the active connection rather than
    // targeting a dead one. This is NOT the session-stream (protocol.ts untouched).
    const pin =
      tab.connectionId !== undefined ? this.deps.describeConnection?.(tab.connectionId) : undefined;
    win.webContents.postMessage(
      PORT_ENVELOPE_TYPE,
      {
        tabId: tab.tabId,
        workspace: tab.workspace,
        ...(tab.connectionId !== undefined && pin !== undefined
          ? { connectionId: tab.connectionId, providerId: pin.providerId }
          : {}),
        // TASK.102 CUT-S2 §2.5: stamped ONLY for a child-session tab — this is
        // what lets `tab-registry.registerPort` (S2c) classify the port as a
        // child and skip ordinary root-tab registration (no addTab, no
        // Sidebar/StartScreen/CommandPalette visibility, §0.4's skip-hide
        // contract). `childSessionId` is this tab's OWN sessionId.
        ...(tab.childOf !== undefined
          ? {
              child: {
                parentTabId: tab.childOf.parentTabId,
                parentSessionId: tab.childOf.parentSessionId,
                spawnToolCallId: tab.childOf.spawnToolCallId,
                childSessionId: tab.sessionId,
              },
            }
          : {}),
      },
      [channel.port2],
    );
    this.logger.log(`[main] delivered fresh MessageChannel to tab ${tab.tabId}`);

    if (tab.childOf !== undefined) {
      // TASK.102 CUT-S2 §2.5: "Терминальный порт ребёнку НЕ доставляется" — a
      // child session has no PTY-backed tab surface, so main simply never
      // sends this second channel for one (mirrors how every other
      // as-yet-unwired control-plane message is just not sent).
      return;
    }

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
      // Review T2: two `shutdownTabHost` calls can overlap on the same
      // `child` (an explicit parent cancel racing a self-reported
      // ChildTerminal's own reap call, both capturing `child = tab.proc`
      // before either nulls it). If the OTHER call already force-killed and
      // nulled `tab.proc`, this one is the loser of that race — its own
      // deadline elapsing here says nothing new; the process is already
      // being torn down. Only the call that still recognizes the tab's
      // CURRENT process does the force-kill bookkeeping, so a losing racer
      // cannot redundantly re-kill an already-dying process.
      if (tab.proc === child) {
        this.logger.error(
          `[main] tab ${tab.tabId} host did not exit within ${this.limits.exitDeadlineMs}ms; force killing`,
        );
        // TASK.102 fix-wave F2 / review T3: `tab.proc` is about to be nulled
        // below even though `child` has not actually exited yet — record the
        // reference so its late, real "exit" is still recognized as current
        // (not stale) by `handleChildExit` when it eventually lands, paired
        // with a snapshot of whatever engine-process registration this tab
        // carried AT THIS EXACT MOMENT (before any later respawn could reset
        // `tab.engineProcess` out from under it), so `reapEngineProcess` can
        // still reap it off that late exit instead of leaking it forever.
        this.forceKilledExits.set(child, tab.engineProcess);
        child.kill();
        // Luna review R2 MAJOR (N4): this null belongs ONLY to the call that
        // still recognizes `tab.proc` as ITS `child` — the exact same
        // condition already guarding the force-kill above. A losing racer
        // (this guard false) must not null out a NEWER generation's `proc`
        // that a respawn/relocate already installed while this call was
        // still waiting on its own, now-irrelevant deadline.
        tab.proc = null;
      }
    } else {
      this.logger.log(`[main] tab ${tab.tabId} host exited gracefully within deadline`);
      // Same guard as the timeout branch above (N4): only the call whose
      // own `child` is still the tab's CURRENT process may clear it.
      if (tab.proc === child) {
        tab.proc = null;
      }
    }
  }

  /**
   * Closes a single tab (design §2.2/§4.1): refuses the last remaining tab (no
   * "window with zero hosts" state) and unknown ids; otherwise gracefully shuts
   * the host and drops the tab + its binding.
   */
  async closeTab(tabId: string): Promise<CloseTabResult> {
    const tab = this.tabs.get(tabId);
    // TASK.102 CUT-S2 §2.6.4: a child session is not externally addressable —
    // closing one by id reads as "no such tab" to the public API, exactly
    // like a genuinely-unknown id (children are invisible outside the
    // manager, §0.4's skip-hide contract extended to the close path).
    if (tab === undefined || tab.childOf !== undefined) {
      return { ok: false, reason: "unknown_tab" };
    }
    // last_tab counts ROOTS only (§2.6.4): a root with live children is
    // still the application's only root and must not be closable, and
    // conversely a root's children must never inflate the denominator into
    // falsely allowing (or blocking) a close.
    if (this.rootCount() <= 1) {
      return { ok: false, reason: "last_tab" };
    }
    // Seal FIRST, synchronously, before any await (cut §2.6.4/anti-facade
    // §5.8): a spawn request racing in after this line sees `state !==
    // "running"` and is rejected `closing` by `spawnChild`'s admission
    // section. Anything admitted BEFORE this line is already registered in
    // `childrenByParentTab` and is swept by the drain below.
    tab.state = "closing";
    await this.drainChildren(tab);
    await this.shutdownTabHost(tab);
    this.tabs.delete(tabId);
    this.bindings.delete(tab.sessionId);
    // Preview windows belong to the TAB, not the host proc — a respawn must
    // never close them, but a real close (here) must always destroy them.
    this.deps.onTabClosed?.(tabId);
    return { ok: true };
  }

  /**
   * Shuts every host down in PARALLEL (design §2.2): quit with 8 tabs costs the
   * same ~2s wall-clock as one, because each host aborts its own turn and runs
   * its own SIGTERM->SIGKILL child chain from t=0. Called by before-quit.
   *
   * TASK.147 срез 1: also purges EVERY queued spawn request application-wide
   * (no `parentTabId` filter — the whole app is going down), synchronously,
   * before any of the `shutdownTabHost` calls below even start their async
   * work — unlike a single tab's `drainChildren`, this function never visits
   * `drainChildren` per tab (it shuts every host down directly), so nothing
   * else would ever purge a waiter here.
   */
  async shutdownAllTabHosts(): Promise<void> {
    this.quitting = true;
    this.purgeChildSpawnWaiters();
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
