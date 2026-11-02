import { resolveCoreConnectionForModel } from "./core-model-connection.js";
import { connectionFixture, providerV2Multi } from "./provider-v2-fixture.js";
import type { AnycodeSettings } from "./settings.js";
import { expect, it } from "vitest";
import { assertChildModel, connectionChildModels, connectionRoutingSettings, readAllowedChildModels } from "./child-model.js";
it("never treats an alias or another provider's model as a valid parent-connection override", () => {
  expect(() => assertChildModel("opus", ["glm-5.3", "glm-5.3-flash"])).toThrow("matching provider/connection");
  expect(() => assertChildModel("claude-opus-5-5", ["glm-5.3"])).toThrow();
  expect(() => assertChildModel("glm-5.3-flash", ["glm-5.3-flash"])).not.toThrow();
});
it("preserves an explicitly configured custom model and fails closed on malformed metadata", () => {
  expect(readAllowedChildModels(undefined, "my-local-model")).toEqual(["my-local-model"]);
  expect(readAllowedChildModels('[1,"opus"]', "glm-5.3")).toEqual(["glm-5.3"]);
});

it("allows a manually selected connection model in both child-model paths", () => {
  const allowed = connectionChildModels({ id: "c", providerId: "custom:test", model: "default", visibleModels: ["manual"] }, [], []);
  expect(allowed).toEqual(["manual", "default"]);
  expect(() => assertChildModel("manual", allowed)).not.toThrow();
  expect(readAllowedChildModels(JSON.stringify(allowed), "default")).toContain("manual");
});

it("routes catalog and manually visible models through the discovery inventory", () => {
  const connection = { ...connectionFixture({ id: "anthropic", connectionId: "c", model: "claude-opus-5-5" }), visibleModels: ["manual"] };
  const settings = { provider: providerV2Multi("c", [connection]) } as AnycodeSettings;
  const inventory = connectionRoutingSettings(settings);
  expect(resolveCoreConnectionForModel(inventory, "claude-sonnet-5-5")).toEqual({ ok: true, connectionId: "c", model: "claude-sonnet-5-5" });
  expect(resolveCoreConnectionForModel(inventory, "manual")).toEqual({ ok: true, connectionId: "c", model: "manual" });
});
