/**
 * Workflow definition schema + structural validation (Phase 3 slice 3.4, design
 * §3.1). Two passes over one raw JSON value:
 *
 *  1. zod (`definitionSchema`) checks SHAPE ONLY — required/optional fields,
 *     array bounds (1..MAX_WORKFLOW_STEPS), numeric ranges (maxTurns).
 *     Unknown top-level/step keys are silently stripped (plain `z.object`, no
 *     `.strict()`/`.passthrough()` — the mcp/config.ts + plugins/manifest.ts
 *     precedent), so ecosystem definitions with extra fields (e.g. a future
 *     `model` per U5-P3) parse cleanly today.
 *  2. Post-zod structural validation (this file, hand-rolled — cross-field
 *     rules zod cannot express): name/id alphabet, id uniqueness, dependsOn
 *     existence + no self-dep, acyclicity (Kahn), and the "data flows only
 *     along declared edges" rule — `scanTemplateRefs(step.promptTemplate)
 *     .stepIds` must be a subset of that STEP's OWN `dependsOn` (direct
 *     membership, not the transitive ancestor set: an ancestor two hops away
 *     must be re-declared as a direct dependency to be referenced, so the
 *     graph never has a hidden data edge — design §3.1 item 3 verbatim).
 *
 * ANY violation (zod or structural) rejects the WHOLE definition: one
 * `problem` string, no partial/best-effort definition — the discovery layer
 * (3.4.3) turns that into a fail-soft skip, never a crash.
 */

import { z } from "zod";
import type { WorkflowDefinition, WorkflowStepDefinition } from "../ports/workflow.js";
import { scanTemplateRefs } from "./template.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_WORKFLOW_STEPS,
  WORKFLOW_TEMPLATE_MAX_BYTES,
} from "../types/config.js";

export interface WorkflowParseContext {
  /** Provenance label ("project" | "user" | ...). */
  source: string;
  /** Absolute definition path. */
  path: string;
  /** Name fallback (file stem without .json) when the definition omits `name`. */
  fallbackName: string;
}

export interface WorkflowParseResult {
  /** The validated definition, or undefined when the raw input was rejected. */
  definition?: WorkflowDefinition;
  /** Fail-soft rejection reason (schema violation, cycle, bad refs, cap …). */
  problem?: string;
}

/** Shared name alphabet for workflow/step names (mirrors SKILL_NAME_RE / profiles.ts NAME_RE). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A raw string field capped at WORKFLOW_TEMPLATE_MAX_BYTES (UTF-8), used for both templates. */
const templateStringSchema = z
  .string()
  .refine((value) => byteLength(value) <= WORKFLOW_TEMPLATE_MAX_BYTES, {
    message: `exceeds WORKFLOW_TEMPLATE_MAX_BYTES (${WORKFLOW_TEMPLATE_MAX_BYTES} bytes)`,
  });

const stepSchema = z.object({
  id: z.string().min(1),
  agentType: z.string().min(1),
  promptTemplate: templateStringSchema,
  dependsOn: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(DEFAULT_SUBAGENT_MAX_TURNS).optional(),
});

const definitionSchema = z.object({
  name: z.string().optional(),
  description: z.string(),
  steps: z.array(stepSchema).min(1).max(MAX_WORKFLOW_STEPS),
  outputTemplate: templateStringSchema.optional(),
});

type RawStep = z.output<typeof stepSchema>;

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Runs Kahn's algorithm over the dependsOn graph. Returns the ids that could
 * NOT be resolved (i.e. every step reachable from — or a member of — a cycle),
 * in original definition order; an empty array means the graph is acyclic.
 * Never loops indefinitely: each pass either resolves >=1 step or the whole
 * thing terminates (design §3.1 item 2 — "a cyclic dependsOn is a parse error,
 * never a runtime hang").
 */
function findUnresolvedSteps(steps: readonly RawStep[]): string[] {
  const remainingDeps = new Map<string, Set<string>>(
    steps.map((step) => [step.id, new Set(step.dependsOn ?? [])]),
  );
  const resolved = new Set<string>();

  let progressed = true;
  while (progressed && remainingDeps.size > 0) {
    progressed = false;
    for (const [id, deps] of remainingDeps) {
      if ([...deps].every((dep) => resolved.has(dep))) {
        resolved.add(id);
        remainingDeps.delete(id);
        progressed = true;
      }
    }
  }

  return steps.map((step) => step.id).filter((id) => remainingDeps.has(id));
}

/**
 * Parses + validates one raw definition object (already JSON.parse'd) into a
 * WorkflowDefinition. Never throws — a non-conforming definition returns a
 * `problem` and no `definition` (the discovery layer drops it fail-soft).
 */
export function parseWorkflowDefinition(
  raw: unknown,
  ctx: WorkflowParseContext,
): WorkflowParseResult {
  const result = definitionSchema.safeParse(raw);
  if (!result.success) {
    return { problem: `Workflow ${ctx.path}: ${describeZodError(result.error)}` };
  }
  const data = result.data;

  const name = (data.name ?? "").trim() || ctx.fallbackName;
  if (!NAME_RE.test(name)) {
    return { problem: `Workflow ${ctx.path}: name "${name}" must match ${NAME_RE.source}` };
  }

  const description = data.description.trim();
  if (!description) {
    return { problem: `Workflow ${ctx.path}: missing "description"` };
  }

  for (const step of data.steps) {
    if (!NAME_RE.test(step.id)) {
      return {
        problem: `Workflow ${ctx.path}: step id "${step.id}" must match ${NAME_RE.source}`,
      };
    }
  }

  const ids = new Set<string>();
  for (const step of data.steps) {
    if (ids.has(step.id)) {
      return { problem: `Workflow ${ctx.path}: duplicate step id "${step.id}"` };
    }
    ids.add(step.id);
  }

  for (const step of data.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.id) {
        return { problem: `Workflow ${ctx.path}: step "${step.id}" depends on itself` };
      }
      if (!ids.has(dep)) {
        return {
          problem: `Workflow ${ctx.path}: step "${step.id}" depends on unknown step "${dep}"`,
        };
      }
    }
  }

  const unresolved = findUnresolvedSteps(data.steps);
  if (unresolved.length > 0) {
    return {
      problem: `Workflow ${ctx.path}: dependency cycle among step(s) ${unresolved.join(", ")}`,
    };
  }


  // ${steps.<id>} placeholders must be a subset of ITS OWN dependsOn — not the
  // transitive ancestor set — so the definition never has an implicit edge.
  for (const step of data.steps) {
    const dependsOn = new Set(step.dependsOn ?? []);
    const refs = scanTemplateRefs(step.promptTemplate);
    for (const ref of refs.stepIds) {
      if (!dependsOn.has(ref)) {
        return {
          problem: `Workflow ${ctx.path}: step "${step.id}" references \${steps.${ref}} which is not in its dependsOn`,
        };
      }
    }
  }

  const steps: WorkflowStepDefinition[] = data.steps.map((step) => ({
    id: step.id,
    agentType: step.agentType,
    promptTemplate: step.promptTemplate,
    ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
    ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
  }));

  const definition: WorkflowDefinition = {
    name,
    description,
    steps,
    ...(data.outputTemplate !== undefined ? { outputTemplate: data.outputTemplate } : {}),
    source: ctx.source,
    path: ctx.path,
  };

  return { definition };
}
