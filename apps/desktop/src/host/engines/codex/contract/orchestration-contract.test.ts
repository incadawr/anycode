import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/orchestration-feature-0.144.3.json", import.meta.url), "utf8"));
const recommended = JSON.parse(readFileSync(new URL("./fixtures/orchestration-feature-0.166.0.json", import.meta.url), "utf8"));
const reference = JSON.parse(readFileSync(new URL("./fixtures/schema-0.144.3/codex_app_server_protocol.schemas.json", import.meta.url), "utf8"));

describe("orchestration experimental feature contract", () => {
  it("pins dynamic tool declarations on start, while resume has no declared field", () => {
    expect(fixture.startDynamicTools.items.$ref).toBe("#/definitions/v2/DynamicToolSpec");
    expect(fixture.resumeDynamicTools).toBeNull();
    expect(fixture.dynamicToolSpec).toEqual(reference.definitions.v2.DynamicToolSpec);
    expect(fixture.dynamicToolCallParams).toEqual(reference.definitions.DynamicToolCallParams);
    expect(fixture.dynamicToolCallParams.required).toEqual(expect.arrayContaining(["threadId", "turnId", "callId", "tool", "arguments"]));
  });
  it("pins the recommended version's experimental surface independently", () => {
    expect(recommended.generatedFrom).toBe("codex-cli 0.166.0 --experimental");
    expect(recommended.startDynamicTools.items.$ref).toBe("#/definitions/v2/DynamicToolSpec");
    expect(recommended.resumeDynamicTools).toBeNull();
    expect(recommended.dynamicToolSpec.oneOf[0].required).toEqual(expect.arrayContaining(["name", "description", "inputSchema", "type"]));
    expect(recommended.dynamicToolCallParams.required).toEqual(expect.arrayContaining(["threadId", "turnId", "callId", "tool", "arguments"]));
    expect(Object.keys(recommended.configReadParams.properties)).toEqual(expect.arrayContaining(["cwd", "includeLayers"]));
  });
  it("pins the config/read request fields without claiming thread override visibility", () => {
    expect(fixture.configReadParams).toEqual(reference.definitions.v2.ConfigReadParams);
    expect(Object.keys(fixture.configReadParams.properties)).toEqual(expect.arrayContaining(["cwd", "includeLayers"]));
  });
});
