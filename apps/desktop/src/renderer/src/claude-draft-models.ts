import type { EngineModelChoice } from "../../shared/protocol.js";

/**
 * Fallback when no account/CLI-confirmed initialize catalog is available.
 * Drafts prefer the cached doctor catalog; running sessions use their own
 * live initialize catalog instead of this table.
 * Full model ids avoid assuming which aliases an account's CLI advertises.
 * The host resolves these through the live catalog before sending set_model;
 * an unavailable model falls back to the CLI default with a warning.
 * Ordinary Opus deliberately omits the extended-context [1m] suffix.
 */
export const CLAUDE_DRAFT_MODELS: readonly EngineModelChoice[] = [
  { id: "default", label: "Default (recommended)" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];
