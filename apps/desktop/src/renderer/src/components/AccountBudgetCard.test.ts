import { expect, it } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import { eligibleAccountConnections } from "./AccountBudgetCard.js";

it("offers only dedicated connections that can be bound", () => {
  const settings = cloneDefaults();
  settings.provider.custom = [{ id: "custom:corp", name: "Corp", baseUrl: "https://example.com/v1", kind: "openai-compatible", models: [] }];
  settings.provider.connections = [{ id: "one", providerId: "custom:corp" }];
  const candidate = { key: { plugin: "corp", source: "main" }, displayName: "Corp", gatewayName: "Corp", gatewayBaseUrl: "https://example.com/v1", gatewayKind: "openai-compatible" as const, apiBaseUrl: "https://example.com/api/" };
  expect(eligibleAccountConnections(settings, candidate)).toHaveLength(1);
  settings.provider.connections.push({ id: "two", providerId: "custom:corp" });
  expect(eligibleAccountConnections(settings, candidate)).toEqual([]);
  settings.provider.connections.pop();
  settings.plugins = { accountSources: [{ plugin: "other", source: "main", descriptorHash: "a".repeat(64), connectionId: "one", accountId: "a", ownership: {} }] };
  expect(eligibleAccountConnections(settings, candidate)).toEqual([]);
});

it("explains every preview failure without exposing its code", async () => {
  const { previewFailureText } = await import("./AccountBudgetCard.js");
  for (const code of ["not_found", "connection_invalid", "stale", "invalid", "auth_required", "access_denied", "timeout", "unavailable", "expired"] as const) {
    const message = previewFailureText(code);
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toBe(code);
  }
});

it("formats free, metered and unknown catalog prices consistently", async () => {
  const { accountModelPrice } = await import("./account-source-pricing.js");
  expect(accountModelPrice({ id: "a", billing: "free" })).toBe("Free");
  expect(accountModelPrice({ id: "b", billing: "metered", ratesMicrosPerMillionTokens: { input: "1000000", output: "2500000" } })).toBe("$1 input / $2.5 output per 1M");
  expect(accountModelPrice({ id: "c", billing: "metered" })).toBe("Price unknown");
});
