/**
 * Session-title instruction (Phase 4 slice 4.4-T, design §2). A user-role
 * message sent to the model as a tiny one-shot after the first turn completes:
 * the reply becomes the session's display title, so the ask is narrow and the
 * output format is spelled out explicitly (no quotes, no trailing period, no
 * preamble) to keep post-processing trivial and the result always short.
 */

export const SESSION_TITLE_INSTRUCTION = [
  "Read the user's message below and come up with a short title for this coding session, 3 to 6 words.",
  "Reply with the title ONLY: no quotation marks, no trailing period, no preamble or explanation.",
  "Write the title in the same language as the user's message.",
].join("\n");
