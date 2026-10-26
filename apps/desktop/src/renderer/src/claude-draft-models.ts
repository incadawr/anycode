import type { EngineModelChoice } from "../../shared/protocol.js";

/**
 * The Claude draft's model list. Unlike the preset table this is NOT a mirror
 * of a frozen host table — `host/engines/claude/models.ts` is explicit that the
 * real catalog is per-ACCOUNT and read live from the `initialize` response, and
 * a static enum was disproven by the live payload. Two facts make a draft-time
 * list nonetheless correct here:
 *
 *  1. There is no Claude catalog channel at draft time. The Claude doctor
 *     (`ClaudeDoctorReport`) reports status/version only — it never runs an
 *     `initialize`, so unlike `codexModels` there is nothing to fetch. Offering
 *     the "Default (recommended)" entry alone would silently remove the user's
 *     ability to pick a model on a new session.
 *  2. A wrong pick is HARMLESS and visible. `startClaudeEngine`'s `resolveModel`
 *     accepts an id only if the live catalog positively contains it, and
 *     otherwise boots on the CLI default AND queues a warning
 *     `engine_notice` that names the model — so an entry this account does not
 *     have degrades loudly, never silently mis-runs.
 *
 * The values are the `value` (send) ids captured live in
 * `w0-16-setmodel.jsonl`, never the `resolvedModel` (read-back) ids — sending a
 * resolved id is the exact conflation models.ts exists to prevent.
 */
export const CLAUDE_DRAFT_MODELS: readonly EngineModelChoice[] = [
  { id: "default", label: "Default (recommended)" },
  { id: "opus[1m]", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
