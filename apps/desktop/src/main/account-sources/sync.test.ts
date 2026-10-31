import { describe, expect, it } from "vitest";
import { accountCatalogSchema } from "@anycode/core/plugins-admin";
import { markOverride, reconcileCatalog } from "./sync.js";

const custom = { id: "corp", name: "Corp", baseUrl: "https://gateway.example.com/v1", kind: "openai-compatible" as const, models: ["manual"] };
const connection = { id: "conn-1", providerId: "custom:corp", model: "manual", modelOverrides: { paid: { contextWindowTokens: 32000 } } };
function catalog(models: unknown[]) { return accountCatalogSchema.parse({ schemaVersion: "anycode.account-catalog.v1", accountId: "employee", revision: "1", complete: true, models }); }

describe("catalog ownership reconciliation", () => {
  it("retains connection identity, manual models and overrides, and is idempotent", () => {
    const data = catalog([{ id: "free", billing: "free" }, { id: "paid", billing: "metered", capabilities: { contextWindowTokens: 64000 } }]);
    const first = reconcileCatalog(custom, connection, {}, data);
    expect(first.custom.models).toEqual(["manual", "free", "paid"]);
    expect(first.connection.id).toBe(connection.id);
    expect(first.connection.model).toBe("manual");
    expect(first.connection.modelOverrides?.paid?.contextWindowTokens).toBe(32000);
    expect(first.connection.modelOverrides?.free?.pricing?.input).toBe(0);
    expect(first.connection.modelOverrides?.paid?.pricing).toBeUndefined();
    expect(reconcileCatalog(first.custom, first.connection, first.ownership, data)).toEqual(first);
  });
  it("keeps a user-deleted model absent and removes only owned models", () => {
    const first = reconcileCatalog(custom, connection, {}, catalog([{ id: "a", billing: "free" }, { id: "b", billing: "free" }]));
    first.custom.models = first.custom.models.filter((id) => id !== "a");
    const next = reconcileCatalog(first.custom, first.connection, first.ownership, catalog([{ id: "a", billing: "free" }]));
    expect(next.custom.models).toEqual(["manual"]);
    expect(next.ownership.a?.model?.overridden).toBe(true);
  });
  it("preserves explicitly cleared or unchanged user fields", () => {
    const first = reconcileCatalog(custom, connection, {}, catalog([{ id: "free", billing: "free" }]));
    markOverride(first.ownership, "free", "pricing");
    markOverride(first.ownership, "free", "contextWindowTokens");
    const next = reconcileCatalog(first.custom, first.connection, first.ownership, catalog([{ id: "free", billing: "metered", ratesMicrosPerMillionTokens: { input: "1000000", cachedInput: "1000000", output: "1000000" }, capabilities: { contextWindowTokens: 64000 } }]));
    expect(next.connection.modelOverrides?.free?.pricing?.input).toBe(0);
    expect(next.connection.modelOverrides?.free?.contextWindowTokens).toBeUndefined();
  });
  it("reimports a server-removed model if it returns", () => {
    const entry = { id: "source-model", billing: "free" };
    const first = reconcileCatalog(custom, connection, {}, catalog([entry]));
    const removed = reconcileCatalog(first.custom, first.connection, first.ownership, catalog([]));
    expect(removed.custom.models).not.toContain(entry.id);
    const returned = reconcileCatalog(removed.custom, removed.connection, removed.ownership, catalog([entry]));
    expect(returned.custom.models).toContain(entry.id);
    expect(returned.connection.modelOverrides?.[entry.id]?.pricing?.input).toBe(0);
  });
});
