import { describe, expect, it } from "vitest";
import { OPENCODE_GO_MODELS } from "./opencode-go.js";
import { resolveModelRoute } from "./model-route.js";

describe("OpenCode Go static snapshot", () => {
  it("contains exactly the supported routes and excludes Gemini", () => {
    const models = Object.values(OPENCODE_GO_MODELS.models);
    expect(models).toHaveLength(28);
    expect(models.filter((e) => e.route.transport === "anthropic-messages")).toHaveLength(5);
    expect(models.filter((e) => e.route.transport === "openai-chat-completions")).toHaveLength(18);
    expect(models.filter((e) => e.route.transport === "openai-responses")).toHaveLength(5);
    expect(resolveModelRoute<unknown>("opencode", "gemini-4-argon", OPENCODE_GO_MODELS)).toMatchObject({ reason: "unsupported-model" });
    for (const [id, entry] of Object.entries(OPENCODE_GO_MODELS.models)) expect(resolveModelRoute<unknown>("opencode", id, OPENCODE_GO_MODELS)).toEqual(entry);
    expect(OPENCODE_GO_MODELS.models["kimi-k2.7-code"].route.metadata.limit).not.toHaveProperty("output");
  });
});

it("matches every supported fixture row's route and advertised metadata", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/opencode-go-models.json", import.meta.url), "utf8")) as { data: Array<Record<string, any>> };
  expect(fixture.data).toHaveLength(29);
  for (const row of fixture.data) {
    if (row.id === "gemini-4-argon") continue;
    const entry = (OPENCODE_GO_MODELS.models as Record<string, any>)[row.id];
    expect(entry, row.id).toBeDefined();
    const [api, details] = Object.entries(row.api)[0] as [string, any];
    expect(entry.route.transport, row.id).toBe(({ messages: "anthropic-messages", "chat-completions": "openai-chat-completions", responses: "openai-responses" } as Record<string, string>)[api]);
    expect(entry.route.baseUrl, row.id).toBe(details.base_url);
    expect(entry.route.metadata).toMatchObject({ id: row.id, name: row.name, modalities: row.modalities, capabilities: row.capabilities, compatibility: details.compatibility ?? {}, apiCapabilities: details.capabilities ?? {} });
    expect(entry.route.metadata.limit.context).toBe(row.limit.context);
    expect(entry.route.metadata.limit.output).toBe(row.id === "kimi-k2.7-code" ? undefined : row.limit.output);
    const price = entry.route.metadata.pricing;
    const multiplier = row.cost.multipliers ? 2 : 1;
    expect(price.input).toBeCloseTo(row.cost.text.input.price * multiplier);
    expect(price.output).toBeCloseTo(row.cost.text.output.price * multiplier);
    expect(price.cachedInput).toBeCloseTo(row.cost.text.input.cache.read * multiplier);
    if (row.cost.text.input.cache.write !== undefined) expect(price.cacheWrite).toBeCloseTo(row.cost.text.input.cache.write * multiplier);
    const thresholds = new Set([...row.cost.text.input.overrides ?? [], ...row.cost.text.output.overrides ?? []].map((v: any) => v.when.context.gt));
    expect((price.tiers ?? []).map((v: any) => v.gt)).toEqual([...thresholds].sort((a: any, b: any) => a - b));
  }
});

it("parses the complete live listing and rejects ambiguous or malformed routes", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parseOpenCodeGoSnapshot } = await import("./model-route.js");
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/opencode-go-models.json", import.meta.url), "utf8"));
  const result = parseOpenCodeGoSnapshot(fixture, "2026-11-05T00:00:00Z");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const entries = Object.values(result.snapshot.models);
  expect(entries.filter(e => e.kind === "route")).toHaveLength(28);
  for (const [id, entry] of Object.entries(OPENCODE_GO_MODELS.models)) expect(result.snapshot.models[id], id).toEqual(entry);
  for (const [transport, count] of [["anthropic-messages", 5], ["openai-chat-completions", 18], ["openai-responses", 5]] as const) expect(entries.filter(e => e.kind === "route" && e.route.transport === transport)).toHaveLength(count);
  expect(result.snapshot.models["gemini-4-argon"]?.kind).toBe("refusal");
  for (const bad of [null, {}, { data: [] }, "{"]) expect(parseOpenCodeGoSnapshot(bad, "now").ok).toBe(false);
  const row = fixture.data[0];
  const badRows = [ { ...row, api: {} }, { ...row, api: { unknown: {} } }, { ...row, api: { messages: {}, responses: {} } }, { ...row, api: { "chat-completions": { base_url: "https://user@opencode.ai/inference/go/openai/v1" } } } ];
  for (const bad of badRows) {
    const parsed = parseOpenCodeGoSnapshot({ data: [bad] }, "now");
    expect(parsed.ok && parsed.snapshot.models[row.id]?.kind).toBe("refusal");
  }
  const duplicate = parseOpenCodeGoSnapshot({ data: [row, row] }, "now");
  expect(duplicate.ok && duplicate.snapshot.models[row.id]?.kind).toBe("refusal");
});
