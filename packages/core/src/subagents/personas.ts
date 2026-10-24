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

import type { AgentProfileEngine } from "./profiles.js";
import type { ReasoningEffort } from "../types/config.js";

/**
 * Taskana 4704: the three orchestration role personas join the registry as
 * BUILT-IN personas whose names are OVERRIDABLE by a same-named md-profile
 * (profile wins — see OVERRIDABLE_PERSONAS and the runner's resolution order).
 * general-purpose/explore stay hard-reserved.
 */
export type PersonaName = "general-purpose" | "explore" | "planner" | "executor" | "reviewer";

/** The orchestration role subset of PersonaName (RoleRoute targets). */
export type RolePersonaName = "planner" | "executor" | "reviewer";

/**
 * Role turn budgets (Taskana 4704 §2.9): planner 30, executor 80, reviewer 40.
 * explore keeps DEFAULT_SUBAGENT_MAX_TURNS (it is not a role persona here).
 */
export const ROLE_TURN_BUDGETS: Record<RolePersonaName, number> = {
  planner: 30,
  executor: 80,
  reviewer: 40,
};

/**
 * Effort vocabulary for agent profiles: the global ReasoningEffort tiers plus
 * "xhigh", which is carried verbatim for engine children (claude/codex) and
 * mapped to the existing core "max" at core consumption boundaries.
 */
export type AgentProfileEffort = ReasoningEffort | "xhigh";

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
  /**
   * Default model id for children of this persona (md-profile `model:`
   * frontmatter). An explicit `Agent(model: …)` request outranks it; absent
   * both, the child inherits the parent's port. Built-in personas leave this
   * undefined — they are deliberately model-agnostic.
   */
  model?: string;
  /**
   * Turn budget declared by a role (md-profile `maxTurns:` frontmatter).
   * Clamped to SUBAGENT_MAX_TURNS_CEILING by the runner; absent => the host's
   * `tools.subagentMaxTurns` setting, else DEFAULT_SUBAGENT_MAX_TURNS. Built-in
   * personas leave it undefined ON PURPOSE: a hardcoded role budget would
   * silently outrank the owner-visible setting shipped in 0.0.12. Turns are
   * what actually decides a run: SUBAGENT_LOOP_DEADLINE_MS is sized to catch a
   * hung child, not to end a working one (TASK.148).
   */
  turnBudget?: number;
  /**
   * Reasoning tier declared by a role (md-profile `effort:` frontmatter).
   * Widened to AgentProfileEffort: "xhigh" is carried verbatim for engine
   * children and mapped to the existing core "max" at core consumption
   * boundaries. Absent => the child runs at its connection's default tier.
   * Built-in personas leave it undefined.
   */
  effort?: AgentProfileEffort;
  /**
   * Md-profile `engine:` frontmatter. When set, children of this persona run as
   * a one-shot foreign CLI run (Codex or Claude Code) instead of an in-process
   * AgentLoop — the runner's whole buildChildConfig/AgentLoop path is bypassed
   * in favor of SubagentRunnerOptions.runEngineChild. Built-in personas leave
   * this undefined — they always run in-process.
   */
  engine?: AgentProfileEngine;
  /** Md-profile `connection:` frontmatter — EXACT connection id; resolved by main, never core. */
  connection?: string;
  /** Md-profile `provider:` frontmatter — catalog provider id resolved by main's resolveProviderConnection. */
  provider?: string;
}

/**
 * general-purpose: the nine non-Agent default tools (full access under the
 * parent's inherited permission gate). WebSearch is deliberately NOT here
 * (Taskana 4095 follow-up): it is factory-built at boot only when a search
 * backend is configured, and handing it to EVERY general-purpose child would
 * make paid search calls a new silent default. A child gets it only when its
 * persona/profile `tools:` list — or a workflow step's `tools:` list — names
 * "WebSearch" explicitly (the runner threads the boot tool in then; absent
 * backend => silent skip). explore: strictly read-only tools, so a
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

/** Taskana 4704 §3.1: PLANNER_TOOLS = EXPLORE_TOOLS (read-only investigation + todo planning). */
const PLANNER_TOOLS = ["Read", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch"] as const;

/** Taskana 4704 §3.1: EXECUTOR_TOOLS = GENERAL_PURPOSE_TOOLS (full toolset under the parent's gate). */
const EXECUTOR_TOOLS = GENERAL_PURPOSE_TOOLS;

/** Taskana 4704 §3.1: a reviewer runs tests — Bash included, under the parent's permission gate. */
const REVIEWER_TOOLS = ["Read", "Grep", "Glob", "TodoRead", "TodoWrite", "WebFetch", "Bash"] as const;

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

// Taskana 4704 §3.4 — role persona prompt bodies (verbatim from the design).
const PLANNER_SYSTEM_PROMPT = [
  "You are the planner: a read-only senior engineer who turns a task into an executor brief.",
  "Investigate the code first with Read, Grep and Glob; never edit anything.",
  "Produce one brief containing: ground rules; current state with exact file:line references; concrete changes (files, signatures, logic) that leave the executor no design decisions; test cases with file paths; numbered steps; verification commands; and open questions each with a recommended answer.",
  "Scope the work so it is checkable with unit and integration tests only — no live services, no manual UI checks.",
  "Your final message states the brief's location plus a short summary and the open questions.",
].join(" ");

const EXECUTOR_SYSTEM_PROMPT = [
  "You are the executor: implement a written brief literally and completely.",
  "Work only inside the workspace the brief names, mirror the brief's numbered steps in TodoWrite and update that plan after every step, and before claiming completion run the verification the brief names and report its actual output.",
  "Where the brief is ambiguous or wrong, record the deviation in your final report instead of improvising a different design.",
  "Your final report lists files changed, test and typecheck counts, the commit hash, and any deviations.",
].join(" ");

const REVIEWER_SYSTEM_PROMPT = [
  "You are the reviewer: an independent, adversarial second reader.",
  "Check the change against the task's definition of done and the repository conventions; hunt security holes, data loss, races, wrong error handling, and untested new behavior.",
  "For every finding give file:line, a concrete failure scenario (inputs leading to a wrong result), and a severity; run the targeted tests before you report.",
  "You are read-only: no edits, no commits. Start the report with a verdict line: CLEAN, MINOR, or DEFECTS.",
].join(" ");

/**
 * Both built-in personas declare their turn budget explicitly rather than
 * falling through to DEFAULT_SUBAGENT_TURN_BUDGET: the budget is a property of
 * the role, and the two happening to share a number today is not a reason to
 * couple them to a global. There is no evidence that recon and execution cost
 * different numbers of turns, and the budget that actually decides a run is
 * wall-clock — the turn count only stops a runaway on cheap steps.
 */
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
  // Taskana 4704 §3.1: role personas. turnBudget comes from ROLE_TURN_BUDGETS
  // (§2.9); the built-in defaults are overridable by a same-named md-profile
  // (OVERRIDABLE_PERSONAS below) and by settings-derived role personas
  // (host wiring §3.6) — precedence: md-profile > settings-derived > built-in.
  planner: {
    name: "planner",
    description: "Read-only senior engineer — turns a task into a written executor brief.",
    tools: PLANNER_TOOLS,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    turnBudget: ROLE_TURN_BUDGETS.planner,
  },
  executor: {
    name: "executor",
    description: "Implements a written brief literally and completely.",
    tools: EXECUTOR_TOOLS,
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    turnBudget: ROLE_TURN_BUDGETS.executor,
  },
  reviewer: {
    name: "reviewer",
    description: "Independent adversarial second reader — verdict-line report, no edits.",
    tools: REVIEWER_TOOLS,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    turnBudget: ROLE_TURN_BUDGETS.reviewer,
  },
};

/**
 * Taskana 4704 §2.1: built-in persona names a same-named md-profile (or a
 * settings-derived role persona) may OVERRIDE. general-purpose/explore stay
 * hard-reserved (isReservedPersonaName true) — they are the frozen legacy
 * vocabulary; the three role personas are deliberately overridable so an
 * owner can reshape the orchestration roles without touching core.
 */
export const OVERRIDABLE_PERSONAS: ReadonlySet<string> = new Set(["planner", "executor", "reviewer"]);

/**
 * Whether a profile name is FORBIDDEN for md-profiles: a known built-in that
 * is NOT in the overridable set. Unknown names (future md-profiles) are not
 * reserved — they simply define a new agent type.
 */
export function isReservedPersonaName(name: string): boolean {
  return isKnownPersona(name) && !OVERRIDABLE_PERSONAS.has(name);
}

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
