import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isFreeChatGoModel } from "./lib/opencode-go-live-safety.mjs";

const fixture = JSON.parse(readFileSync(new URL("../apps/desktop/src/main/__fixtures__/opencode-go-models.json", import.meta.url), "utf8"));
const model = (id: string) => structuredClone(fixture.data.find((row: { id: string }) => row.id === id));

describe("free live probe guard", () => {
  it("accepts only the declared free chat models", () => {
    expect(isFreeChatGoModel(model("beam-free"))).toBe(true);
    expect(isFreeChatGoModel(model("iceman-contributor-free"))).toBe(true);
    expect(isFreeChatGoModel(model("grok-4.7"))).toBe(false);
  });
  it("refuses missing rates, conditions, a charged cache or another door", () => {
    for (const mutate of [
      (row: any) => { delete row.cost.text.input.cache.read; },
      (row: any) => { row.cost.text.input.cache.write = 1; },
      (row: any) => { row.cost.text.input.overrides = {}; },
      (row: any) => { row.cost.multipliers = []; },
      (row: any) => { row.cost.text.condition = "unknown"; },
      (row: any) => { row.api.responses = row.api["chat-completions"]; },
      (row: any) => { row.api["chat-completions"].base_url = "https://other.invalid"; },
    ]) {
      const row = model("beam-free"); mutate(row);
      expect(isFreeChatGoModel(row)).toBe(false);
    }
  });
});
