import { describe, expect, it } from "vitest";
import { formatConsoleArguments } from "./console-format.js";

describe("console argument formatting", () => {
  it("formats primitives, object previews and arrays within the limit", () => {
    expect(formatConsoleArguments([
      { type: "string", value: "[net]" },
      { type: "object", preview: { properties: [{ name: "status", type: "number", value: "200" }, { name: "url", type: "string", value: "/api" }] } },
      { type: "object", subtype: "array", preview: { properties: [{ name: "0", type: "number", value: "1" }], overflow: true } },
      { type: "number", unserializableValue: "NaN" },
    ])).toBe('[net] {status: 200, url: "/api"} [1, …] NaN');
    expect(formatConsoleArguments([{ type: "string", value: "x".repeat(1000) }])).toHaveLength(500);
  });
  it("preserves descriptions and collection entries and handles unusual values", () => {
    expect(formatConsoleArguments([
      { type: "object", subtype: "date", description: "2026-01-01", preview: { properties: [] } },
      { type: "object", subtype: "map", description: "Map(1)", preview: { entries: [{ key: { type: "string", description: "key" }, value: { type: "number", description: "2" } }] } },
      { type: "object", subtype: "set", description: "Set(1)", preview: { entries: [{ value: { type: "number", description: "3" } }] } },
      { type: "object", subtype: "error", description: "Error: broken", preview: { properties: [{ name: "code", type: "number", value: "1" }] } },
    ])).toBe('2026-01-01 Map(1) {"key" => 2} Set(1) {3} Error: broken');
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => formatConsoleArguments([{ value: circular }, { value: 1n }, { value: Symbol("s") }, { type: "undefined" }])).not.toThrow();
  });
});
