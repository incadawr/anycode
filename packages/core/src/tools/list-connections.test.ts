import { expect, it } from "vitest";
import type { ToolContext } from "../types/tools.js";
import { createListConnectionsTool, projectConnectionTargets, type ConnectionTargets } from "./list-connections.js";

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


it("preserves native route metadata without claiming an API connection", async () => {
  const data = { current: { engine: "codex", routeKind: "native_cli", connectionId: "active-api", model: "native-model", effort: "high", provenance: "selected" }, connections: [] };
  const result = await createListConnectionsTool(() => data as ConnectionTargets).handler({}, {} as ToolContext);
  expect(result.ok && result.output?.current).toEqual({ engine: "codex", routeKind: "native_cli", model: "native-model", effort: "high", provenance: "selected" });
});

it("bounds display data and rejects nested values in allowed fields", async () => {
  const data = { current: { model: { token: "nested-secret" } }, connections: [{ id: "c", providerId: "p", label: "x".repeat(20000), readiness: "raw-error-secret", models: [{ id: "m", default: true, effortLevels: [{ token: "nested-secret" }], imageInput: undefined }] }] };
  const result = await createListConnectionsTool(() => data as unknown as ConnectionTargets).handler({}, {} as ToolContext);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.output?.connections[0]?.label?.length).toBeLessThanOrEqual(256);
  expect(result.output?.connections[0]?.readiness).toBe("unknown");
  expect(result.output?.connections[0]?.models[0]?.imageInput).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("nested-secret");
  expect(JSON.stringify(result)).not.toContain("raw-error-secret");
  const error = await createListConnectionsTool(() => { throw { message: "error-secret", connection: { apiKey: "key-secret" } }; }).handler({}, {} as ToolContext);
  expect(error).toEqual({ ok: false, error: "ListConnections: connection information is unavailable." });
});


it("exports an idempotent projector with a total UTF-8 output budget", async () => {
  const model = { id: "模型".repeat(600), default: false, effortLevels: ["high"], contextWindow: Infinity };
  const connection = { id: "c", label: "\u202e" + "界".repeat(500), providerId: "p", readiness: "unknown", models: Array.from({ length: 300 }, () => model) };
  const data = { current: { engine: "core", routeKind: "api_connection", connectionId: "c", model: "m", provenance: "applied" }, connections: Array.from({ length: 100 }, () => connection) } as ConnectionTargets;
  const projected = projectConnectionTargets(data);
  expect(projectConnectionTargets(projected)).toEqual(projected);
  expect(projected.current).toEqual(data.current);
  expect(projected.connections[0]?.label).not.toContain("\u202e");
  expect(projected.connections[0]?.models[0]?.contextWindow).toBeUndefined();
  expect(projected.connections[0]?.models[0]?.imageInput).toBeUndefined();
  const result = await createListConnectionsTool(() => data).handler({}, {} as ToolContext);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(100000);
});


it.each([
  ["core", "native_cli", "api_connection", "c"],
  ["claude", "api_connection", "native_cli", undefined],
  ["codex", "api_connection", "native_cli", undefined],
  [undefined, "native_cli", "native_cli", undefined],
] as const)("normalizes route kind for engine %s", (engine, routeKind, expectedKind, connectionId) => {
  const projected = projectConnectionTargets({ current: { engine, routeKind, connectionId: "c" }, connections: [] });
  expect(projected.current).toEqual({ engine, routeKind: expectedKind, connectionId });
});

it("retains the default model beyond the count and UTF-8 budgets", () => {
  const models = Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}-${"界".repeat(500)}`, default: i === 280 }));
  const data = { current: {}, connections: [{ id: "c", providerId: "p", readiness: "unknown", models }] };
  const projected = projectConnectionTargets(data);
  expect(projected.connections[0]?.models.length).toBeLessThan(256);
  expect(projected.connections[0]?.models.find(m => m.default)?.id).toBe(models[280]!.id.slice(0, 512));
  expect(projectConnectionTargets(projected)).toEqual(projected);
});
