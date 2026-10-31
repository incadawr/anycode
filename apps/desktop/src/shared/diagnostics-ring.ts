/**
 * Bounded ring log for the diagnostics export (GitHub #18).
 *
 * Every process that participates in a session (desktop MAIN and each HOST
 * fork) keeps a small in-memory ring of control-plane WIRE SHAPES: which
 * message type was seen, in which direction, and a coarse result. Nothing
 * else. `note()` is O(1) on the hot path (a push plus amortised evictions, no
 * I/O, no JSON, no timers), so it can be called for every message without
 * perturbing a turn.
 *
 * Privacy is enforced by CONSTRUCTION, not by a later scrubber:
 *
 * - the entry shape is closed (`scope`/`channel`/`ok`/`code`/`count`/`ms`
 *   plus `at`); a caller cannot smuggle a prompt, a path or a payload in;
 * - `channel`/`code` must match one narrow identifier alphabet and are
 *   length-capped — a path, URL or free text is refused outright rather than
 *   truncated into something that still leaks;
 * - `noteWireMessage` derives the channel from `type`/`kind` ONLY, so a
 *   message payload never reaches the ring even by accident;
 * - eviction is by entry count AND byte budget, so a chatty wire stays
 *   bounded and the result stays comfortably inside a diagnostics bundle.
 */

export const DIAGNOSTICS_RING_DEFAULT_MAX_ENTRIES = 512;
export const DIAGNOSTICS_RING_DEFAULT_MAX_BYTES = 64 * 1024;
export const DIAGNOSTICS_RING_MAX_IDENTIFIER_CHARS = 64;

export interface DiagnosticsRingEntry {
  /** Wall-clock ms when the shape was seen. */
  at: number;
  scope: DiagnosticsRingScope;
  /** `<direction>:<message type>[:<kind>]` — a closed identifier, never payload. */
  channel: string;
  ok?: boolean;
  /** Closed result code (e.g. a failure family), never an error message. */
  code?: string;
  count?: number;
  ms?: number;
}

export type DiagnosticsRingScope = "main" | "host";

/** What a caller may supply; `at`/`scope` are owned by the ring. */
export interface DiagnosticsRingNote {
  channel: string;
  ok?: boolean;
  code?: string;
  count?: number;
  ms?: number;
}

export interface DiagnosticsRing {
  note(entry: DiagnosticsRingNote): void;
  /** Oldest-first copy; `limit` keeps the newest N. */
  snapshot(limit?: number): DiagnosticsRingEntry[];
  readonly size: number;
  readonly bytes: number;
}

export interface DiagnosticsRingOptions {
  scope: DiagnosticsRingScope;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

/** Exactly the identifier alphabet a channel/code may use. */
const IDENTIFIER_RE = /^[A-Za-z0-9_:.\-]+$/;

const ENTRY_OVERHEAD_BYTES = 64;

function cleanIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DIAGNOSTICS_RING_MAX_IDENTIFIER_CHARS) return undefined;
  return IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function entryBytes(entry: DiagnosticsRingEntry): number {
  return ENTRY_OVERHEAD_BYTES + entry.channel.length + (entry.code?.length ?? 0);
}

/**
 * A ring that refuses — rather than sanitises — anything outside its closed
 * shape. `snapshot()` returns copies so a consumer can never mutate the live
 * buffer.
 */
export function createDiagnosticsRing(options: DiagnosticsRingOptions): DiagnosticsRing {
  const maxEntries = Math.max(1, options.maxEntries ?? DIAGNOSTICS_RING_DEFAULT_MAX_ENTRIES);
  const maxBytes = Math.max(1024, options.maxBytes ?? DIAGNOSTICS_RING_DEFAULT_MAX_BYTES);
  const now = options.now ?? Date.now;
  const lines: DiagnosticsRingEntry[] = [];
  let bytes = 0;

  return {
    note(input) {
      const channel = cleanIdentifier(input.channel);
      if (channel === undefined) return;
      const code = cleanIdentifier(input.code);
      const entry: DiagnosticsRingEntry = {
        at: now(),
        scope: options.scope,
        channel,
        ...(typeof input.ok === "boolean" ? { ok: input.ok } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(finiteNumber(input.count) !== undefined ? { count: finiteNumber(input.count) } : {}),
        ...(finiteNumber(input.ms) !== undefined ? { ms: finiteNumber(input.ms) } : {}),
      };
      lines.push(entry);
      bytes += entryBytes(entry);
      while (lines.length > maxEntries || bytes > maxBytes) {
        const dropped = lines.shift();
        if (dropped === undefined) break;
        bytes -= entryBytes(dropped);
      }
    },
    snapshot(limit) {
      const kept = limit !== undefined && limit >= 0 ? lines.slice(-limit) : lines;
      return kept.map((entry) => ({ ...entry }));
    },
    get size() {
      return lines.length;
    },
    get bytes() {
      return bytes;
    },
  };
}

export type DiagnosticsWireDirection = "in" | "out";

/**
 * The channel for one wire message: `<direction>:<type>[:<kind>]`, derived
 * from the two identity fields only. Returns undefined for a message with no
 * usable type/kind (a non-object, or a forged value outside the alphabet) —
 * such a message is simply not logged.
 */
export function wireChannelFor(direction: DiagnosticsWireDirection, message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const shaped = message as { type?: unknown; kind?: unknown };
  const type = cleanIdentifier(shaped.type);
  const kind = cleanIdentifier(shaped.kind);
  if (type === undefined && kind === undefined) return undefined;
  return cleanIdentifier(`${direction}:${type ?? "event"}${kind !== undefined ? `:${kind}` : ""}`);
}

/** Logs ONE wire shape. Payload fields are never read, only `type`/`kind`. */
export function noteWireMessage(
  ring: DiagnosticsRing | undefined,
  direction: DiagnosticsWireDirection,
  message: unknown,
  extra?: { ok?: boolean; code?: string; count?: number; ms?: number },
): void {
  if (ring === undefined) return;
  const channel = wireChannelFor(direction, message);
  if (channel === undefined) return;
  ring.note({ channel, ...(extra ?? {}) });
}

/**
 * Re-validates ring entries that crossed a process boundary (a host's snapshot
 * arrives as untrusted IPC data). Anything outside the closed shape is
 * dropped, and `scope` is re-stamped from the receiving side — a host cannot
 * claim to be main, nor inject text through a channel field.
 */
export function parseDiagnosticsRingEntries(value: unknown, scope: DiagnosticsRingScope, limit: number): DiagnosticsRingEntry[] {
  if (!Array.isArray(value)) return [];
  const out: DiagnosticsRingEntry[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const channel = cleanIdentifier(entry.channel);
    if (channel === undefined) continue;
    const code = cleanIdentifier(entry.code);
    const at = finiteNumber(entry.at);
    const count = finiteNumber(entry.count);
    const ms = finiteNumber(entry.ms);
    out.push({
      at: at ?? 0,
      scope,
      channel,
      ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(ms !== undefined ? { ms } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}
