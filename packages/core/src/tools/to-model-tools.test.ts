import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { AnyToolDefinition } from "../types/tools.js";
import { createDefaultToolRegistry, ToolRegistry } from "./registry.js";
import { toToolDeclarations } from "./to-model-tools.js";

const ALL_TOOLS = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "Skill",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "Workflow",
  "Write",
];

describe("toToolDeclarations", () => {
  it("produces one declaration per registered tool with name/description/JSON Schema", () => {
    const registry = createDefaultToolRegistry();
    const declarations = toToolDeclarations(registry);

    expect(declarations.map((d) => d.name).sort()).toEqual(ALL_TOOLS);

    for (const declaration of declarations) {
      expect(declaration.description).toEqual(
        registry.getMetadata(declaration.name)?.description,
      );
      expect(declaration.inputJsonSchema, `${declaration.name} should carry a JSON Schema`).toBeDefined();
      expect(declaration.inputJsonSchema.type).toBe("object");
      // Provider-agnostic contract: no SDK wrapper, no execute body.
      expect("execute" in declaration).toBe(false);
    }
  });

  it("carries the JSON Schema shape derived from the tool's zod schema", () => {
    const registry = createDefaultToolRegistry();
    const declarations = toToolDeclarations(registry);

    const read = declarations.find((d) => d.name === "Read");
    const properties = read?.inputJsonSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("file_path");

    const webFetch = declarations.find((d) => d.name === "WebFetch");
    const webFetchProps = webFetch?.inputJsonSchema.properties as Record<string, unknown>;
    expect(webFetchProps).toHaveProperty("url");
    expect(webFetchProps).toHaveProperty("prompt");
  });


  // added in 3.2.1 must leave the native tools BYTE-IDENTICAL — none of them
  // set rawInputJsonSchema, so each declaration's inputJsonSchema must deep-equal
  // the direct z.toJSONSchema(inputSchema) it produced before the slice. Slice
  // 3.3 adds the eleventh native tool (Skill); slice 3.4 adds the twelfth
  // (Workflow) — both zod-authored.
  it("the native tools have no rawInputJsonSchema and stay byte-identical to z.toJSONSchema", () => {
    const registry = createDefaultToolRegistry();
    const declarations = toToolDeclarations(registry);

    expect(declarations).toHaveLength(ALL_TOOLS.length);
    for (const definition of registry.all()) {
      expect(definition.rawInputJsonSchema, `${definition.metadata.name} must not carry a raw schema`).toBeUndefined();
      const declaration = declarations.find((d) => d.name === definition.metadata.name);
      expect(declaration?.inputJsonSchema).toEqual(z.toJSONSchema(definition.inputSchema));
    }
  });

  // Slice 3.2 (design §3.1): when a tool carries rawInputJsonSchema (MCP tools
  // arrive as JSON Schema, not zod), it is used verbatim — the permissive zod
  // inputSchema slot is NOT converted.
  it("prefers rawInputJsonSchema verbatim over z.toJSONSchema when present", () => {
    const rawSchema = {
      type: "object",
      properties: { query: { type: "string", description: "server-authored" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: true,
    };
    const mcpLikeTool = {
      metadata: {
        name: "mcp__srv__search",
        description: "bridged tool",
        readOnly: false,
        destructive: true,
        concurrentSafe: false,
        riskLevel: "high",
        sideEffectScope: "process",
        needsApproval: true,
        timeoutMs: 120_000,
      },
      // The zod slot is a permissive passthrough; its conversion must be ignored.
      inputSchema: z.looseObject({}),
      rawInputJsonSchema: rawSchema,
      handler: async () => ({ ok: true }),
    } as unknown as AnyToolDefinition;

    const registry = new ToolRegistry();
    registry.register(mcpLikeTool);
    const [declaration] = toToolDeclarations(registry);

    expect(declaration?.name).toBe("mcp__srv__search");
    expect(declaration?.inputJsonSchema).toEqual(rawSchema);
    // Proof it is verbatim, not a zod conversion of the loose passthrough:
    expect(declaration?.inputJsonSchema).not.toEqual(z.toJSONSchema(z.looseObject({})));
  });
});
