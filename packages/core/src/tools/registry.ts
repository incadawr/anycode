/** Tool registry: a Map<name, definition> with duplicate-name warning on register. */

import type { AnyToolDefinition, ToolMetadata } from "../types/tools.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { todoReadTool } from "./todo-read.js";
import { todoWriteTool } from "./todo-write.js";
import { webFetchTool } from "./web-fetch.js";
import { agentTool } from "./agent.js";
import { skillTool } from "./skill.js";
import { workflowTool } from "./workflow.js";

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

/**
 * Builds a registry with the twelve built-ins: Read, Write, Edit, Bash, Grep
 * (Phase 0) + Glob, TodoRead, TodoWrite, WebFetch (Phase 1, design §2.14) +
 * Agent (Phase 3 slice 3.1, design §3.4) + Skill (Phase 3 slice 3.3, design
 * §2.7) + Workflow (Phase 3 slice 3.4, design §2.7).
 */
export function createDefaultToolRegistry(): ToolRegistry {
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
  registry.register(agentTool);
  registry.register(skillTool);
  registry.register(workflowTool);
  return registry;
}
