/**
 * Subagent persona registry (Phase 3 slice 3.1, design §3.6). Personas are
 * DATA, not prompts: each names the built-in tools its child registry is built
 * from and carries a role-specific system prompt (real copy landed in slice
 * 3.6.3; the harness prelude — tool discipline/env/memory/finality — is added
 * around this text by buildSubagentSystemPrompt, so the body here stays
 * role-specific and does not repeat that discipline). Slice 3.3 widens this
 * with md-profiles WITHOUT touching the frozen Agent schema (agent_type is
 * already a plain string).
 *
 * Deliberately import-free of tools/registry.ts: registry.ts registers the
 * Agent tool, whose handler validates against this module — colocating the
 * default-tool derivation here would close a runtime import cycle
 * (registry -> agent -> personas -> registry). The tool lists are therefore
 * spelled out as data.
 */

export type PersonaName = "general-purpose" | "explore";

export interface PersonaDefinition {
  /**
   * Persona/profile name. Widened from PersonaName to string in slice 3.3
   * (design §2.4) so md-profiles are just "another PersonaDefinition"; PERSONAS
   * below stays keyed by the narrow PersonaName. Built-in names are reserved
   * (profiles cannot override them — discovery + resolution both enforce it).
   */
  name: string;
  /** Short human-facing label for logs/UI. */
  description: string;
  /** Built-in tool names the child registry is assembled from (never includes Agent — non-recursion lock). */
  tools: readonly string[];
  /**
   * Role-specific system prompt body. Embedded by buildSubagentSystemPrompt
   * AFTER the harness prelude and BEFORE the finality note (design §2.3), so
   * this text should not repeat tool-discipline/env/finality rules — only the
   * persona's own role and expectations.
   */
  systemPrompt: string;
}

/**
 * general-purpose: the nine non-Agent default tools (full access under the
 * parent's inherited permission gate). explore: strictly read-only tools, so a
 * child runs zero permission asks in build/plan — friction-free parallel
 * reconnaissance. Bash is deliberately excluded from explore (it is not

 */
const GENERAL_PURPOSE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
] as const;

const EXPLORE_TOOLS = ["Read", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch"] as const;

const GENERAL_PURPOSE_SYSTEM_PROMPT = [
  "You are the general-purpose subagent: a versatile executor for one delegated subtask.",
  "You bring your full tool set to that task, still bound by the parent's inherited permission gate.",
  "Carry the task through to completion yourself rather than reporting back partway, then close with a concrete report of what you did and what you found.",
].join(" ");

const EXPLORE_SYSTEM_PROMPT = [
  "You are the explore subagent: a read-only reconnaissance specialist.",
  "You have no file-writing or command-execution tools, so do not ask the parent to grant Write, Edit, or Bash — your role is to look, not to change anything.",
  "Search and read until you can answer the parent's question, then report back the concrete facts you found: file paths, line numbers, and short excerpts.",
  "You typically run alongside sibling explorations in parallel, so stay tightly scoped and keep the work cheap.",
].join(" ");

export const PERSONAS: Record<PersonaName, PersonaDefinition> = {
  "general-purpose": {
    name: "general-purpose",
    description: "Full-tool subagent under the parent's permission gate — for subtasks needing edits, commands, or multi-step execution.",
    tools: GENERAL_PURPOSE_TOOLS,
    systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
  },
  explore: {
    name: "explore",
    description: "Read-only recon subagent (no write/exec) — for sweeping many files when only the conclusion is needed.",
    tools: EXPLORE_TOOLS,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
  },
};

/** Persona names in registration order (for error messages / discovery). */
export function listPersonaNames(): PersonaName[] {
  return Object.keys(PERSONAS) as PersonaName[];
}

/** Narrowing guard: whether an arbitrary agent_type string names a known persona. */
export function isKnownPersona(name: string): name is PersonaName {
  return Object.prototype.hasOwnProperty.call(PERSONAS, name);
}

/** Resolves a known persona; callers must guard with isKnownPersona first. */
export function getPersona(name: PersonaName): PersonaDefinition {
  return PERSONAS[name];
}
