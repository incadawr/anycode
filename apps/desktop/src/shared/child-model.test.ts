import { expect, it } from "vitest";
import { assertChildModel, connectionChildModels, readAllowedChildModels } from "./child-model.js";
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
