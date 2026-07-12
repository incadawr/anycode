/**
 * Workflows system-prompt section builder (Phase 3 slice 3.4, design §3.6).
 * Mirrors skills/prompt-section.ts: structural placeholder + DATA only
 * (name/description/step-count from the user's own definitions — real prompt
 * copy is the later prompt phase), deterministic (source-rank → name-asc),
 * capped at WORKFLOWS_PROMPT_SECTION_MAX_CHARS by dropping whole trailing
 * lines (never mid-line).
 *
 * LOAD-BEARING INVARIANT: zero workflows => "" — a session with no workflows
 * gets a systemPrompt byte-identical to before this slice.
 */

import type { WorkflowMeta } from "../ports/workflow.js";
import { WORKFLOWS_PROMPT_SECTION_MAX_CHARS } from "../types/config.js";

const HEADER_LINES = [
  "The workflows below are available in this session; run only the names listed here, and only through the Workflow tool — never assume an unlisted workflow exists.",
  "Available workflows (run with the Workflow tool by name):",
];

/** project > user > everything else; ties fall through to the source string. */
const KNOWN_SOURCE_RANK: Record<string, number> = { project: 0, user: 1 };

function sourceRank(source: string): number {
  return KNOWN_SOURCE_RANK[source] ?? 2;
}

/** Precedence order (source rank, then the source string, then name-asc). */
function compareMeta(a: WorkflowMeta, b: WorkflowMeta): number {
  const rankDiff = sourceRank(a.source) - sourceRank(b.source);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Builds the capped, deterministically-ordered workflows prompt section ("" when metas is empty). */
export function buildWorkflowsPromptSection(metas: readonly WorkflowMeta[]): string {
  if (metas.length === 0) {
    return "";
  }

  const sorted = [...metas].sort(compareMeta);
  const lines = sorted.map(
    (meta) => `- ${meta.name} (${meta.source}, ${meta.stepCount} steps): ${meta.description}`,
  );

  const headerText = HEADER_LINES.join("\n");
  const full = [headerText, ...lines].join("\n");
  if (full.length <= WORKFLOWS_PROMPT_SECTION_MAX_CHARS) {
    return full;
  }

  // Overflow: drop whole trailing lines (never truncate mid-line) until the
  // section fits. There is no problems[] channel on this signature (frozen by
  // 3.4.1), so the cap event is surfaced via console.warn, mirroring the
  // fail-open diagnostics precedent in skills/prompt-section.ts.
  const kept: string[] = [];
  let length = headerText.length;
  for (const line of lines) {
    const nextLength = length + 1 + line.length; // +1 for the joining "\n"
    if (nextLength > WORKFLOWS_PROMPT_SECTION_MAX_CHARS) {
      break;
    }
    kept.push(line);
    length = nextLength;
  }

  console.warn(
    `Workflows prompt section: capped at ${WORKFLOWS_PROMPT_SECTION_MAX_CHARS} chars — dropped ${
      lines.length - kept.length
    } of ${lines.length} workflow(s).`,
  );

  return [headerText, ...kept].join("\n");
}
