/**
 * Workflow template util (Phase 3 slice 3.4, design §2.8). The ONE shared
 * definition helper used by BOTH wave lanes: the engine (3.4.2) renders step
 * prompts + the run output, and schema/discovery (3.4.3) statically validates
 * that a step only references its declared dependencies (refs ⊆ dependsOn,
 * §3.1). A full util owned by the blocking task 3.4.1 — the frontmatter.ts
 * precedent from slice 3.3.1.
 *
 * Exactly two placeholder forms are recognized inside a template:
 *   - ${input}          — the run's task text.
 *   - ${steps.<id>}     — the finalText of a completed step, where <id> matches
 *                         the step-id shape ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$.
 * ANY other `$` / `${...}` sequence is inert literal text (never substituted),
 * so user prompts may contain shell-style `$VAR` or `${foo}` freely.
 */

/**
 * Placeholder grammar. Group 1 = the whole inner token (`input` or
 * `steps.<id>`); group 2 = the step id (present only for a ${steps.<id>} token).
 * A ${steps.<id>} token matches ONLY when `}` immediately follows the id, so a
 * dotted form like ${steps.a.b} does not match and stays inert.
 */
const PLACEHOLDER_PATTERN = "\\$\\{(input|steps\\.([A-Za-z0-9][A-Za-z0-9_-]{0,63}))\\}";

export interface TemplateRefs {
  /** Whether ${input} appears at least once. */
  input: boolean;
  /** Distinct step ids referenced via ${steps.<id>}, in first-appearance order. */
  stepIds: string[];
}

/**
 * Scans the recognized ${input} / ${steps.<id>} placeholders. Reports whether
 * ${input} appears and the DISTINCT referenced step ids (first-appearance
 * order). Unrecognized `$`/`${...}` sequences are ignored (inert text).
 */
export function scanTemplateRefs(template: string): TemplateRefs {
  const re = new RegExp(PLACEHOLDER_PATTERN, "g");
  let input = false;
  const stepIds: string[] = [];
  const seen = new Set<string>();
  for (let match = re.exec(template); match !== null; match = re.exec(template)) {
    const stepId = match[2];
    if (stepId === undefined) {
      input = true;
    } else if (!seen.has(stepId)) {
      seen.add(stepId);
      stepIds.push(stepId);
    }
  }
  return { input, stepIds };
}

/**
 * Substitutes ${input} and ${steps.<id>} with the provided values, leaving any
 * unrecognized sequence verbatim. Substituted values are inserted literally
 * (a `$` inside a value is never re-interpreted as a placeholder). A
 * ${steps.<id>} whose id is absent from `vars.steps` THROWS — the engine turns
 * that into a failed outcome, and static validation (refs ⊆ dependsOn) makes it
 * unreachable on a valid graph.
 */
export function renderTemplate(
  template: string,
  vars: { input: string; steps: ReadonlyMap<string, string> },
): string {
  const re = new RegExp(PLACEHOLDER_PATTERN, "g");
  return template.replace(re, (_full, _inner, stepId?: string) => {
    if (stepId === undefined) {
      return vars.input;
    }
    const value = vars.steps.get(stepId);
    if (value === undefined) {
      throw new Error(`Unknown workflow step reference \${steps.${stepId}}`);
    }
    return value;
  });
}
