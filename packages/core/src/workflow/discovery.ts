/**
 * Workflow discovery (Phase 3 slice 3.4, design §3.2). Mirrors profiles.ts
 * DOSLOVNO: flat `*.json` files directly under each root (no subdirectory
 * walk, unlike skills' `<dir>/SKILL.md`), `fs.exists` -> `readdir` -> `stat`
 * -> `readFile` through the FileSystemPort ONLY (zero node:fs — node:path's
 * `join` is a pure string helper, not a filesystem access), `JSON.parse` +
 * `parseWorkflowDefinition` (schema.ts) for validation, claimed-set dedupe by
 * name (highest-precedence root wins, per the caller-supplied root order),
 * `MAX_WORKFLOWS` cap applied AFTER dedupe across every source, and fail-soft
 * throughout: any unreadable directory/file, invalid JSON, or schema/cycle/
 * ref rejection is a `problems[]` entry and that ONE definition is skipped —
 * discovery itself never throws.
 *
 * `agentType` values are NOT checked against any persona/profile registry
 * here (design §3.1 item 4) — that is resolved fail-fast at RUN start
 * (workflow/engine.ts, slice 3.4.2), because agent-profile discovery is a
 * parallel bootstrap subsystem with no ordering guarantee relative to this one.
 */

import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { WorkflowDefinition } from "../ports/workflow.js";
import { parseWorkflowDefinition } from "./schema.js";
import { MAX_WORKFLOWS } from "../types/config.js";

/** One directory to scan for `*.json` workflow definitions, tagged with its provenance. */
export interface WorkflowRoot {
  /** Absolute directory holding flat `*.json` definition files. */
  dir: string;
  /** "project" | "user" (precedence label). */
  source: string;
}

export interface WorkflowDiscoveryResult {
  /** Validated definitions (empty when there are none). */
  workflows: WorkflowDefinition[];
  /** Fail-soft problems (unreadable dir, bad JSON, schema/cycle rejection, cap …). */
  problems: string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Discovers workflow definitions across the given roots (precedence high→low,
 * per-name dedupe, MAX_WORKFLOWS cap). Never throws: any unreadable
 * directory/file or non-conforming definition is a fail-soft problem.
 */
export async function discoverWorkflows(
  fs: FileSystemPort,
  roots: readonly WorkflowRoot[],
): Promise<WorkflowDiscoveryResult> {
  const problems: string[] = [];
  // Two roots naming the identical directory (workspace === home) are scanned
  // once (mirror of skills/profiles discovery's "load once" precedent).
  const seenDirs = new Set<string>();
  // A name claimed by a higher-precedence source shadows lower sources
  // silently — the same claimed-set semantics as profiles.ts/mcp/config.ts.
  const claimed = new Map<string, WorkflowDefinition>();

  for (const root of roots) {
    if (seenDirs.has(root.dir)) {
      continue;
    }
    seenDirs.add(root.dir);

    // A missing root directory is normal (no `.anycode/workflows`) — silent no-op.
    if (!(await fs.exists(root.dir))) {
      continue;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch (error) {
      problems.push(`Could not read workflow dir ${root.dir}: ${describeError(error)}`);
      continue;
    }

    // Deterministic within-source order (name-asc): flat `*.json` files only.
    const files = entries.filter((entry) => entry.endsWith(".json")).sort();
    for (const file of files) {
      const path = join(root.dir, file);

      let stats;
      try {
        stats = await fs.stat(path);
      } catch (error) {
        problems.push(`Could not stat workflow ${path}: ${describeError(error)}`);
        continue;
      }
      // A `*.json`-suffixed directory is not a definition (flat-file convention).
      if (!stats.isFile) {
        continue;
      }

      let raw: string;
      try {
        raw = await fs.readFile(path);
      } catch (error) {
        problems.push(`Could not read workflow ${path}: ${describeError(error)}`);
        continue;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (error) {
        problems.push(`Invalid JSON in workflow ${path}: ${describeError(error)}`);
        continue;
      }

      const fallbackName = file.slice(0, -".json".length);
      const parsed = parseWorkflowDefinition(parsedJson, {
        source: root.source,
        path,
        fallbackName,
      });
      if (!parsed.definition) {
        problems.push(parsed.problem ?? `Invalid workflow ${path}`);
        continue;
      }

      if (claimed.has(parsed.definition.name)) {
        continue; // shadowed by a higher-precedence source — silent, claimed-set semantics
      }
      claimed.set(parsed.definition.name, parsed.definition);
    }
  }

  let workflows = [...claimed.values()];
  if (workflows.length > MAX_WORKFLOWS) {
    const dropped = workflows.length - MAX_WORKFLOWS;
    workflows = workflows.slice(0, MAX_WORKFLOWS);
    problems.push(
      `Workflow discovery: ${dropped} workflow(s) exceeded the cap of ${MAX_WORKFLOWS} and were dropped (lowest precedence first).`,
    );
  }

  return { workflows, problems };
}
