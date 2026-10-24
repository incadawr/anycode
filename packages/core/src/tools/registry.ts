/** Tool registry: a Map<name, definition> with duplicate-name warning on register. */

import type { AnyToolDefinition, ToolDefinition, ToolMetadata } from "../types/tools.js";
import type { WebSearchInput, WebSearchOutput } from "./schemas.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { todoReadTool } from "./todo-read.js";
import { todoWriteTool } from "./todo-write.js";
import { webFetchTool } from "./web-fetch.js";
import { createAgentTool, type CreateAgentToolOptions } from "./agent.js";
import { skillTool } from "./skill.js";
import { workflowTool } from "./workflow.js";
import { archMapTool } from "./arch-map.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(tool: AnyToolDefinition, options?: { silentDuplicateWarning?: boolean }): void {
    if (this.tools.has(tool.metadata.name) && options?.silentDuplicateWarning !== true) {
      console.warn(`ToolRegistry: duplicate registration for tool "${tool.metadata.name}" (overwriting)`);
    }
    this.tools.set(tool.metadata.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  getMetadata(name: string): ToolMetadata | undefined {
    return this.tools.get(name)?.metadata;
  }

  all(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

export interface CreateDefaultToolRegistryOptions {
  /**
   * Forwarded verbatim to createAgentTool (TASK.102 CUT-S2 §2.1). Absent —
   * every existing call site (CLI, subagent runner, host test-harness) stays
   * byte-compatible with the restricted, inline-only Agent declaration.
   */
  agent?: CreateAgentToolOptions;
  /**
   * Register ArchMap (TASK.233 slice S1), the read-only TS/JS import-graph
   * scanner. OPT-IN (Taskana 4162): absent/false keeps it out of the registry,
   * so the default tool list and the system prompt's tool-discipline section
   * stay byte-identical to the pre-ArchMap baseline (e89e3d76) — its schema
   * would otherwise tax every session's prompt on every turn. Boot wirings
   * resolve the flag via `loadArchMapEnabled` (ANYCODE_ARCHMAP=1 env var, else
   * `tools.archMap: true` in ~/.anycode/settings.json; default off).
   */
  archMap?: boolean;
  /**
   * WebSearch tool instance to register after WebFetch. WebSearch is a
   * factory-built tool (createWebSearchTool) that exists only when a search
   * backend is configured at boot, so it is NOT part of the fixed built-in set;
   * passing the ready-made instance here keeps the registry byte-compatible
   * (same names, same order) at every call site that lacks a backend.
   */
  webSearch?: ToolDefinition<WebSearchInput, WebSearchOutput>;
}

/**
 * Builds a registry with the twelve built-ins: Read, Write, Edit, Bash, Grep
 * (Phase 0) + Glob, TodoRead, TodoWrite, WebFetch (Phase 1, design §2.14) +
 * Agent (Phase 3 slice 3.1, design §3.4) + Skill (Phase 3 slice 3.3, design
 * §2.7) + Workflow (Phase 3 slice 3.4, design §2.7). With opts.archMap the
 * thirteenth built-in joins (TASK.233 slice S1, opt-in per Taskana 4162).
 */
export function createDefaultToolRegistry(opts?: CreateDefaultToolRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(bashTool);
  registry.register(grepTool);
  registry.register(globTool);
  registry.register(todoReadTool);
  registry.register(todoWriteTool);
  registry.register(webFetchTool);
  if (opts?.webSearch) {
    registry.register(opts.webSearch);
  }
  registry.register(createAgentTool(opts?.agent));
  registry.register(skillTool);
  registry.register(workflowTool);
  if (opts?.archMap === true) {
    registry.register(archMapTool);
  }
  return registry;
}
