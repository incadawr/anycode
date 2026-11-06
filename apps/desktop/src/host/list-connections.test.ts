import { describe, expect, it } from "vitest";
import { resolveInlineRoute } from "../../../../packages/core/src/routing/inline-route.js";
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
    expect(result.output?.connections[0]).toMatchObject({ id: "conn-a", providerId: "z-ai", readiness: "ready", models: expect.arrayContaining([expect.objectContaining({ id: "extra", imageInput: true, contextWindow: 12345, default: false })]) });
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

it("reports each routable Go model's own declared context and levels", () => {
  const connection = { ...connectionFixture({ id: "opencode", connectionId: "c", model: "grok-4.7" }), models: ["grok-4.7", "hy4", "gemini-4-argon"] };
  const settings = { version: 2, provider: providerV2Multi("c", [connection]), tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } } as AnycodeSettings;
  const models = listConnectionTargets(settings, "c").connections[0]!.models;
  expect(models.find(model => model.id === "grok-4.7")?.contextWindow).toBe(500000);
  expect(models.find(model => model.id === "hy4")?.effortLevels).toEqual(["off", "high"]);
  expect(models.some(model => model.id === "gemini-4-argon")).toBe(false);
});


it("projects native current independently of the active API route before tool output", async () => {
  const connection = Object.assign(connectionFixture({ id: "custom:fixture", connectionId: "api", model: "api-model" }), { label: "x".repeat(20000), apiKey: "host-secret" });
  const settings = { version: 2, provider: providerV2Multi("api", [connection]) } as AnycodeSettings;
  for (const engine of ["codex", "claude"] as const) {
    const targets = listConnectionTargets(settings, "api", "api-model", false, { engine, model: "native-model", effort: "high", provenance: "unknown" });
    expect(targets.current).toEqual({ engine, routeKind: "native_cli", model: "native-model", effort: "high", provenance: "unknown" });
    expect(targets.connections[0]?.id).toBe("api");
    const result = await createListConnectionsTool(() => targets).handler({}, {} as ToolContext);
    expect(result.ok && result.output?.connections[0]?.label?.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(targets)).not.toContain("host-secret");
    const unknown = listConnectionTargets(settings, "api", "api-model", false, { engine, provenance: "unknown" });
    expect(unknown.current.connectionId).toBeUndefined();
    expect(unknown.current.model).toBeUndefined();
  }
});


it("keeps the full inventory routable beyond display caps", async () => {
  const models = Array.from({ length: 300 }, (_, i) => `model-${i}`);
  const connections = Array.from({ length: 70 }, (_, i) => ({
    ...connectionFixture({ id: "custom:fixture", connectionId: `c-${i}`, model: "model-280" }), models,
  }));
  const settings = { version: 2, provider: providerV2Multi("c-69", connections) } as AnycodeSettings;
  const targets = listConnectionTargets(settings, "c-69", "model-280");
  expect(resolveInlineRoute(targets, "c-0", "model-280").ok).toBe(false);
  expect(resolveInlineRoute(listConnectionTargets(settings, "c-0", "model-280"), "c-0", "model-280"))
    .toEqual({ ok: true, model: "model-280" });
  expect(resolveInlineRoute(targets, "c-69", "model-280")).toEqual({ ok: true, model: "model-280" });
  expect(resolveInlineRoute(targets, "c-69", "model-299")).toEqual({ ok: true, model: "model-299" });
  expect(targets.connections).toHaveLength(70);
  expect(targets.connections[69]?.models).toHaveLength(300);
  const result = await createListConnectionsTool(() => targets).handler({}, {} as ToolContext);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.output?.connections.length).toBeLessThanOrEqual(64);
  expect(result.output?.connections[0]?.models.length).toBeLessThanOrEqual(256);
  expect(result.output?.connections[0]?.models).toContainEqual(expect.objectContaining({ id: "model-280", default: true }));
});

it("normalizes contradictory current metadata before routing and tool output", async () => {
  const connection = connectionFixture({ id: "custom:fixture", connectionId: "c", model: "m" });
  const settings = { version: 2, provider: providerV2Multi("c", [connection]) } as AnycodeSettings;
  const targets = listConnectionTargets(settings, "c", "m", false, { engine: "core", routeKind: "native_cli" });
  expect(targets.current).toMatchObject({ engine: "core", routeKind: "api_connection", connectionId: "c", model: "m" });
  const result = await createListConnectionsTool(() => targets).handler({}, {} as ToolContext);
  expect(result.ok && result.output?.current).toEqual(targets.current);
});
