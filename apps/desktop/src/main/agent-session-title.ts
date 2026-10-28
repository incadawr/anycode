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
 * This module owns the two halves that make the handle durable:
 *
 * - a RETAINED push queue: `create_session` never fails because the host could
 *   not take the title yet (a booting, exiting or respawning host), so a
 *   rejected push stays retained and is retried on the tab's next host
 *   generation (every `deliverTabPort` — spawn, respawn, resume);
 * - a RESUME-TIME repair: a session created before this existed still carries
 *   the payload title in SQLite while its handle sits in the handles file.
 *   When the persisted title is exactly that envelope-derived fallback, the
 *   saved handle replaces it — a title the user renamed is left alone.
 *
 * The host acknowledges `set_agent_title` only after its persistence write
 * committed, so "not retained any more" means "a later boot reads this title".
 */

/** Prefix of the model-facing envelope line `agentMessageText()` writes. */
export const ENVELOPE_TITLE_PREFIX = "[AnyCode authenticated agent message ";

/**
 * True when a persisted session title is the payload-derived fallback of an
 * agent delivery — i.e. exactly the title this fix repairs. A title the user
 * renamed (or any other title) never matches.
 */
export function isEnvelopeDerivedTitle(title: string | undefined): boolean {
  return title !== undefined && title.startsWith(ENVELOPE_TITLE_PREFIX);
}

export interface AgentTitlePushDeps {
  /** The retained title of a session, if one is known. */
  titleOf(sessionId: string): string | undefined;
  /** Host RPC; resolves only once the host committed the title. */
  request(sessionId: string, title: string): Promise<unknown>;
  /** Best-effort diagnostics; never rethrown. */
  warn(message: string, error: unknown): void;
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

  const push = (sessionId: string): void => {
    const title = deps.titleOf(sessionId);
    if (title === undefined || inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    void (async () => {
      try {
        await deps.request(sessionId, title);
        pending.delete(sessionId);
      } catch (error) {
        pending.add(sessionId);
        deps.warn(`[main] failed to push agent session title for ${sessionId}`, error);
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
    },
    push,
    retry(sessionId) {
      if (pending.has(sessionId)) push(sessionId);
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
  /** The title SQLite holds for this session, if the row is readable. */
  readPersistedTitle(): Promise<string | undefined>;
  /** Adopt the handle as this session's title (in-memory map + retained push). */
  adopt(title: string): void;
}

/**
 * Resume-time repair of a pre-fix agent tab: only rewrites a title that is the
 * payload-derived fallback, and only when the handles file still has a handle
 * for that session. Returns whether a repair was started.
 */
export async function recoverAgentSessionTitle(deps: RecoverAgentTitleDeps): Promise<boolean> {
  const handle = deps.savedHandle();
  if (handle === undefined) return false;
  let persisted: string | undefined;
  try {
    persisted = await deps.readPersistedTitle();
  } catch {
    // An unreadable row must never block a resume; the next host generation retries.
    return false;
  }
  if (!isEnvelopeDerivedTitle(persisted)) return false;
  deps.adopt(handle);
  return true;
}
