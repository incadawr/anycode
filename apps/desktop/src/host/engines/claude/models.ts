/**
 * Claude model catalog — built from the LIVE `initialize` response's `models[]`
 * (cut §1.4), never a static enum. This is a contract-level fact, not a
 * preference: the CLI ships the account's own model list (which varies by
 * subscription and changes between releases), and the research-phase assumption
 * that a fixed enum would do was disproven by the live payload.
 *
 * Live shape per entry (`w0-16-setmodel.jsonl` / `initialize` response):
 *   { value, resolvedModel, displayName, description?, supportsEffort?,
 *     supportedEffortLevels?[], ... }
 *
 * TWO ids per model, and conflating them is the trap this module exists to
 * prevent: `value` is what you SEND (`opus[1m]`, `claude-fable-5[1m]`), while
 * `resolvedModel` is what the CLI reports back (`claude-opus-4-8[1m]`,
 * `claude-fable-5`). A read-back from `get_context_usage.model` therefore has
 * to be compared against `resolvedModel`, never round-trip-asserted against the
 * requested `value` (which would fire a false mismatch on every switch).
 */

import type { EngineModelChoice } from "../../../shared/protocol.js";

/** The CLI's own "whatever this account defaults to" entry — a moving target, not a pin. */
const DEFAULT_MODEL_ALIAS = "default";

/**
 * The full `--effort` vocabulary the CLI's own `--help` advertises (TASK.75,
 * binary 2.1.215) — a closed, version-independent set, unlike the model
 * catalog which is account-specific and only known post-handshake. This is
 * what makes spawn-time validation possible at all: a per-model catalog
 * cannot be consulted before the child even exists, but this fixed list can.
 * A model's own `supportedEffortLevels` (live, per-entry) is always a SUBSET
 * of this — the CLI, not this list, is the authority on which levels a given
 * model actually accepts.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS);

export function isClaudeEffortLevel(value: string): value is ClaudeEffortLevel {
  return EFFORT_LEVEL_SET.has(value);
}

export interface ClaudeModelEntry {
  /** The id sent on the wire (`--model` / `set_model`). */
  value: string;
  /** The id the CLI reports back for this model — the read-back comparison target. */
  resolvedModel: string;
  displayName: string;
  description?: string;
  supportsEffort: boolean;
  supportedEffortLevels: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Tolerant decode of one `models[]` entry. `value` is the only truly required
 * field (without it the entry can never be selected); `resolvedModel` falls
 * back to `value` for a hypothetical entry that omits it, so the read-back
 * comparison degrades to an identity check instead of throwing.
 */
function decodeEntry(raw: unknown): ClaudeModelEntry | null {
  const entry = record(raw);
  const value = string(entry?.value);
  if (entry === null || value === undefined) return null;
  const efforts = Array.isArray(entry.supportedEffortLevels)
    ? entry.supportedEffortLevels.filter((level): level is string => typeof level === "string")
    : [];
  const description = string(entry.description);
  return {
    value,
    resolvedModel: string(entry.resolvedModel) ?? value,
    displayName: string(entry.displayName) ?? value,
    ...(description === undefined ? {} : { description }),
    supportsEffort: entry.supportsEffort === true,
    supportedEffortLevels: efforts,
  };
}

/**
 * The session's model catalog. `available` being false means the catalog could
 * not be read at all — in which case NOTHING is validated as present and no id
 * is ever sent (fail-closed: the CLI would accept an unknown id at `set_model`
 * only to reject it, and a spawn-time `--model` with a bad id burns the boot).
 */
export class ClaudeModelCatalog {
  private readonly entries: ClaudeModelEntry[];

  constructor(entries: ClaudeModelEntry[]) {
    this.entries = entries;
  }

  /** Builds the catalog from the `initialize` response's `models` array. */
  static fromInitialize(models: unknown): ClaudeModelCatalog {
    if (!Array.isArray(models)) return new ClaudeModelCatalog([]);
    return new ClaudeModelCatalog(models.map(decodeEntry).filter((entry): entry is ClaudeModelEntry => entry !== null));
  }

  get available(): boolean {
    return this.entries.length > 0;
  }

  has(value: string): boolean {
    return this.entries.some((entry) => entry.value === value);
  }

  get(value: string): ClaudeModelEntry | undefined {
    return this.entries.find((entry) => entry.value === value);
  }

  /**
   * Matches a CLI-reported model id back to a catalog entry. Tries the
   * resolved id FIRST (that is what the CLI reports) and the sent id second,
   * so both directions of the `value`/`resolvedModel` split resolve.
   */
  findByResolved(resolved: string): ClaudeModelEntry | undefined {
    return this.entries.find((entry) => entry.resolvedModel === resolved) ?? this.get(resolved);
  }

  /**
   * The catalog value best representing a CLI-reported model id — the mapping
   * used when the engine adopts a resumed session's actual model (cut §1.5
   * hazard (б)).
   *
   * `findByResolved` is not enough on its own, because the mapping is genuinely
   * AMBIGUOUS: the live catalog lists both `default` and `opus[1m]` with the
   * same `resolvedModel` (`claude-opus-4-8[1m]`), and `default` is listed
   * first. Adopting `default` for a session that is really pinned to opus would
   * re-point that session the day the account's default model changes —
   * `default` is a MOVING alias, and a concrete alias is not. So a concrete
   * entry wins whenever one exists; `default` is only chosen when the CLI is
   * reporting a model nothing else in the catalog names.
   */
  selectableForResolved(resolved: string): ClaudeModelEntry | undefined {
    const exact = this.get(resolved);
    if (exact !== undefined) return exact;
    const matches = this.entries.filter((entry) => entry.resolvedModel === resolved);
    return matches.find((entry) => entry.value !== DEFAULT_MODEL_ALIAS) ?? matches[0];
  }

  /**
   * Does a CLI-reported model id correspond to the entry we selected? This is
   * the read-back check for `get_context_usage.model` — `claude-fable-5[1m]`
   * was REQUESTED but `claude-fable-5` is REPORTED, and comparing the two
   * strings directly would report a spurious divergence.
   */
  readBackMatches(selectedValue: string, reportedModel: string): boolean {
    const entry = this.get(selectedValue);
    if (entry === undefined) return false;
    return entry.resolvedModel === reportedModel || entry.value === reportedModel;
  }

  /** Effort levels this model accepts, for the `apply_flag_settings{effortLevel}` path. */
  effortsFor(value: string): string[] {
    const entry = this.get(value);
    return entry === undefined || !entry.supportsEffort ? [] : entry.supportedEffortLevels;
  }

  supportsEffort(value: string, effort: string): boolean {
    return this.effortsFor(value).includes(effort);
  }

  /**
   * Resolves the effort to keep for `value` given a preferred (remembered)
   * choice — mirrors `CodexModelCatalog.resolveEffort`. Unlike Codex's live
   * payload, no entry here ever carries a `defaultEffort`, so there is no
   * fallback branch: a preferred value the model no longer supports (or no
   * preference at all) simply resolves to undefined, and the caller omits
   * `effort` entirely rather than guessing one.
   */
  resolveEffort(value: string, preferred?: string): string | undefined {
    if (preferred === undefined) return undefined;
    return this.supportsEffort(value, preferred) ? preferred : undefined;
  }

  /** The wire projection consumed by `EnginePresentation.model.available`. */
  choices(): EngineModelChoice[] {
    return this.entries.map((entry) => ({
      id: entry.value,
      label: entry.displayName,
      ...(entry.supportsEffort && entry.supportedEffortLevels.length > 0
        ? { efforts: entry.supportedEffortLevels }
        : {}),
    }));
  }

  /** The catalog's own first entry — the CLI lists `default` first, so this is its recommended pick. */
  defaultValue(): string | undefined {
    return this.entries[0]?.value;
  }
}
