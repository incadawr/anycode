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
 * The wrap-up instruction sent as a synthetic user message on the ONE tool-free
 * model call a budget-exhausted child gets (TASK.74 §4). It exists to convert
 * the text the parent would otherwise receive — the preamble of the cut-off
 * turn, i.e. what the child was ABOUT to do — into the findings it already has.
 * Lives here rather than as a literal in the runner so all subagent-facing copy
 * stays in one place.
 */
export const SUBAGENT_WRAPUP_PROMPT = [
  "You have run out of budget for this task. This is your wrap-up step: your tools have been removed,",
  "and this reply is the report that travels back to the agent that spawned you.",
  "Based only on what you already saw, write:",
  "1. Findings so far — concrete facts with file paths, line numbers, and short excerpts you actually verified.",
  "2. What you did NOT get to check or verify.",
  "3. Open questions and the next steps a successor should take.",
  "Do not claim the task is complete. Do not propose tool calls. Reply with the report text now.",
].join(" ");

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
