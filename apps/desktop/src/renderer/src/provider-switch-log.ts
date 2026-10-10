/**
 * Renderer-only provider-switch ledger persistence (Taskana 4234). A
 * connection switch happens BETWEEN the pre-switch history and the resumed
 * host's hydrated history; the marker is renderer-local and never sent into
 * host/model history — same posture as provider-notices.ts (fail-soft
 * localStorage, keyed by sessionId). All markers of a session are retained
 * (no count cap that would drop older boundaries).
 */

export interface ConnectionSwitchRecord {
  id: string;
  fromLabel: string;
  toLabel: string;
  model: string;
  effortResetTo?: string;
  /** History item id the switch landed after (null ⇔ before any hydrated history). */
  afterItemId: string | null;
}

const STORAGE_PREFIX = "anycode.provider-switches.v1:";

function storage(): Storage | null {
  try {
    // Same TASK.117 boundary discipline as provider-notices.ts: resolve
    // through the `window` property of globalThis so node-lib typechecks and
    // tests stubbing globalThis.window keep working; fail soft when denied.
    return (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is ConnectionSwitchRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ConnectionSwitchRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.fromLabel === "string" &&
    typeof record.toLabel === "string" &&
    typeof record.model === "string" &&
    (record.effortResetTo === undefined || typeof record.effortResetTo === "string") &&
    (record.afterItemId === null || typeof record.afterItemId === "string")
  );
}

/** Reads a session's renderer-only switch markers (chronological); corrupt/unavailable storage fails soft. */
export function loadConnectionSwitches(sessionId: string): ConnectionSwitchRecord[] {
  try {
    const raw = storage()?.getItem(`${STORAGE_PREFIX}${sessionId}`);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

/** Appends one switch marker chronologically, deduped by id; denied storage never throws. */
export function saveConnectionSwitch(sessionId: string, record: ConnectionSwitchRecord): void {
  try {
    const existing = loadConnectionSwitches(sessionId);
    if (existing.some((item) => item.id === record.id)) return;
    storage()?.setItem(`${STORAGE_PREFIX}${sessionId}`, JSON.stringify([...existing, record]));
  } catch {
    // A denied/quota-exhausted localStorage must never perturb the agent turn.
  }
}
