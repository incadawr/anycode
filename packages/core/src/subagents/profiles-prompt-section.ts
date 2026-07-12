/**
 * Agent-profiles system-prompt section builder (Phase 3 slice 3.7, design

 * workflow/prompt-section.ts: structural placeholder + DATA only
 * (name/description come from the profile's own frontmatter — real prompt
 * copy is a later "prompt phase", not this slice). Deterministic regardless
 * of the input array's order: sorted by name ascending only — PersonaDefinition

 * widened for this), and profiles are few with unique claimed-set names, so
 * name-asc alone is a sufficient total order. Capped at
 * PROFILES_PROMPT_SECTION_MAX_CHARS by dropping WHOLE trailing lines (never
 * mid-line).
 *
 * LOAD-BEARING INVARIANT: zero profiles => "" — a session with no custom
 * agent profiles gets a systemPrompt byte-identical to before this slice
 * (design §2.3). The built-in persona names (general-purpose/explore) are
 * mentioned ONLY in the header below, which is only ever emitted when the
 * section is non-empty — so the "" invariant holds regardless.
 */

import type { PersonaDefinition } from "./personas.js";
import { PROFILES_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

const HEADER_LINES = [
  'The agent profiles below are available agent profiles for the Agent tool; use only the agent_type values listed here or the built-in "general-purpose"/"explore" — never assume an unlisted profile exists.',
  "Available agent profiles (spawn with the Agent tool's agent_type):",
];

/* */
function compareByName(a: PersonaDefinition, b: PersonaDefinition): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Builds the capped, deterministically-ordered agent-profiles prompt section ("" when profiles is empty). */
export function buildProfilesPromptSection(profiles: readonly PersonaDefinition[]): string {
  if (profiles.length === 0) {
    return "";
  }

  const sorted = [...profiles].sort(compareByName);
  const lines = sorted.map((profile) => `- ${profile.name}: ${profile.description}`);

  const headerText = HEADER_LINES.join("\n");
  const full = [headerText, ...lines].join("\n");
  if (full.length <= PROFILES_PROMPT_SECTION_MAX_CHARS) {
    return full;
  }

  // Overflow: drop whole trailing lines (never truncate mid-line) until the
  // section fits. There is no problems[] channel on this signature (frozen by
  // 3.3.1's PersonaDefinition/profiles contract), so the cap event is
  // surfaced via console.warn, mirroring the fail-open diagnostics precedent
  // in skills/prompt-section.ts and workflow/prompt-section.ts.
  const kept: string[] = [];
  let length = headerText.length;
  for (const line of lines) {
    const nextLength = length + 1 + line.length; // +1 for the joining "\n"
    if (nextLength > PROFILES_PROMPT_SECTION_MAX_CHARS) {
      break;
    }
    kept.push(line);
    length = nextLength;
  }

  console.warn(
    `Agent profiles prompt section: capped at ${PROFILES_PROMPT_SECTION_MAX_CHARS} chars — dropped ${
      lines.length - kept.length
    } of ${lines.length} profile line(s).`,
  );

  return [headerText, ...kept].join("\n");
}
