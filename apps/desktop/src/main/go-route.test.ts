import { expect, it } from "vitest";
import { automaticGoRoute } from "./go-route.js";
import { providerV2 } from "../shared/provider-v2-fixture.js";
const connection = providerV2({ id: "opencode", model: "glm-5.3" }).connections[0]!;
it("honors a connection snapshot, including refusals, before static fallback", () => {
  expect(automaticGoRoute(connection, {})?.kind).toBe("route");
  const modelRoutes = { version: 1 as const, fetchedAt: "now", models: { "glm-5.3": { kind: "refusal" as const, reason: "unsupported-model" as const } } };
  expect(automaticGoRoute({ ...connection, modelRoutes }, {})).toEqual({ kind: "refusal", reason: "unsupported-model" });
  expect(automaticGoRoute({ ...connection, modelRoutes }, { ANYCODE_BASE_URL: "https://manual.test" })).toBeUndefined();
});
