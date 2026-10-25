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
}

export interface SessionAccessStore {
  isExposed(sessionId: string): boolean;
  /** Ensures a switch entry exists. A child inherits its parent's switch; a resumed session keeps its own. */
  register(info: { sessionId: string; parentSessionId?: string }): void;
  /** Sets the switch of a KNOWN session; false (and no change) for an unknown one. */
  set(sessionId: string, enabled: boolean): boolean;
  exposedCount(): number;
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

export function createSessionAccessStore(deps: SessionAccessStoreDeps): SessionAccessStore {
  const map = load(deps.file);
  return {
    isExposed(sessionId) {
      return map.get(sessionId) === true;
    },
    register({ sessionId, parentSessionId }) {
      if (map.has(sessionId)) return;
      const inherited = parentSessionId !== undefined ? map.get(parentSessionId) : undefined;
      map.set(sessionId, inherited ?? deps.defaultOn());
      // A failed write must never fail tab creation: the in-memory value still answers.
      try { persist(deps.file, map); } catch { /* retried on the next change */ }
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
