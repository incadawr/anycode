/**
 * Compaction instruction (Phase 3 slice 3.6.3, design §3.4). This is a user-role
 * message sent to the model when context/manager.ts decides to compact: the
 * model's reply becomes the ONLY surviving record of everything before it, so
 * the instruction spells out an explicit, headed structure rather than leaving
 * "summarize this" underspecified — a vague ask tends to drop the very details
 * (changed file paths, why a decision was made) that the resumed session needs.
 */

export const COMPACTION_INSTRUCTION = [
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
