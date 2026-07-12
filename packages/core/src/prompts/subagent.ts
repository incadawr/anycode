/**
 * Subagent system-prompt builder (Phase 3 slice 3.6, design §2.3). A child agent
 * confabulates tools exactly like the parent, so it gets the same harness
 * discipline — just scoped to ITS registry. The layout is fixed:
 *
 *   prelude (subagent identity -> tool discipline -> env -> memory)
 *   -> persona/profile body (verbatim)
 *   -> finality note (last)
 *
 * The prelude leads and the finality note trails so the child always ends on the
 * rule that its final message IS the tool result. `toolNames` is the child's own
 * registry snapshot (the runner passes it AFTER the SPAWN_TOOLS skip), so this
 * prompt structurally cannot advertise Agent/Workflow — a prompt-level mirror of

 * content (a built-in persona text or the user's md-profile, already capped by
 * subagents/profiles.ts) and is embedded as-is.
 */

import { SECTION_SUBAGENT_FINALITY, SECTION_SUBAGENT_IDENTITY } from "./sections.js";
import { renderEnvSection, renderToolDisciplineSection, type SystemPromptEnv } from "./system.js";

export interface SubagentPromptOptions {
  /** CHILD registry tool names (Agent/Workflow already dropped by construction). */
  toolNames: readonly string[];
  env?: SystemPromptEnv;
  /** The parent's memory section, passed through ("" => omitted). */
  memorySection?: string;
}

/**
 * Assembles the child's full system prompt from the harness prelude, the persona
 * body, and the finality note. Only `toolNames` is required, so the runner's
 * legacy 3-arg `buildChildConfig` path (no env/memory) still yields a valid
 * prompt.
 */
export function buildSubagentSystemPrompt(
  persona: { name: string; systemPrompt: string },
  opts: SubagentPromptOptions,
): string {
  const parts = [
    SECTION_SUBAGENT_IDENTITY,
    renderToolDisciplineSection(opts.toolNames),
    renderEnvSection(opts.env),
    opts.memorySection ?? "",
    persona.systemPrompt,
    SECTION_SUBAGENT_FINALITY,
  ];
  return parts.filter((part) => part.length > 0).join("\n\n");
}
