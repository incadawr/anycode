import { describe, expect, it } from "vitest";
import { createListConnectionsTool } from "@anycode/core";
import type { ToolContext } from "@anycode/core";
import { connectionFixture, providerV2Multi } from "../shared/provider-v2-fixture.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { listConnectionTargets } from "./list-connections.js";

describe("connection targets", () => {
  it("projects routing data without any secret fields", async () => {
    const connection = Object.assign(connectionFixture({ id: "z-ai", connectionId: "conn-a", model: "glm-5" }), {
      apiKey: "fake-api-key", token: "fake-token", headers: { authorization: "fake-header" },
      baseUrl: "https://fake-user:fake-password@example.com", proxyUrl: "https://proxy-user:proxy-password@example.com",
      models: [], modelCapabilities: { extra: { imageInput: true, contextWindow: 12345, effortLevels: ["high"] } },
      lastHealth: { status: "ready", at: "now", safeCode: "fake-health-secret" },
    });
    const settings = { version: 2, provider: providerV2Multi("conn-a", [connection]), tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } } as AnycodeSettings;
    const tool = createListConnectionsTool(() => listConnectionTargets(settings, "conn-a", "extra"));
    const result = await tool.handler({}, {} as ToolContext);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.output?.current).toEqual({ connectionId: "conn-a", model: "extra" });
    expect(result.output?.connections[0]).toMatchObject({ id: "conn-a", providerId: "z-ai", readiness: "ready", models: expect.arrayContaining([expect.objectContaining({ id: "extra", imageInput: true, contextWindow: 8192, default: false })]) });
    const text = JSON.stringify(result);
    for (const secret of ["fake-api-key", "fake-token", "fake-header", "fake-user", "fake-password", "proxy-user", "proxy-password", "fake-health-secret"]) expect(text).not.toContain(secret);
  });
});

it("reports runtime effective context and disabled reasoning", () => {
  const connection = { ...connectionFixture({ id: "xiaomi-mimo-api", connectionId: "c", model: "mimo-v2.6-pro" }), modelOverrides: { "mimo-v2.6-pro": { reasoningSupported: false, effortLevels: ["high" as const] } } };
  const settings = { version: 2, provider: providerV2Multi("c", [connection]), tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } } as AnycodeSettings;
  const model = listConnectionTargets(settings, "c").connections[0]!.models.find(item => item.id === "mimo-v2.6-pro")!;
  expect(model.contextWindow).toBe(300000);
  expect(model.effortLevels).toBeUndefined();
});

it("projects a legacy image-input pair folded into the per-model map", () => {
  // The host's ListConnections tool builds this projection from a raw
  // `parseSettings` read, without the loader's read-time migration, so the
  // projection has to fold the legacy pair itself.
  const connection = { ...connectionFixture({ id: "custom:fixture", connectionId: "c", model: "sighted" }), models: ["sighted", "blind"], imageInputOverride: "on" as const, imageInputModel: "sighted" };
  const settings = { version: 2, provider: providerV2Multi("c", [connection]), tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } } as AnycodeSettings;
  const models = listConnectionTargets(settings, "c").connections[0]!.models;
  expect(models.find(item => item.id === "sighted")?.imageInput).toBe(true);
  expect(models.find(item => item.id === "blind")?.imageInput).toBe(false);
});
