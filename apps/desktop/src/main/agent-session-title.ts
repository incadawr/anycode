/**
 * The Sessions API `handle` as the tab's DURABLE title.
 *
 * An agent-opened tab is titled by the `handle` accepted on `create_session`,
 * not by the first message's payload (which is the model-facing envelope, so a
 * payload-derived title reads `[AnyCode authenticated agent message {"…`). The
 * handle alone used to live in an in-memory map, so it survived while the app
 * ran and vanished on the next boot, when the payload title from SQLite came
 * back.
 *
 * This module owns the three pieces that make the handle durable:
 *
 * - a RETAINED push queue: `create_session` never fails because the host could
 *   not take the title yet (a booting, exiting or respawning host), so a
 *   rejected push stays retained and is retried on the tab's next host
 *   generation (every `deliverTabPort` — spawn, respawn, resume);
 * - a DURABLE title marker: every acknowledged title is recorded (sessionId ->
 *   the title a host committed), so a later resume can tell the title the agent
 *   wrote apart from a title something else wrote afterwards;
 * - a RESUME-TIME repair: a session created before this existed still carries
 *   an automatically generated title in SQLite (the raw delivery envelope)
 *   while its handle sits in the handles file, and a session this version
 *   creates whose title push never landed carries whatever the store held.
 *   The saved handle replaces such a title — but only when the row is KNOWN to
 *   have been titled by the app rather than by the user (see
 *   `recoverAgentSessionTitle`).
 *
 * The host acknowledges `set_agent_title` only after its persistence write
 * committed, so "not retained any more" means "a later boot reads this title".
 */

import { AGENT_MESSAGE_HEADER_PREFIX } from "../shared/communication.js";

export interface AgentTitlePushDeps {
  /** The retained title of a session, if one is known. */
  titleOf(sessionId: string): string | undefined;
  /** Host RPC; resolves only once the host committed the title. */
  request(sessionId: string, title: string): Promise<unknown>;
  /**
   * Durable marker, recorded once a host confirmed `title` as this session's
   * stored title. Best effort by contract: it must never turn a successful
   * acknowledgement into a failed one.
   */
  confirmed?(sessionId: string, title: string): void;
  /** Best-effort diagnostics; never rethrown. */
  warn(message: string, error: unknown): void;
  /**
   * How long to wait before trying a retained title again (milliseconds), or 0
   * for no timer at all. A push can fail while the tab's process is still
   * booting; the next host generation is not guaranteed to come (a tab can
   * live for hours), so a retained title also retries on its own.
   */
  retryDelayMs?(): number;
  /** Timer seam; defaults to setTimeout, returns a cancel. */
  schedule?(run: () => void, delayMs: number): () => void;
  /**
   * Cap on consecutive self-scheduled attempts before the timer gives up (a
   * crash-looped tab has no host to answer). The title stays retained: the
   * next host generation still retries it. Default 12 (about a minute).
   */
  maxRetryAttempts?: number;
}

export interface AgentTitlePushes {
  /** Retain a session's title; `push` it right away. */
  retain(sessionId: string): void;
  /** The session is gone — forget its title (never resurrect it on a later host). */
  forget(sessionId: string): void;
  /** Push the retained title now. A failure keeps it retained for the next attempt. */
  push(sessionId: string): void;
  /** Push again, but only when an earlier push never reached the host. */
  retry(sessionId: string): void;
  /** Sessions whose title has not been durably acknowledged yet (tests/diagnostics). */
  pendingSessions(): string[];
}

export function createAgentTitlePushes(deps: AgentTitlePushDeps): AgentTitlePushes {
  /** Not yet acknowledged by a host (rejected, timed out or never attempted). */
  const pending = new Set<string>();
  /** In-flight per session, so one generation's attempt never doubles up. */
  const inFlight = new Set<string>();
  /** One scheduled retry per session while its title is still pending. */
  const timers = new Map<string, () => void>();
  /** Consecutive timer-driven attempts per session (reset by a generation retry). */
  const timerAttempts = new Map<string, number>();
  const maxTimerAttempts = deps.maxRetryAttempts ?? 12;

  const cancelTimer = (sessionId: string): void => {
    timers.get(sessionId)?.();
    timers.delete(sessionId);
  };

  const scheduleRetry = (sessionId: string): void => {
    const schedule = deps.schedule;
    const delayMs = deps.retryDelayMs?.() ?? 0;
    if (schedule === undefined || delayMs <= 0 || timers.has(sessionId)) return;
    const attempts = timerAttempts.get(sessionId) ?? 0;
    if (attempts >= maxTimerAttempts) return;
    timerAttempts.set(sessionId, attempts + 1);
    const cancel = schedule(() => {
      timers.delete(sessionId);
      if (pending.has(sessionId)) push(sessionId);
    }, delayMs);
    timers.set(sessionId, cancel);
  };

  const push = (sessionId: string): void => {
    const title = deps.titleOf(sessionId);
    if (title === undefined || inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    void (async () => {
      try {
        await deps.request(sessionId, title);
        // Record WHY this title is the stored one before dropping the retry:
        // a later resume then knows the row holds an agent-chosen title.
        try {
          deps.confirmed?.(sessionId, title);
        } catch (error) {
          deps.warn(`[main] failed to record the confirmed agent title for ${sessionId}`, error);
        }
        // The host committed the title: nothing left to retry.
        pending.delete(sessionId);
        cancelTimer(sessionId);
      } catch (error) {
        pending.add(sessionId);
        deps.warn(`[main] failed to push agent session title for ${sessionId}`, error);
        scheduleRetry(sessionId);
      } finally {
        inFlight.delete(sessionId);
      }
    })();
  };

  return {
    retain(sessionId) {
      pending.add(sessionId);
      push(sessionId);
    },
    forget(sessionId) {
      pending.delete(sessionId);
      timerAttempts.delete(sessionId);
      cancelTimer(sessionId);
    },
    push,
    retry(sessionId) {
      if (!pending.has(sessionId)) return;
      // A new host generation is a fresh, better chance: restart the budget.
      timerAttempts.delete(sessionId);
      cancelTimer(sessionId);
      push(sessionId);
    },
    pendingSessions() {
      return [...pending];
    },
  };
}

export interface RecoverAgentTitleDeps {
  sessionId: string;
  /** The handle saved in the handles file (durable across restarts). */
  savedHandle(): string | undefined;
  /**
   * True only when a DURABLE marker says an agent opened this session through
   * `create_session` (written at creation time). A saved handle is not enough:
   * the user can assign one to an ordinary session from the environment menu,
   * and that session's title is not the agent's to replace.
   */
  openedByAgent(): boolean;
  /**
   * The title a host last confirmed for this session — the durable marker that
   * says which title the agent itself wrote. Absent for a session created
   * before that marker existed, and for one whose write never landed.
   */
  confirmedTitle(): string | undefined;
  /** The title SQLite holds for this session, if the row is readable. */
  readPersistedTitle(): Promise<string | undefined>;
  /** Adopt the handle as this session's title (in-memory map + retained push). */
  adopt(title: string): void;
}

/**
 * Resume-time repair of an agent-opened tab whose stored title is not its
 * handle. Returns whether a repair was started.
 *
 * The decision, in order:
 *
 * 1. No saved handle — not a session whose title the handle owns: never touch
 *    the title.
 * 2. A confirmed title on record — the stored title was written after the
 *    agent's own write and confirmed again, so it is someone else's choice (or
 *    already the handle): leave it, without even a database read.
 * 3. A stored title that IS the handle — nothing to do.
 * 4. Otherwise the title may be repaired ONLY when the app is known to have
 *    written it:
 *      - the session carries the durable agent-opened marker (rows written
 *        from this version on), or
 *      - the stored title begins with the raw delivery-envelope header, the one
 *        title text no user can have chosen (rows written before it).
 *    Anything else — in particular an ordinary session whose handle the user
 *    assigned by hand — keeps the title it has.
 */
export async function recoverAgentSessionTitle(deps: RecoverAgentTitleDeps): Promise<boolean> {
  const handle = deps.savedHandle();
  if (handle === undefined) return false;
  const confirmed = deps.confirmedTitle();
  if (confirmed !== undefined) return false;
  let persisted: string | undefined;
  try {
    persisted = await deps.readPersistedTitle();
  } catch {
    // An unreadable row must never block a resume; the next host generation retries.
    return false;
  }
  if (persisted === handle) return false;
  // Repair only a title the app is known to have generated: the durable
  // agent-opened marker this version writes at create_session time, or (for
  // rows written before it) the raw envelope header, which is never a title a
  // user chose.
  const automatic = deps.openedByAgent() || (persisted !== undefined && persisted.startsWith(AGENT_MESSAGE_HEADER_PREFIX));
  if (!automatic) return false;
  deps.adopt(handle);
  return true;
}
