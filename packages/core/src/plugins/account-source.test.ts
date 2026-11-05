import { describe, expect, it } from "vitest";
import { capabilities, pluginManifestSchema } from "./manifest.js";
import { accountBudgetSchema, accountCatalogSchema, accountSourceHash } from "./account-source.js";

const source = {
  id: "cluster", protocol: "anycode.account.v1", displayName: "Cluster",
  gateway: { name: "Gateway", baseUrl: "https://gateway.example.com/v1", kind: "openai-compatible" },
  apiBaseUrl: "https://gateway.example.com/account/",
};
const manifest = (accountSources: unknown) => ({ name: "company", accountSources });

describe("account source contract", () => {
  it("keeps old manifests unchanged and rejects cross-origin or unsafe addresses", () => {
    expect(pluginManifestSchema.parse({ name: "legacy" })).not.toHaveProperty("accountSources");
    expect(pluginManifestSchema.safeParse(manifest([source])).success).toBe(true);
    expect(capabilities(pluginManifestSchema.parse(manifest([source]))).accountSources).toEqual(["cluster"]);
    for (const apiBaseUrl of ["http://gateway.example.com/", "https://other.example.com/", "https://user@gateway.example.com/", "invalid", "https://gateway.example.com/?x=1"]) {
      expect(pluginManifestSchema.safeParse(manifest([{ ...source, apiBaseUrl }])).success).toBe(false);
    }
    expect(pluginManifestSchema.safeParse(manifest([source, source])).success).toBe(false);
    expect(pluginManifestSchema.safeParse(manifest([{ ...source, gateway: { ...source.gateway, baseUrl: "http://127.0.0.1:1234/v1" }, apiBaseUrl: "http://127.0.0.1:1234/account/" }])).success).toBe(true);
  });
  it("hashes authorization-relevant changes but not labels", () => {
    const parsed = pluginManifestSchema.parse(manifest([source])).accountSources![0]!;
    expect(accountSourceHash(parsed)).toBe(accountSourceHash({ ...parsed, displayName: "New" }));
    expect(accountSourceHash(parsed)).not.toBe(accountSourceHash({ ...parsed, apiBaseUrl: "https://gateway.example.com/other/" }));
  });
  it("accepts only complete catalogs with unique model IDs", () => {
    const catalog = { schemaVersion: "anycode.account-catalog.v1", accountId: "a", revision: "1", complete: true, models: [{ id: "m", billing: "free" }] };
    expect(accountCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(accountCatalogSchema.safeParse({ ...catalog, complete: false }).success).toBe(false);
    expect(accountCatalogSchema.safeParse({ ...catalog, models: [...catalog.models, ...catalog.models] }).success).toBe(false);
  });
  it("preserves large exact amounts and rejects invalid or duplicate windows", () => {
    const window = { kind: "day", limit: "100000000000000000000", spent: "0", remaining: "0", resetsAt: "2026-11-01T00:00:00Z" };
    const budget = { schemaVersion: "anycode.account-budget.v1", accountId: "a", budgetId: "b", currency: "USD", scale: 6, observedAt: "2026-10-31T12:00:00Z", windows: [window] };
    expect(accountBudgetSchema.parse(budget).windows[0]?.limit).toBe(window.limit);
    expect(accountBudgetSchema.safeParse({ ...budget, windows: [window, window] }).success).toBe(false);
    expect(accountBudgetSchema.safeParse({ ...budget, windows: [{ ...window, spent: "-1" }] }).success).toBe(false);
  });
});
