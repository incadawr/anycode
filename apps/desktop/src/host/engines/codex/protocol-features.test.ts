import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeCodexProtocolFeatures } from "./protocol-features.js";
const reference = () => JSON.parse(readFileSync(new URL("./contract/fixtures/schema-0.144.3/codex_app_server_protocol.schemas.json", import.meta.url), "utf8"));
describe("Codex protocol features", () => {
  it("enables manual compact from the reference schema registry", () => {
    expect(decodeCodexProtocolFeatures(reference())).toEqual({ manualCompact: true });
  });
  it.each(["remove", "rename"])("disables manual compact when its request is removed or renamed: %s", mode => {
    const s = reference();
    const entries = s.definitions.ClientRequest.oneOf;
    const entry = entries.find((v: any) => v.properties.method.enum.includes("thread/compact/start"));
    if (mode === "rename") entry.properties.method.enum = ["thread/compact/other"];
    else entries.splice(entries.indexOf(entry), 1);
    expect(decodeCodexProtocolFeatures(s)).toEqual({ manualCompact: false });
  });
  it.each(["threadId", "required", "turn/started", "turn/completed", "item/started", "item/completed", "item", "ref", "response", "status"])("disables manual compact for incompatible parameters or missing lifecycle shapes: %s", mode => {
    const s = reference();
    if (mode === "threadId") s.definitions.v2.ThreadCompactStartParams.properties.threadId.type = "number";
    else if (mode === "required") s.definitions.v2.ThreadCompactStartParams.required.push("newRequired");
    else if (mode === "status") s.definitions.v2.TurnStatus.enum = ["unknown"];
    else if (mode === "response") s.definitions.v2.ThreadCompactStartResponse.type = "null";
    else if (mode === "item") s.definitions.v2.ThreadItem.oneOf = s.definitions.v2.ThreadItem.oneOf.filter((v: any) => !v.properties.type.enum.includes("contextCompaction"));
    else if (mode === "ref") s.definitions.v2.ItemCompletedNotification.properties.item.$ref = "#/missing";
    else s.definitions.ServerNotification.oneOf = s.definitions.ServerNotification.oneOf.filter((v: any) => !v.properties.method.enum.includes(mode));
    expect(decodeCodexProtocolFeatures(s)).toEqual({ manualCompact: false });
  });
  it("accepts additive optional schema changes and rejects malformed input", () => {
    const s = reference();
    s.definitions.v2.ThreadCompactStartParams.properties.optional = { type: "boolean" };
    s.definitions.ClientRequest.oneOf.push({ properties: { method: { enum: ["unrelated"] }, params: { type: "null" } } });
    expect(decodeCodexProtocolFeatures(s).manualCompact).toBe(true);
    for (const invalid of [null, [], {}, { definitions: { ClientRequest: {} } }]) expect(decodeCodexProtocolFeatures(invalid).manualCompact).toBe(false);
  });
});
