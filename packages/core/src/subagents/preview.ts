/**
 * Subagent editor preview (P7.21 W1, design §2-D4 + §4-W1). Computes the REAL
 * final child system prompt a draft profile would spawn with, so the editor's
 * Preview tab shows the genuine builder output rather than a lookalike.
 *
 * `DEFAULT_TOOL_NAMES` is a DATA constant (personas.ts ethic — spelled out, not
 * imported from tools/registry.ts) so this module stays main-safe (no ai-SDK, no
 * loop): the tool registry lives behind the loop tree. A W1 parity test pins it
 * against `createDefaultToolRegistry().list()`, and `buildProfilePreview`'s output
 * is pinned against a real `buildChildConfig(...).systemPrompt` modulo env/memory
 * — either drift turns a test red.
 *
 * ⚠ Main-safe: node-free, imports only prompts/subagent (ai-SDK-free), personas
 * (data), config constants, the spawn-tools leaf, and util/bytes.
 */

import { buildSubagentSystemPrompt } from "../prompts/subagent.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES } from "../types/config.js";
import { PERSONAS } from "./personas.js";
import { SPAWN_TOOLS } from "./spawn-tools.js";

/**
 * The default tool registry's tool NAMES, in registration order — a data mirror
 * of `createDefaultToolRegistry().list()` (Read, Write, Edit, Bash, Grep, Glob,
 * TodoRead, TodoWrite, WebFetch, Agent, Skill, Workflow). Kept in sync by the
 * parity test in preview.test.ts. Used to intersect a profile's requested tools
 * down to real, grantable tools (the ∩-semantics buildPersonaRegistry applies).
 */
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "Agent",
  "Skill",
  "Workflow",
];

/**
 * The effective child tool list for a profile's requested `tools`, replicating
 * `runner.buildPersonaRegistry` exactly: iterate in request order, DROP the
 * spawn-capable tools (non-recursion lock #1), keep only names that exist in the
 * default registry, and dedupe (first occurrence wins — the registry ignores a
 * duplicate register). The result order matches `registry.list()`.
 */
export function effectiveProfileTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of tools) {
    if (SPAWN_TOOLS.has(name)) {
      continue;
    }
    if (!DEFAULT_TOOL_NAMES.includes(name)) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** A draft profile the editor previews/serializes/validates. */
export interface SubagentProfileDraft {
  name: string;
  description: string;
  /** Absent ⇒ inherit the general-purpose baseline (nine non-spawn tools). */
  tools?: readonly string[];
  /** Raw child systemPrompt body (the loader caps it + placeholders an empty one). */
  body: string;
}

export interface ProfilePreview {
  /** The real final child system prompt (env + memory sections omitted). */
  systemPrompt: string;
  /** The effective grantable child tools advertised in the prompt. */
  effectiveTools: string[];
}

/**
 * Builds the preview a draft would spawn with. Resolves the child tools + body
 * exactly as discovery/runner would (baseline fallback when `tools` is absent,
 * the same UTF-8 cap + empty-body placeholder), then calls the REAL
 * `buildSubagentSystemPrompt` — the same builder `buildChildConfig` uses — with
 * env/memory omitted (injected at spawn time; the pane renders a caption for it).
 */
export function buildProfilePreview(draft: SubagentProfileDraft): ProfilePreview {
  const requestedTools = draft.tools ?? PERSONAS["general-purpose"].tools;
  const effectiveTools = effectiveProfileTools(requestedTools);
  const capped = capUtf8Bytes(draft.body, AGENT_PROFILE_PROMPT_MAX_BYTES);
  const systemPromptBody =
    capped.text.trim().length > 0 ? capped.text : `[agent profile "${draft.name}" — empty body]`;
  const systemPrompt = buildSubagentSystemPrompt(
    { name: draft.name, systemPrompt: systemPromptBody },
    { toolNames: effectiveTools },
  );
  return { systemPrompt, effectiveTools };
}
