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
  "The title is a noun phrase — never start it with the word \"Title\" and never repeat this instruction.",
  "Write the title in the same language as the user's message.",
  // Identical first messages used to come back as \"ok\", \"ok\" and \"Reply
  // Exactly Ok\": a model left to its own devices title-cases arbitrarily, so
  // the same prompt yields different-looking titles. One style is named.
  "Use sentence case — capitalize only the first word, the way a sentence does. Never title-case the words, and keep the user's own capitalization of names, code and quoted text.",
].join("\n");
