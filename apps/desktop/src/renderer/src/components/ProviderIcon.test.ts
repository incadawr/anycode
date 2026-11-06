import { describe, expect, it } from "vitest";
import { catalogProviderIds } from "@anycode/core/catalog";
import { providerIconName } from "./ProviderIcon.js";

describe("provider icons", () => {
  it("maps every catalog provider to its icon, with a fallback for custom", () => {
    for (const id of catalogProviderIds()) {
      expect(providerIconName(id), id).toBe(id === "custom" ? "fallback" : ({ "z-ai": "zai", "minimax-cn": "minimax", "opencode-openai": "opencode", "xiaomi-mimo-api": "xiaomimimo", "xiaomi-mimo-sgp": "xiaomimimo", "xiaomi-mimo-cn": "xiaomimimo", "xiaomi-mimo-ams": "xiaomimimo" } as Record<string, string>)[id] ?? id);
    }
  });
  it("uses the fallback for unknown providers", () => {
    expect(providerIconName("unknown")).toBe("fallback");
    expect(providerIconName("toString")).toBe("fallback");
  });
});
