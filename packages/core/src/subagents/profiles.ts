/**
 * Agent profiles (Phase 3 slice 3.3, design §3.5). Md-profiles under
 * `.anycode/agents/*.md` (and plugin agentRoots) become extra SubagentPort
 * personas: frontmatter (name/description/tools) + the file body as the child's
 * systemPrompt, mapped to a PersonaDefinition whose allowlist is intersected
 * with the default registry by the existing buildPersonaRegistry (∩-semantics,
 * both non-recursion locks intact — Agent is dropped by lock #1, the child
 * receives no port by lock #2).
 *
 * Discovery mirrors the config precedents: roots are scanned high→low precedence
 * (caller-ordered), a NAME is claimed entirely by the highest-precedence source
 * (claimed-set, mcp/config.ts §3.4), built-in persona names are reserved
 * (profiles cannot override general-purpose/explore — second rubicon is runner
 * resolution, design §2.5), and every readdir/stat/read/parse failure is a
 * fail-soft problem that never crashes boot.
 *
 * The per-file frontmatter→validated-persona logic lives in the pure
 * `parseAgentProfileMd` (P7.21 W1, design §2-D8): discovery below and the
 * main-safe admin validator/preview share it, so the format has ONE oracle and
 * the editor can never write a file discovery would reject. The cross-file
 * concerns (claimed-set dedupe, MAX_AGENT_PROFILES cap, path-prefixed problem
 * text) stay in the loop here — the parser is per-file only.
 */

import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseFrontmatter, splitList } from "../skills/frontmatter.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES, MAX_AGENT_PROFILES } from "../types/config.js";
import { PERSONAS, isKnownPersona, type PersonaDefinition } from "./personas.js";
import { SPAWN_TOOLS } from "./spawn-tools.js";

/** One directory to scan for `*.md` profiles, tagged with its provenance. */
export interface AgentProfileRoot {
  /** Absolute directory holding flat `*.md` profile files. */
  dir: string;
  /** "project" | "user" | "plugin:<pluginName>" (precedence label). */
  source: string;
}

export interface AgentProfilesResult {
  /** Personas ready to hand to SubagentRunnerOptions.profiles. */
  profiles: PersonaDefinition[];
  /** Fail-soft problems (unreadable dir, bad frontmatter, collision, cap …). */
  problems: string[];
}

/** Profile/skill name shape (design §2.10); the {0,63} tail also caps length at 64. */
export const AGENT_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** One per-file parse of a profile `*.md`, ready for both discovery and admin. */
export interface ParsedAgentProfile {
  /** Resolved name (frontmatter `name`, else the fallback), regex-valid, not reserved. */
  name: string;
  /** Required non-empty description. */
  description: string;
  /**
   * Tool names AS-IS (an explicit frontmatter list — including any Agent/Workflow
   * entries, kept so buildPersonaRegistry's ∩-with-registry drop is the single
   * gate — or the general-purpose baseline when `tools` was absent).
   */
  tools: readonly string[];
  /** True when the frontmatter carried an explicit `tools:` line. */
  toolsExplicit: boolean;
  /** Child systemPrompt: the body capped UTF-8-safe, empty → a placeholder. */
  body: string;
  /**
   * Non-fatal per-file problems (path-free suffixes) — currently only explicit
   * spawn-tool requests. The caller prefixes each with `Agent profile <path>: `.
   */
  problems: string[];
}

/**
 * A fatal per-file parse failure. `frontmatter` carries the raw parser detail
 * (the caller renders "Invalid agent profile <path>: <detail>"); the name-bearing
 * kinds carry the resolved name so the caller can honor the exact claim-set
 * semantics (a bad/reserved name never claims; a missing-description name does).
 */
export type AgentProfileParseError =
  | { kind: "frontmatter"; detail: string }
  | { kind: "bad_name"; name: string }
  | { kind: "reserved_name"; name: string }
  | { kind: "missing_description"; name: string };

export type ParseAgentProfileResult =
  | { ok: ParsedAgentProfile }
  | { error: AgentProfileParseError };

/**
 * Pure per-file parse+validate of a profile `*.md`. NO I/O, NO cross-file state
 * (claimed-set / cap live in the caller). Byte-for-byte the semantics discovery
 * has always applied, factored out so the admin validator/preview reuse the same
 * oracle. `fallbackName` is the filename without `.md` (frontmatter `name` wins).
 */
export function parseAgentProfileMd(raw: string, fallbackName: string): ParseAgentProfileResult {
  const parsed = parseFrontmatter(raw);
  if ("error" in parsed) {
    return { error: { kind: "frontmatter", detail: parsed.error } };
  }

  // name: frontmatter `name`, fallback = filename without `.md`.
  const name = (parsed.fields.name ?? "").trim() || fallbackName;
  if (!AGENT_PROFILE_NAME_RE.test(name)) {
    return { error: { kind: "bad_name", name } };
  }

  // Built-in names are reserved: a profile can never override
  // general-purpose/explore (discovery is the first rubicon; runner resolution is
  // the second, design §2.5/§3.5).
  if (isKnownPersona(name)) {
    return { error: { kind: "reserved_name", name } };
  }

  // description is required — nothing to advertise without it.
  const description = (parsed.fields.description ?? "").trim();
  if (!description) {
    return { error: { kind: "missing_description", name } };
  }

  // tools: an explicit list is kept AS-IS — buildPersonaRegistry applies the ∩
  // with the default registry (unknown names are no-ops; spawn tools are dropped
  // by lock #1). An explicit spawn tool (Agent/Workflow) is additionally surfaced
  // as a problem. An absent list falls back to the general-purpose baseline (nine
  // non-spawn tools); a profile can never widen beyond the default registry.
  const problems: string[] = [];
  let tools: readonly string[];
  let toolsExplicit: boolean;
  if (parsed.fields.tools !== undefined) {
    toolsExplicit = true;
    tools = splitList(parsed.fields.tools);
    for (const spawnTool of SPAWN_TOOLS) {
      if (tools.includes(spawnTool)) {
        problems.push(`requests ${spawnTool} — ignored (non-recursion lock)`);
      }
    }
  } else {
    toolsExplicit = false;
    tools = PERSONAS["general-purpose"].tools;
  }

  // File body = child systemPrompt (user content, capped UTF-8-safe); an empty
  // body gets a placeholder like the built-in personas.
  const capped = capUtf8Bytes(parsed.body, AGENT_PROFILE_PROMPT_MAX_BYTES);
  const body =
    capped.text.trim().length > 0 ? capped.text : `[agent profile "${name}" — empty body]`;

  return { ok: { name, description, tools, toolsExplicit, body, problems } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discovers md-profiles across the given roots (precedence high→low, built-in
 * names reserved, per-name dedupe, MAX_AGENT_PROFILES cap). Never throws: any
 * unreadable directory/file or non-conforming frontmatter is recorded as a
 * fail-soft problem and skipped.
 */
export async function discoverAgentProfiles(
  fs: FileSystemPort,
  roots: readonly AgentProfileRoot[],
): Promise<AgentProfilesResult> {
  const profiles: PersonaDefinition[] = [];
  const problems: string[] = [];
  // A name claimed by a higher-precedence source shadows lower sources (mirror
  // of mcp/config claimed-set): an errored/capped high entry still claims it.
  const claimed = new Set<string>();

  for (const root of roots) {
    // A missing root directory is normal (no `.anycode/agents`) — silent no-op.
    if (!(await fs.exists(root.dir))) {
      continue;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch (error) {
      problems.push(`Could not read agent-profile dir ${root.dir}: ${describeError(error)}`);
      continue;
    }

    // Deterministic within-source order (name-asc): flat `*.md` files only.
    const files = entries.filter((entry) => entry.endsWith(".md")).sort();
    for (const file of files) {
      const path = join(root.dir, file);

      let stats;
      try {
        stats = await fs.stat(path);
      } catch (error) {
        problems.push(`Could not stat agent profile ${path}: ${describeError(error)}`);
        continue;
      }
      // A `*.md` directory is not a profile (the ecosystem form is a flat file).
      if (!stats.isFile) {
        continue;
      }

      let raw: string;
      try {
        raw = await fs.readFile(path);
      } catch (error) {
        problems.push(`Could not read agent profile ${path}: ${describeError(error)}`);
        continue;
      }

      const result = parseAgentProfileMd(raw, file.slice(0, -3));
      if ("error" in result) {
        const err = result.error;
        switch (err.kind) {
          case "frontmatter":
            problems.push(`Invalid agent profile ${path}: ${err.detail}`);
            break;
          case "bad_name":
            // A bad-name file never claims the name (the claim happens only after
            // name/reserved validation passes — original discovery order).
            problems.push(
              `Agent profile ${path}: name "${err.name}" must match ${AGENT_PROFILE_NAME_RE.source} — ignored`,
            );
            break;
          case "reserved_name":
            problems.push(
              `Agent profile ${path}: name "${err.name}" is reserved by a built-in persona — ignored`,
            );
            break;
          case "missing_description":
            // A same-named higher-precedence source already claimed this name:
            // skip silently (no problem) — matches the original claimed-set guard
            // sitting BEFORE the description check.
            if (claimed.has(err.name)) {
              break;
            }
            // Otherwise the name IS claimed (original claims before validating the
            // description) so a lower valid same-named file stays shadowed.
            claimed.add(err.name);
            problems.push(`Agent profile ${path}: missing "description" — ignored`);
            break;
        }
        continue;
      }

      const { name, description, tools, body } = result.ok;

      // Precedence dedupe: a lower source's same-named file is shadowed silently.
      if (claimed.has(name)) {
        continue;
      }
      claimed.add(name);

      // Cap the total after dedupe (design §3.5).
      if (profiles.length >= MAX_AGENT_PROFILES) {
        problems.push(
          `Agent profile ${path}: exceeds MAX_AGENT_PROFILES (${MAX_AGENT_PROFILES}) — ignored`,
        );
        continue;
      }

      // Surface the per-file non-fatal problems (explicit spawn tools) only once
      // the file is actually kept — original discovery processed tools AFTER the
      // dedupe/cap gates, so a shadowed/capped file emitted no spawn problem.
      for (const suffix of result.ok.problems) {
        problems.push(`Agent profile ${path}: ${suffix}`);
      }

      profiles.push({ name, description, tools, systemPrompt: body });
    }
  }

  return { profiles, problems };
}
