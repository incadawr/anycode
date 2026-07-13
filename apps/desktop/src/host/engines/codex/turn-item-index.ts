/**
 * Per-turn correlation index: `itemId` -> the details announced by the
 * `item/started` notification for that item (cut §2(l), live fact L9).
 *
 * The live app-server (codex-cli 0.144.3) sends approval requests that do NOT
 * carry what is being approved:
 *   - `item/fileChange/requestApproval` params are exactly
 *     `{threadId, turnId, itemId, startedAtMs, reason, grantRoot}` — no diff and
 *     no path at all;
 *   - `item/commandExecution/requestApproval` has no `reason`.
 * The only place a file change's paths/diffs appear is the `fileChange`
 * `item/started` notification that arrives EARLIER in the same turn. So the
 * approval modal can only describe the change by correlating on `itemId`, which
 * is what this index is for.
 *
 * A missing entry is NOT a malformed request: the approval is still presented,
 * only with a degraded description (never fail-closed on the index alone).
 *
 * Bounded: a pathological turn can never grow the index without limit; the
 * oldest entry is evicted past MAX_INDEXED_ITEMS (approval correlation is
 * always against a recent item).
 */

export const MAX_INDEXED_ITEMS = 256;

/** One entry of a `fileChange` item's `changes`, flattened for the approval UI. */
export interface CodexFileChange {
  path: string;
  kind?: string;
  diff?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export class TurnItemIndex {
  private readonly items = new Map<string, Record<string, unknown>>();

  /** Records an `item/started` item verbatim; anything without a string id is ignored. */
  record(item: unknown): void {
    const value = record(item);
    if (value === null || typeof value.id !== "string" || value.id.length === 0) return;
    if (this.items.size >= MAX_INDEXED_ITEMS && !this.items.has(value.id)) {
      const oldest = this.items.keys().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
    this.items.set(value.id, value);
  }

  get(itemId: string): Record<string, unknown> | undefined {
    return this.items.get(itemId);
  }

  get size(): number {
    return this.items.size;
  }
}

/**
 * Flattens a `fileChange` item's `changes` array. `kind` is an object on the
 * wire (`{"type":"add"}`); only its discriminator is projected, and an unknown
 * shape degrades to omission rather than to a rejection.
 */
export function fileChangesOf(item: Record<string, unknown> | undefined): CodexFileChange[] {
  if (item === undefined || item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  const changes: CodexFileChange[] = [];
  for (const entry of item.changes) {
    const change = record(entry);
    if (change === null || typeof change.path !== "string" || change.path.length === 0) continue;
    const kind = record(change.kind);
    changes.push({
      path: change.path,
      ...(typeof kind?.type === "string" ? { kind: kind.type } : {}),
      ...(typeof change.diff === "string" ? { diff: change.diff } : {}),
    });
  }
  return changes;
}

/** Command/cwd of a `commandExecution` item, used to backfill an approval that omits them. */
export function commandOf(item: Record<string, unknown> | undefined): { command?: string; cwd?: string } {
  if (item === undefined || item.type !== "commandExecution") return {};
  return {
    ...(typeof item.command === "string" && item.command.length > 0 ? { command: item.command } : {}),
    ...(typeof item.cwd === "string" && item.cwd.length > 0 ? { cwd: item.cwd } : {}),
  };
}
