/**
 * Connection naming rule: a custom label wins, else the provider's display
 * name, else a readable provider id — never a raw `conn-<uuid>` id. Shared by
 * the provider tiles and the role route selects.
 */
import { describe, expect, it } from "vitest";
import { connectionDisplayName, disambiguateNames, providerDisplayName } from "./connection-name.js";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../shared/settings.js";

const CATALOG: CatalogSummary = [
  { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
  { id: "deepseek", name: "DeepSeek", authKind: "api_key", models: [] },
];

const CUSTOM: readonly CustomProviderRecord[] = [
  { id: "custom:lab", name: "Lab endpoint", baseUrl: "http://localhost:1234", kind: "openai-compatible", models: [] },
];

describe("providerDisplayName", () => {
  it("prefers the catalog name, then a custom endpoint's name, then the readable provider id", () => {
    expect(providerDisplayName({ providerId: "z-ai" }, CATALOG, CUSTOM)).toBe("Z.AI (GLM)");
    expect(providerDisplayName({ providerId: "custom:lab" }, CATALOG, CUSTOM)).toBe("Lab endpoint");
    // A custom endpoint with no record still reads as its key, never as a connection id.
    expect(providerDisplayName({ providerId: "custom:missing" }, CATALOG, CUSTOM)).toBe("missing");
    expect(providerDisplayName({ providerId: "unlisted" }, CATALOG, CUSTOM)).toBe("unlisted");
    expect(providerDisplayName({ providerId: "" }, [], undefined)).toBe("Custom provider");
  });
});

describe("connectionDisplayName", () => {
  it("prefers a custom label and otherwise the catalog name with a provider-local ordinal", () => {
    const all: ProviderConnection[] = [
      { id: "conn-1", providerId: "z-ai" },
      { id: "conn-2", providerId: "z-ai" },
      { id: "conn-3", providerId: "z-ai", label: "Work" },
    ];
    expect(connectionDisplayName(all[2]!, "Z.AI (GLM)", all)).toBe("Work");
    expect(connectionDisplayName(all[0]!, "Z.AI (GLM)", all)).toBe("Z.AI (GLM)");
    expect(connectionDisplayName(all[1]!, "Z.AI (GLM)", all)).toBe("Z.AI (GLM) 2");
  });
});

describe("disambiguateNames", () => {
  it("keeps distinct names and only numbers the collisions", () => {
    expect(disambiguateNames(["A", "B", "A", "A"])).toEqual(["A", "B", "A 2", "A 3"]);
    expect(disambiguateNames(["A 2", "A", "A"])).toEqual(["A 2", "A", "A 3"]);
  });
});
