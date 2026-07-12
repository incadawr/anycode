/**
 * Converts registry entries into provider-agnostic ToolDeclaration[] (design
 * §2.2): zod schema -> z.toJSONSchema(), no SDK types involved. The provider
 * layer (provider/sdk-mapping.ts toSdkTools) wraps these into SDK shapes; no
 * execute body ever exists — the model only proposes calls.
 */

import { z } from "zod";
import type { ToolDeclaration } from "../types/tools.js";
import type { ToolRegistry } from "./registry.js";

export function toToolDeclarations(registry: ToolRegistry): ToolDeclaration[] {
  return registry.all().map((definition) => ({
    name: definition.metadata.name,
    description: definition.metadata.description,
    // MCP tools arrive as JSON Schema (rawInputJsonSchema) and are used verbatim;
    // native tools have no raw schema, so their zod inputSchema is converted.
    inputJsonSchema:
      definition.rawInputJsonSchema ??
      (z.toJSONSchema(definition.inputSchema) as Record<string, unknown>),
  }));
}
