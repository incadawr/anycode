import { describe, expect, it } from "vitest";
import { DENSITY_KEY, densityAttrValue, parseDensity } from "./density.js";

describe("parseDensity", () => {
  it("returns the compact default when the key is unset (F13)", () => {
    expect(parseDensity(null)).toBe("compact");
  });

  it("accepts the explicit compact value", () => {
    expect(parseDensity("compact")).toBe("compact");
  });

  it("honors the explicit comfortable opt-out", () => {
    expect(parseDensity("comfortable")).toBe("comfortable");
  });

  it("fails safe to compact on corrupt or foreign values", () => {
    expect(parseDensity("")).toBe("compact");
    expect(parseDensity("true")).toBe("compact");
    expect(parseDensity("COMFORTABLE")).toBe("compact");
    expect(parseDensity("dense")).toBe("compact");
  });
});

describe("densityAttrValue", () => {
  it("maps compact to the data-density attribute value", () => {
    expect(densityAttrValue("compact")).toBe("compact");
  });

  it("maps comfortable to null so the attribute is removed", () => {
    expect(densityAttrValue("comfortable")).toBeNull();
  });
});

describe("DENSITY_KEY", () => {
  it("follows the anycode.<domain>.<key> namespacing convention", () => {
    expect(DENSITY_KEY).toBe("anycode.appearance.density");
  });
});
