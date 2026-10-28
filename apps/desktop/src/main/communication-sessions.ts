/**
 * Main-owned per-session Sessions API switch (Taskana 4747 owner amendment).
 * The unit of exposure is the SESSION: only sessions switched on appear in
 * `list_sessions` and accept messages. State is keyed by the durable sessionId
 * (so it survives restart and resume), stored in a 0600 file beside the
 * settings, and written only by main. The renderer never supplies a path.
 *
 * Fail closed: an unknown id is not exposed; a corrupt file reads as empty;
 * a non-boolean entry is dropped.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { communicationSettingsSchema } from "../settings/schema.js";

const fileSchema = z.record(z.string(), z.unknown());

export interface SessionAccessStoreDeps {
  /** Absolute path of the per-session switch file (under the user-data directory). */
  file: string;
  /** Initial switch state for a NEW session (settings.communication.defaultSessionAccess === "on"). */
  defaultOn(): boolean;
  /**
   * Absolute path of the handles file (a SECOND private file: the boolean switch
   * file format stays unchanged, because older builds drop non-boolean entries).
   * Absent = handles are kept in memory only.
   */
  handlesFile?: string;
  /**
   * Absolute path of the title-confirmation file (a THIRD private file): for
   * each session whose handle a host confirmed as the stored title, the title
   * that was confirmed. This is the durable marker that tells a title the agent
   * wrote apart from a title chosen later by the user — a resume-time repair
   * must never overwrite the latter. Absent = in memory only.
   */
  titleConfirmationsFile?: string;
}

export type SetHandleFailure = "unknown_session" | "invalid" | "duplicate" | "io_error";

export interface SessionAccessStore {
  isExposed(sessionId: string): boolean;
  /** Ensures a switch entry exists. A child inherits its parent's switch; a resumed session keeps its own. A child never inherits a handle. */
  register(info: { sessionId: string; parentSessionId?: string }): boolean | void;
  remove(sessionId: string): void;
  /** Sets the switch of a KNOWN session; false (and no change) for an unknown one. */
  set(sessionId: string, enabled: boolean): boolean;
  exposedCount(): number;
  /** The stored handle of a session, if any. Callers surface it only for live, exposed sessions. */
  getHandle(sessionId: string): string | undefined;
  /**
   * Sets (or, with null, clears) the handle of a KNOWN session. Uniqueness is
   * checked among LIVE sessions only (`isLive`), so a dead session's stale
   * handle never blocks reuse. Fail closed: a failed write keeps the previous handle.
   */
  setHandle(sessionId: string, handle: string | null, isLive: (sessionId: string) => boolean): { ok: true } | { ok: false; reason: SetHandleFailure };
  /** The live session currently holding `handle`, if any. */
  sessionIdByHandle(handle: string, isLive: (sessionId: string) => boolean): string | undefined;
  /**
   * The title a host CONFIRMED for this session — recorded the moment a title
   * write committed. Durable, so a later resume can tell "the agent's title is
   * still the stored one" from "something else wrote a title afterwards".
   */
  getConfirmedTitle(sessionId: string): string | undefined;
  /**
   * Records that `title` is now the stored title of this session (called after
   * the host acknowledged the write). Best effort: a failed file write keeps the
   * in-memory marker, and never undoes the acknowledgement.
   */
  confirmTitle(sessionId: string, title: string): void;
}

/** Session handle: lowercase letters, digits and `_ . @ -`; first char alphanumeric; 1..64 chars. No case folding. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.@-]{0,63}$/;

/**
 * Pure normalization for user input. Trim only. Empty after trim = clear
 * (`handle: null`), which is not an error. Anything else must match the pattern
 * exactly, so uppercase input is INVALID rather than silently lowered.
 */
export function normalizeHandle(raw: string | null | undefined): { ok: true; handle: string | null } | { ok: false; reason: "invalid" } {
  if (raw === null || raw === undefined) return { ok: true, handle: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, handle: null };
  return HANDLE_PATTERN.test(trimmed) ? { ok: true, handle: trimmed } : { ok: false, reason: "invalid" };
}

function loadHandles(file: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!file) return map;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) for (const [id, value] of Object.entries(parsed.data)) if (typeof value === "string" && HANDLE_PATTERN.test(value)) map.set(id, value);
  } catch { /* corrupt or absent: empty */ }
  return map;
}

/**
 * The title-confirmation marker: sessionId -> the title a host committed last.
 * Any non-empty string is a valid title, so the only validation is the shape of
 * the file itself (a record of strings); a corrupt file reads as empty.
 */
function loadConfirmations(file: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!file) return map;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) {
      for (const [id, value] of Object.entries(parsed.data)) {
        if (typeof value === "string" && value.length > 0) map.set(id, value);
      }
    }
  } catch { /* corrupt or absent: empty */ }
  return map;
}

function load(file: string): Map<string, boolean> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    const map = new Map<string, boolean>();
    if (parsed.success) for (const [id, value] of Object.entries(parsed.data)) if (typeof value === "boolean") map.set(id, value);
    return map;
  } catch {
    return new Map();
  }
}

function persist(file: string, map: Map<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(map)), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createSessionAccessStore(deps: SessionAccessStoreDeps): SessionAccessStore {
  const map = load(deps.file);
  const handles = loadHandles(deps.handlesFile);
  const confirmations = loadConfirmations(deps.titleConfirmationsFile);
  /**
   * Fail closed, like the other private files: a write that did not land is
   * rolled back, so the marker never claims something the file does not hold.
   */
  const persistConfirmations = (sessionId: string, title: string): void => {
    if (deps.titleConfirmationsFile === undefined) return;
    const previous = confirmations.get(sessionId);
    confirmations.set(sessionId, title);
    try {
      persist(deps.titleConfirmationsFile, confirmations);
    } catch {
      if (previous === undefined) confirmations.delete(sessionId);
      else confirmations.set(sessionId, previous);
    }
  };
  return {
    getHandle(sessionId) {
      return handles.get(sessionId);
    },
    setHandle(sessionId, handle, isLive) {
      if (!map.has(sessionId)) return { ok: false, reason: "unknown_session" };
      if (handle !== null && !HANDLE_PATTERN.test(handle)) return { ok: false, reason: "invalid" };
      const previous = handles.get(sessionId);
      if (handle === previous) return { ok: true };
      if (handle !== null) {
        for (const [other, value] of handles) if (value === handle && other !== sessionId && isLive(other)) return { ok: false, reason: "duplicate" };
      }
      if (handle === null) handles.delete(sessionId); else handles.set(sessionId, handle);
      // A cleared handle makes its confirmation meaningless: the marker only
      // says which handle a host stored. A stale marker left on disk is
      // harmless (it only ever suppresses a repair), so this is best effort.
      if (handle === null) {
        confirmations.delete(sessionId);
        if (deps.titleConfirmationsFile !== undefined) {
          try { persist(deps.titleConfirmationsFile, confirmations); } catch { /* stale marker is harmless */ }
        }
      }
      if (deps.handlesFile) {
        try {
          persist(deps.handlesFile, handles);
        } catch {
          // Fail closed: the change did not persist, so it does not take effect.
          if (previous === undefined) handles.delete(sessionId); else handles.set(sessionId, previous);
          return { ok: false, reason: "io_error" };
        }
      }
      return { ok: true };
    },
    sessionIdByHandle(handle, isLive) {
      for (const [id, value] of handles) if (value === handle && isLive(id)) return id;
      return undefined;
    },
    getConfirmedTitle(sessionId) {
      return confirmations.get(sessionId);
    },
    confirmTitle(sessionId, title) {
      if (confirmations.get(sessionId) === title) return;
      persistConfirmations(sessionId, title);
    },
    isExposed(sessionId) {
      return map.get(sessionId) === true;
    },
    register({ sessionId, parentSessionId }) {
      if (map.has(sessionId)) return false;
      const inherited = parentSessionId !== undefined ? map.get(parentSessionId) : undefined;
      map.set(sessionId, inherited ?? deps.defaultOn());
      // A failed write must never fail tab creation: the in-memory value still answers.
      try { persist(deps.file, map); } catch { /* retried on the next change */ }
      return true;
    },
    remove(sessionId) {
      map.delete(sessionId);
      handles.delete(sessionId);
      confirmations.delete(sessionId);
      try { persist(deps.file, map); } catch { /* best effort */ }
      if (deps.handlesFile) try { persist(deps.handlesFile, handles); } catch { /* best effort */ }
      if (deps.titleConfirmationsFile) try { persist(deps.titleConfirmationsFile, confirmations); } catch { /* best effort */ }
    },
    set(sessionId, enabled) {
      if (!map.has(sessionId)) return false;
      const previous = map.get(sessionId);
      map.set(sessionId, enabled);
      try {
        persist(deps.file, map);
      } catch {
        // Fail closed: the change did not persist, so it does not take effect.
        if (previous === undefined) map.delete(sessionId); else map.set(sessionId, previous);
        return false;
      }
      return true;
    },
    exposedCount() {
      return [...map.values()].filter(Boolean).length;
    },
  };
}

/** Reads `communication.defaultSessionAccess` synchronously (a new tab reads it at registration). Fail closed: off. */
export function defaultSessionAccessFromSettingsFile(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { communication?: unknown };
    return communicationSettingsSchema.parse(raw.communication)?.defaultSessionAccess === "on";
  } catch {
    return false;
  }
}
