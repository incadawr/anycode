import { expect, it } from "vitest";
import type { ToolContext } from "../types/tools.js";
import { createListConnectionsTool } from "./list-connections.js";

it("drops unrecognized fields at every output level", async () => {
  const data = {
    current: { connectionId: "conn", model: "model", token: "secret-current" },
    connections: [{ id: "conn", providerId: "provider", readiness: "unknown", apiKey: "secret-key", headers: { authorization: "secret-header" }, models: [{ id: "model", default: true, token: "secret-model" }] }],
  };
  const result = await createListConnectionsTool(() => data).handler({}, {} as ToolContext);
  const serialized = JSON.stringify(result);
  for (const secret of ["secret-current", "secret-key", "secret-header", "secret-model"]) expect(serialized).not.toContain(secret);
  expect(result.ok).toBe(true);
});
