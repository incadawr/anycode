/**
 * `/rewind` CLI helpers (design slice-4.7-cut.md §2.6): pure formatting/parsing/
 * resolution functions consumed by cli/commands.ts's handleRewindCommand (B4)
 * and, indirectly, cli/main.ts's deps.rewind wiring (B5). This file owns zero
 * I/O and zero shadow-git/store access — it only shapes strings and arrays
 * already fetched by the caller. Reuses shortSessionId/formatRelativeTime from
 * ./sessions.js (same table-rendering style as /sessions) rather than
 * duplicating that formatting logic.
 */

import type { CheckpointMeta } from "../ports/checkpoints.js";
import type { RewindScope } from "../checkpoints/shadow-git.js";
import { formatRelativeTime, shortSessionId } from "./sessions.js";

/** Minimum prefix length for an id/commitHash lookup (design §2.6, mirrors A1's prose). */
const REF_MIN_PREFIX_CHARS = 6;

/**
 * Renders a checkpoints snapshot as a fixed-width table (design §2.6, mirrors
 * /sessions's renderSessionsTable/renderMcpStatusTable style): columns
 * `#  id  age  reason  label`. `metas` is expected newest-first (the shape
 * CheckpointStore.listCheckpoints already returns) — this function does not
 * re-sort; the `#` column is simply 1-based row position, matching the same
 * indexing `parseRewindCommand`'s `"<n>"` form and `resolveCheckpointRef`
 * resolve against. The empty-list case is intentionally NOT handled here — the
 * design's handler (cli/commands.ts, B4) prints its own notice string before
 * ever calling this function.
 */
export function renderCheckpointsTable(metas: readonly CheckpointMeta[], opts: { now: number }): string {
  const header = ["#", "id", "age", "reason", "label"];
  const rows = metas.map((meta, index) => [
    String(index + 1),
    shortSessionId(meta.id),
    formatRelativeTime(meta.createdAt, opts.now),
    meta.reason,
    meta.label,
  ]);
  const widths = header.map((label, i) => Math.max(label.length, ...rows.map((row) => row[i]!.length)));
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  return [formatRow(header), ...rows.map(formatRow)].join("\n") + "\n";
}

export type RewindCommandParse =
  | { kind: "list" }
  | { kind: "restore"; ref: string; scope: RewindScope }
  | { kind: "invalid" };

/**
 * Shape-only validity check for a ref token (design §2.6): EITHER a bare
 * sequence of digits (a 1-based index — validity as an actual index is
 * `resolveCheckpointRef`'s concern, not this syntactic gate) OR a string of at
 * least REF_MIN_PREFIX_CHARS characters (an id or commitHash prefix — whether
 * it actually matches anything is again `resolveCheckpointRef`'s concern).
 */
function isValidRefShape(token: string): boolean {
  return /^\d+$/.test(token) || token.length >= REF_MIN_PREFIX_CHARS;
}

/**
 * Parses the raw text after `/rewind` (design §2.6). Forms:
 * `""` (only whitespace) -> `{kind:"list"}`; a single token satisfying
 * `isValidRefShape` -> `{kind:"restore", ref, scope:"both"}`; that same token
 * plus a second token that is exactly `"files"` or `"conversation"` ->
 * `{kind:"restore", ref, scope: <that token>}`. Anything else (empty ref
 * shape, more than 2 tokens, or an unrecognised second token) ->
 * `{kind:"invalid"}` — the caller prints the frozen usage string. Pure: never
 * throws, never consults a clock or a checkpoint list.
 */
export function parseRewindCommand(rest: string): RewindCommandParse {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return { kind: "list" };
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 2) {
    return { kind: "invalid" };
  }
  const ref = tokens[0]!;
  if (!isValidRefShape(ref)) {
    return { kind: "invalid" };
  }
  const scopeToken = tokens[1];
  if (scopeToken === undefined) {
    return { kind: "restore", ref, scope: "both" };
  }
  if (scopeToken === "files" || scopeToken === "conversation") {
    return { kind: "restore", ref, scope: scopeToken };
  }
  return { kind: "invalid" };
}

/**
 * Resolves a `/rewind` ref against a freshly-fetched checkpoint list (design
 * §2.6). A bare-digits ref is a 1-based index into `metas` (out of range ->
 * null). Otherwise: an exact `id` match wins outright; failing that, a
 * REF_MIN_PREFIX_CHARS-or-longer ref is matched as a prefix of either `id` or
 * `commitHash` — a UNIQUE such match resolves, zero or more-than-one matches
 * both resolve to null (ambiguous and not-found collapse to the same signal;
 * the caller — commands.ts's handleRewindCommand — reports both as
 * `no checkpoint matches "<ref>"`).
 */
export function resolveCheckpointRef(metas: readonly CheckpointMeta[], ref: string): CheckpointMeta | null {
  if (/^\d+$/.test(ref)) {
    const index = Number(ref);
    return metas[index - 1] ?? null;
  }
  const exact = metas.find((meta) => meta.id === ref);
  if (exact !== undefined) {
    return exact;
  }
  if (ref.length < REF_MIN_PREFIX_CHARS) {
    return null;
  }
  const matches = metas.filter((meta) => meta.id.startsWith(ref) || meta.commitHash.startsWith(ref));
  return matches.length === 1 ? matches[0]! : null;
}
