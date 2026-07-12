/**
 * Base system-prompt builder (Phase 3 slice 3.6, design §2.1). A PURE function of
 * injected data: it never reads the clock, `process.env`, or the filesystem, so

 * green. The wiring (cli/main.ts, host/index.ts) computes SystemPromptEnv once at
 * boot and hands it in.
 *
 * Section order is fixed (identity -> conventions -> safety -> tool-discipline ->
 * env), joined by "\n\n". Static prose leads and the data (tool snapshot, env)
 * trails, so the stable prefix is cache-ready for a future model-port delta

 * output never depends on registration order. Absent/empty env or toolNames
 * degrade gracefully — the env section is omitted and the tool-discipline section
 * generalizes — leaving no empty gaps.
 */

import {
  SECTION_CONVENTIONS,
  SECTION_IDENTITY,
  SECTION_SAFETY,
  SECTION_TOOL_DISCIPLINE_GENERIC,
  SECTION_TOOL_DISCIPLINE_TEMPLATE,
} from "./sections.js";

/**
 * Session-static environment facts injected by wiring. The builder NEVER derives
 * these itself (no clock/process/fs reads) — they are computed once at boot so
 * the prompt is a deterministic function of its inputs.
 */
export interface SystemPromptEnv {
  workingDirectory: string;
  /** `process.platform` value, e.g. "darwin". */
  platform: string;
  osVersion?: string;
  /** e.g. "2026-07-04"; computed once at boot, static for the session. */
  date: string;
  modelId?: string;
  isGitRepo?: boolean;
}

export interface SystemPromptOptions {
  /**
   * Boot snapshot of `registry.list()` (built-ins + `mcp__*`). Sorted internally;
   * absent/[] => the generic tool-discipline text without an enumeration.
   */
  toolNames?: readonly string[];
  env?: SystemPromptEnv;
}

/**
 * Tool-discipline section. With a non-empty snapshot the enumeration TEMPLATE is
 * used and the sorted names are appended on their own line; otherwise the GENERIC
 * variant (same rules, no enumeration). Shared with the subagent prelude so a
 * child's own registry drives the same discipline text.
 */
export function renderToolDisciplineSection(toolNames?: readonly string[]): string {
  if (!toolNames || toolNames.length === 0) {
    return SECTION_TOOL_DISCIPLINE_GENERIC;
  }
  const sorted = [...toolNames].sort();
  return `${SECTION_TOOL_DISCIPLINE_TEMPLATE}\n${sorted.join(", ")}`;
}

/**
 * `<env>` block from the injected facts. Returns "" when no env was provided
 * (section omitted). Only the fields present on SystemPromptEnv are rendered —
 * there is no path by which an arbitrary env-var value could leak in (design

 */
export function renderEnvSection(env?: SystemPromptEnv): string {
  if (!env) {
    return "";
  }
  const lines: string[] = [
    `Working directory: ${env.workingDirectory}`,
    `Platform: ${env.platform}`,
  ];
  if (env.osVersion) {
    lines.push(`OS version: ${env.osVersion}`);
  }
  lines.push(`Today's date: ${env.date}`);
  if (env.modelId) {
    lines.push(`Model: ${env.modelId}`);
  }
  if (env.isGitRepo !== undefined) {
    lines.push(`Git repository: ${env.isGitRepo ? "yes" : "no"}`);
  }
  return `<env>\n${lines.join("\n")}\n</env>`;
}

/**
 * Builds the base system prompt. A zero-arg call stays valid (every existing call
 * site / test compiles unchanged); enrichment is opt-in through `options`.
 */
export function buildSystemPrompt(options?: SystemPromptOptions): string {
  const sections = [
    SECTION_IDENTITY,
    SECTION_CONVENTIONS,
    SECTION_SAFETY,
    renderToolDisciplineSection(options?.toolNames),
    renderEnvSection(options?.env),
  ];
  return sections.filter((section) => section.length > 0).join("\n\n");
}
