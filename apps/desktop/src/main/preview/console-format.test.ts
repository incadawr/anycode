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
});
