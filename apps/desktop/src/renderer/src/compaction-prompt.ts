/**
 * GitHub #36: renderer-owned mirror of `@anycode/core`'s
 * `COMPACTION_INSTRUCTION` (packages/core/src/prompts/compaction.ts), the
 * instruction core appends to the prefix when it asks a model to summarize.
 *
 * Why a mirror and not the import: renderer PRODUCTION code imports core
 * TYPE-only, never as a value — a value import pulls the whole core module
 * graph (node deps included) into the browser bundle (see subagent-card.ts and
 * child-report-format.ts's headers for the same rule applied to other core
 * strings). A live compaction row gets the REAL text over the wire
 * (`compaction_end.prompt`); this mirror is the fallback for a row REBUILT
 * from persisted history at hydration, which has the summary but never saw the
 * event. `compaction-prompt.test.ts` pins the two byte-for-byte against the
 * real export, so drift fails CI instead of shipping.
 */

export const COMPACTION_INSTRUCTION_MIRROR = [
  "Write a summary of this session that will replace every earlier message — the conversation continues afterward with only this summary as context, so it must stand on its own.",
  "Cover each of these points, as its own short section:",
  "- User's goal: what the user is trying to accomplish, in their own terms.",
  "- Current state: what has been done so far and where things stand right now.",
  "- Files changed: the exact paths touched or created, with a one-line note on what changed in each.",
  "- Decisions made: the choices taken along the way and the reasoning behind them, so they are not silently redone or reversed.",
  "- Open threads: unresolved questions, blockers, or follow-ups still pending.",
  "- Next step: the single next action to take when work resumes.",
  "Reply with plain text only — make no tool calls in this turn.",
].join("\n");
