/**
 * Compatibility shim (Phase 3 slice 3.6, design §2.2). The base-prompt builder
 * moved to prompts/system.ts and its section texts to prompts/sections.ts; this
 * module keeps the two long-standing exports that the barrel (index.ts) and a few
 * direct importers (cli/main.ts, the integration tests) resolve through here, so
 * nothing downstream breaks. IDENTITY_PROMPT now aliases the identity section
 * text; buildSystemPrompt re-exports the builder.
 */

export { SECTION_IDENTITY as IDENTITY_PROMPT } from "./sections.js";
export { buildSystemPrompt } from "./system.js";
export type { SystemPromptEnv, SystemPromptOptions } from "./system.js";
