/**

 *
 * Structural placeholder + DATA only (name/description come from the user's
 * own frontmatter — real prompt copy is a later "prompt phase", not this
 * slice). Deterministic regardless of the input array's order: sorted by
 * source precedence (project > user > plugin:*, ties on the source string
 * itself so multiple plugins land in name order per §3.3), then by skill name
 * ascending within a source. Capped at SKILLS_PROMPT_SECTION_MAX_CHARS by
 * dropping WHOLE trailing lines (never mid-line).
 *
 * LOAD-BEARING INVARIANT: zero skills => "" — a session with no skills gets a

 */

import type { SkillMeta } from "../ports/skills.js";
import { SKILLS_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

const HEADER_LINES = [
  "The skills below are available in this session; load only the names listed here, and only through the Skill tool — never assume an unlisted skill exists.",
  "Available skills (load full instructions with the Skill tool by name):",
];

/** project > user > plugin/other > builtin; ties fall through to the source string. */
const KNOWN_SOURCE_RANK: Record<string, number> = { project: 0, user: 1, builtin: 3 };

function sourceRank(source: string): number {
  return KNOWN_SOURCE_RANK[source] ?? 2;
}

/** Precedence order (source rank, then the source string, then name-asc). */
function compareMeta(a: SkillMeta, b: SkillMeta): number {
  const rankDiff = sourceRank(a.source) - sourceRank(b.source);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Builds the capped, deterministically-ordered skills prompt section ("" when metas is empty). */
export function buildSkillsPromptSection(metas: readonly SkillMeta[]): string {
  if (metas.length === 0) {
    return "";
  }

  const sorted = [...metas].sort(compareMeta);
  const lines = sorted.map((meta) => `- ${meta.name} (${meta.source}): ${meta.description}`);

  const headerText = HEADER_LINES.join("\n");
  const full = [headerText, ...lines].join("\n");
  if (full.length <= SKILLS_PROMPT_SECTION_MAX_CHARS) {
    return full;
  }

  // Overflow: drop whole trailing lines (never truncate mid-line) until the
  // section fits. There is no problems[] channel on this signature (frozen by
  // 3.3.1), so the cap event is surfaced via console.warn, mirroring the
  // fail-open diagnostics precedent in dispatch/hook-config.ts.
  const kept: string[] = [];
  let length = headerText.length;
  for (const line of lines) {
    const nextLength = length + 1 + line.length; // +1 for the joining "\n"
    if (nextLength > SKILLS_PROMPT_SECTION_MAX_CHARS) {
      break;
    }
    kept.push(line);
    length = nextLength;
  }

  console.warn(
    `Skills prompt section: capped at ${SKILLS_PROMPT_SECTION_MAX_CHARS} chars — dropped ${
      lines.length - kept.length
    } of ${lines.length} skill line(s).`,
  );

  return [headerText, ...kept].join("\n");
}
