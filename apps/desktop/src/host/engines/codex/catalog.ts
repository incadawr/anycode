/**
 * Host-side Codex model catalog (TASK.39, cut §2(j)).
 *
 * WHY THIS EXISTS AT ALL — live fact L7: the app-server does NOT reject an
 * unknown model id synchronously. `thread/start` and `turn/start` both ACCEPT a
 * bogus id, the turn is really started, tokens are really spent, and the failure
 * arrives late as an `error` notification + `turn/completed{status:"failed"}`
 * (see contract/fixtures/w1-p6-start-echo-and-error.jsonl). A server-side
 * validation therefore does not exist to lean on: every model id this host is
 * ever going to put on the wire MUST be checked against this catalog first, so
 * that an unsupported/removed model is a recoverable UI error rather than a
 * burned turn (TASK.39 DoD "unsupported/removed model gives a recoverable
 * error" + "the renderer can never send an invalid model").
 *
 * The doctor's catalog (main/codex-doctor.ts) serves the PRE-session draft UI
 * only; the host never trusts it and re-loads its own here, inside the very
 * app-server connection the session will use — a draft assembled minutes ago
 * against a different binary/account is not evidence about this thread.
 *
 * Fail-closed by construction: a `model/list` that fails/times out yields an
 * EMPTY catalog, and an empty catalog validates NOTHING — so no model override
 * is ever sent and the server's own default model is used. An unavailable
 * catalog degrades model selection; it never degrades safety.
 */

import {
  CODEX_MODEL_LIST_MAX_PAGES,
  CODEX_MODEL_LIST_PAGE_TIMEOUT_MS,
} from "../../../shared/codex-timeouts.js";
import type { EngineModelChoice } from "../../../shared/protocol.js";

/** Narrow request seam — the catalog needs nothing else from the transport. */
export interface CodexCatalogClient {
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/**
 * One decoded `Model` from `model/list`. Live fact L3: every catalog entry has
 * `id === model`, so the id-vs-model distinction is moot and only `id` is kept.
 */
export interface CodexModelEntry {
  id: string;
  label: string;
  /** True only when this exact model advertises native image items in `model/list`. */
  supportsImages?: boolean;
  /** `supportedReasoningEfforts[].reasoningEffort` — a free-form non-empty string in this protocol, NOT core's ReasoningEffort union. */
  efforts: string[];
  defaultEffort?: string;
  isDefault: boolean;
}

export interface CodexCatalogLoadOptions {
  pageTimeoutMs?: number;
  maxPages?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Structural extraction, never a strict reject: the live wire carries keys this
 * host has never heard of (`availabilityNux`, `serviceTiers`, `upgradeInfo`, …)
 * and will grow more (L9 — decoders must tolerate unknown fields). An entry is
 * dropped only when it has no usable id.
 */
function decodeModel(value: unknown): CodexModelEntry | null {
  const model = record(value);
  if (model === null) return null;
  const id = text(model.id);
  if (id === undefined) return null;
  // `hidden` models are excluded from the default picker by the server's own
  // contract; we never send `includeHidden`, but a server that ships them anyway
  // must not have them surface as selectable choices.
  if (model.hidden === true) return null;
  const efforts: string[] = [];
  if (Array.isArray(model.supportedReasoningEfforts)) {
    for (const option of model.supportedReasoningEfforts) {
      const effort = text(record(option)?.reasoningEffort);
      if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort);
    }
  }
  const defaultEffort = text(model.defaultReasoningEffort);
  return {
    id,
    label: text(model.displayName) ?? id,
    supportsImages: Array.isArray(model.inputModalities) && model.inputModalities.includes("image"),
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    isDefault: model.isDefault === true,
  };
}

export class CodexModelCatalog {
  private readonly byId: ReadonlyMap<string, CodexModelEntry>;

  private constructor(
    private readonly entries: readonly CodexModelEntry[],
    /** Present when `model/list` could not be read; the catalog is then empty and validates nothing. */
    readonly loadError: string | undefined,
  ) {
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
  }

  /** An unusable catalog (load failed). Kept explicit so callers must decide what an unvalidatable model means. */
  static unavailable(reason: string): CodexModelCatalog {
    return new CodexModelCatalog([], reason);
  }

  /** Test/DI seam: build a catalog without a transport. */
  static of(entries: readonly CodexModelEntry[]): CodexModelCatalog {
    return new CodexModelCatalog(entries, undefined);
  }

  /**
   * Bounded, paginated `model/list` (cut §2(b)#6 / §2(g)). NEVER throws or
   * rejects: a transport failure resolves to an `unavailable` catalog, because a
   * missing model list must not take the whole session down with it (the session
   * is perfectly usable on the server's default model).
   *
   * Three independent bounds, because `nextCursor` is server-controlled input:
   * a per-page timeout, a hard page cap, and a repeated-cursor guard (a server
   * echoing the same cursor forever would otherwise spin the boot path inside
   * the page cap without ever advancing).
   */
  static async load(client: CodexCatalogClient, options: CodexCatalogLoadOptions = {}): Promise<CodexModelCatalog> {
    const pageTimeoutMs = options.pageTimeoutMs ?? CODEX_MODEL_LIST_PAGE_TIMEOUT_MS;
    const maxPages = options.maxPages ?? CODEX_MODEL_LIST_MAX_PAGES;
    const entries: CodexModelEntry[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const result = await client.request<unknown>(
          "model/list",
          cursor === undefined ? {} : { cursor },
          { timeoutMs: pageTimeoutMs },
        );
        const body = record(result);
        const data = body?.data;
        if (Array.isArray(data)) {
          for (const value of data) {
            const entry = decodeModel(value);
            if (entry === null || seenIds.has(entry.id)) continue;
            seenIds.add(entry.id);
            entries.push(entry);
          }
        }
        const next = text(body?.nextCursor);
        if (next === undefined || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
    } catch (error) {
      // A partially-read catalog is still a truthful subset of what the server
      // offers, but it is NOT a safe validation authority: a model absent from a
      // half-read list would be rejected as "unsupported" although it exists.
      // Fail closed on the whole catalog instead.
      return CodexModelCatalog.unavailable(error instanceof Error ? error.message : String(error));
    }
    return new CodexModelCatalog(entries, undefined);
  }

  get available(): boolean {
    return this.entries.length > 0;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): CodexModelEntry | undefined {
    return this.byId.get(id);
  }

  /** A missing/unreadable catalog is deliberately not evidence that images are safe to send. */
  supportsImages(id: string): boolean {
    return this.byId.get(id)?.supportsImages === true;
  }

  /** The wire projection consumed by `EnginePresentation.model.available`. */
  choices(): EngineModelChoice[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(entry.efforts.length > 0 ? { efforts: [...entry.efforts] } : {}),
    }));
  }

  /**
   * Resolves the effort to send alongside `model` on a `turn/start` override.
   *
   * `preferred` is the caller's remembered effort for THIS model (the boot
   * thread echo at startup, or the model-specific choice restored later). When
   * the model still advertises it, keep it; otherwise fall back to that model's
   * own default. Unknown model / no evidence -> undefined, and the caller omits
   * `effort` from the override entirely (the server keeps whatever is already
   * effective).
   */
  resolveEffort(modelId: string, preferred?: string): string | undefined {
    const entry = this.byId.get(modelId);
    if (entry === undefined) return undefined;
    if (preferred !== undefined && entry.efforts.includes(preferred)) return preferred;
    if (entry.efforts.length === 0) return undefined;
    return entry.defaultEffort !== undefined && entry.efforts.includes(entry.defaultEffort)
      ? entry.defaultEffort
      : undefined;
  }
}
