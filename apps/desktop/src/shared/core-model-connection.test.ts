/**
 * Taskana 4888: unit tests for the `create_session {engine:"core", model}`
 * connection resolver — the pure policy that replaced the silent fallback to
 * the active connection. Discriminates every selector form (id, label,
 * `<providerId>/<model>`, bare model id) plus BOTH refusal shapes and the
 * model-override/no-override split.
 */
import { describe, expect, it } from "vitest";
import type { AnycodeSettings, ProviderConnection } from "./settings.js";
import { resolveCoreConnectionForModel } from "./core-model-connection.js";
import { connectionFixture, providerV2Multi } from "./provider-v2-fixture.js";

function settingsWith(activeConnectionId: string | undefined, connections: ProviderConnection[]): AnycodeSettings {
  return {
    version: 2,
    provider: providerV2Multi(activeConnectionId, connections),
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

const deepseek = connectionFixture({ id: "deepseek", connectionId: "conn-deepseek", model: "deepseek-flash" });
const zai = connectionFixture({ id: "zai", connectionId: "conn-zai", model: "glm-5" });

describe("resolveCoreConnectionForModel (Taskana 4888)", () => {
  it("selects a connection by its exact id, with no model override", () => {
    const settings = settingsWith("conn-deepseek", [deepseek, zai]);

    expect(resolveCoreConnectionForModel(settings, "conn-zai")).toEqual({ ok: true, connectionId: "conn-zai" });
  });

  it("selects a connection by its exact label", () => {
    const labelled = connectionFixture({ id: "zai", connectionId: "conn-labelled", label: "Work GLM", model: "glm-5" });
    const settings = settingsWith(undefined, [deepseek, labelled]);

    expect(resolveCoreConnectionForModel(settings, "Work GLM")).toEqual({ ok: true, connectionId: "conn-labelled" });
  });

  it("resolves <providerId>/<model> to that provider's connection and carries the model as an override", () => {
    const settings = settingsWith(undefined, [deepseek, zai]);

    // The model is not even in the connection's declared list — the explicit
    // provider prefix is what makes it unambiguous.
    expect(resolveCoreConnectionForModel(settings, "deepseek/deepseek-v4-pro")).toEqual({
      ok: true,
      connectionId: "conn-deepseek",
      model: "deepseek-v4-pro",
    });
  });

  it("selects a connection by a bare model id and carries it as an override when it is not the default", () => {
    const multi = connectionFixture({ id: "deepseek", connectionId: "conn-multi", model: "deepseek-flash" });
    multi.models = ["deepseek-flash", "deepseek-v4-pro"];
    const settings = settingsWith(undefined, [multi]);

    expect(resolveCoreConnectionForModel(settings, "deepseek-v4-pro")).toEqual({
      ok: true,
      connectionId: "conn-multi",
      model: "deepseek-v4-pro",
    });
  });

  it("does not stamp an override when the bare model id is the connection's own default", () => {
    const settings = settingsWith(undefined, [deepseek, zai]);

    expect(resolveCoreConnectionForModel(settings, "glm-5")).toEqual({ ok: true, connectionId: "conn-zai" });
  });

  it("ignores the active connection entirely: the requested model wins even when another connection is active", () => {
    const settings = settingsWith("conn-zai", [deepseek, zai]);

    expect(resolveCoreConnectionForModel(settings, "deepseek-flash")).toEqual({
      ok: true,
      connectionId: "conn-deepseek",
    });
  });

  it("refuses as ambiguous when a bare model id is offered by two connections, listing both candidates", () => {
    const first = connectionFixture({ id: "deepseek", connectionId: "conn-a", model: "deepseek-flash" });
    const second = connectionFixture({ id: "deepseek", connectionId: "conn-b", model: "deepseek-flash" });
    const settings = settingsWith("conn-a", [first, second]);

    const resolved = resolveCoreConnectionForModel(settings, "deepseek-flash");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toBe("ambiguous");
    expect(resolved.detail).toContain('"deepseek-flash"');
    expect(resolved.detail).toContain("conn-a");
    expect(resolved.detail).toContain("conn-b");
  });

  it("refuses an unknown value instead of falling back to the active connection, listing every candidate", () => {
    const settings = settingsWith("conn-zai", [deepseek, zai]);

    const resolved = resolveCoreConnectionForModel(settings, "no-such-model");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toBe("unknown");
    expect(resolved.detail).toContain('"no-such-model"');
    expect(resolved.detail).toContain("conn-deepseek");
    expect(resolved.detail).toContain("conn-zai");
    // The candidate text names the provider and model so a caller can retry.
    expect(resolved.detail).toContain("deepseek: deepseek-flash");
  });

  it("says so plainly when there are no connections at all", () => {
    const resolved = resolveCoreConnectionForModel(settingsWith(undefined, []), "deepseek-flash");

    expect(resolved).toEqual({
      ok: false,
      reason: "unknown",
      detail: 'no provider connections are configured, so "deepseek-flash" cannot be resolved',
    });
  });

  it("matches exactly: a different case is unknown, never a fuzzy hit", () => {
    const resolved = resolveCoreConnectionForModel(settingsWith(undefined, [deepseek]), "DeepSeek-Flash");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toBe("unknown");
  });

  it("refuses a blank value as unknown even though the schema rejects it first", () => {
    const resolved = resolveCoreConnectionForModel(settingsWith(undefined, [deepseek]), "   ");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.reason).toBe("unknown");
  });

  it("caps the model list of one candidate and counts the rest, so a fetched /v1/models list stays readable", () => {
    const many = connectionFixture({ id: "openai", connectionId: "conn-many", model: "m-0" });
    many.models = Array.from({ length: 20 }, (_, index) => `m-${index}`);
    const resolved = resolveCoreConnectionForModel(settingsWith(undefined, [many]), "nope");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.detail).toContain("+14 more");
  });
});
