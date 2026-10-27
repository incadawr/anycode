/**
 * Main-owned per-session "Full browser access" switch (Taskana 4759 owner
 * amendment). Modelled on the Sessions API switch (communication-sessions.ts):
 * state is keyed by the durable sessionId (survives restart and resume), stored
 * in a 0600 `browser-access.json` beside the user data, and written only by main.
 *
 * Rules that differ from the Sessions API store:
 *  - a CHILD session is ON only when its parent was ON at registration; the
 *    settings default never applies to a child (an unknown parent is OFF);
 *  - a ROOT session takes `defaultOn()` (settings.browser.fullAccessDefault);
 *  - a corrupt file reads as all OFF and new root sessions stay OFF until the
 *    file is healthy again (fail closed);
 *  - a non-boolean entry is kept as OFF rather than dropped (a resumed session
 *    must never re-default to ON).
 *
 * The EFFECTIVE value is `stored && trust decided` (see effectiveFullAccess):
 * an untrusted folder is OFF whatever is stored.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { browserSettingsSchema } from "../settings/schema.js";

const fileSchema = z.record(z.string(), z.unknown());

export interface BrowserAccessStoreDeps {
  /** Absolute path of the per-session switch file (under the user-data directory). */
  file: string;
  /** Initial switch for a NEW ROOT session (settings.browser.fullAccessDefault === "on"). */
  defaultOn(): boolean;
}

export interface BrowserAccessStore {
  /** The STORED switch of a session (not trust-gated; see effectiveFullAccess). Unknown => false. */
  isOn(sessionId: string): boolean;
  /** Ensures a switch entry exists. A child takes its parent's ON state only; a resumed session keeps its own. */
  register(info: { sessionId: string; parentSessionId?: string }): boolean | void;
  remove(sessionId: string): void;
  /** Sets the switch of a KNOWN session; false (and no change) for an unknown one or a failed write. */
  set(sessionId: string, on: boolean): boolean;
}

interface Loaded {
  map: Map<string, boolean>;
  healthy: boolean;
}

function load(file: string): Loaded {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // No file yet is a healthy empty store; any other read error is not.
    const code = (error as NodeJS.ErrnoException).code;
    return { map: new Map(), healthy: code === "ENOENT" };
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { map: new Map(), healthy: false };
    const map = new Map<string, boolean>();
    for (const [id, value] of Object.entries(parsed.data)) map.set(id, value === true);
    return { map, healthy: true };
  } catch {
    return { map: new Map(), healthy: false };
  }
}

function persist(file: string, map: Map<string, boolean>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(map)), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createBrowserAccessStore(deps: BrowserAccessStoreDeps): BrowserAccessStore {
  const loaded = load(deps.file);
  const map = loaded.map;
  return {
    isOn(sessionId) {
      return map.get(sessionId) === true;
    },
    register({ sessionId, parentSessionId }) {
      if (map.has(sessionId)) return false;
      const on = parentSessionId !== undefined
        ? map.get(parentSessionId) === true
        : loaded.healthy && deps.defaultOn();
      map.set(sessionId, on);
      // A failed write must never fail tab creation: the in-memory value still answers.
      try { persist(deps.file, map); } catch { /* retried on the next change */ }
      return true;
    },
    remove(sessionId) {
      map.delete(sessionId);
      try { persist(deps.file, map); } catch { /* best effort */ }
    },
    set(sessionId, on) {
      if (!map.has(sessionId)) return false;
      const previous = map.get(sessionId);
      map.set(sessionId, on);
      try {
        persist(deps.file, map);
      } catch {
        // Fail closed: the change did not persist, so it does not take effect.
        if (previous === undefined) map.delete(sessionId); else map.set(sessionId, previous);
        return false;
      }
      return true;
    },
  };
}

/**
 * The effective switch for a live tab: stored ON AND the folder's trust is
 * decided. A pending or unknown trust decision is OFF regardless of the stored
 * value or the settings default.
 */
export function effectiveFullAccess(stored: boolean, trustPending: unknown): boolean {
  return stored && trustPending === "no_pending";
}

/** Reads `browser.fullAccessDefault` synchronously (a new root session reads it at registration). Fail closed: off. */
export function defaultBrowserFullAccessFromSettingsFile(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { browser?: unknown };
    return browserSettingsSchema.parse(raw.browser)?.fullAccessDefault === "on";
  } catch {
    return false;
  }
}
