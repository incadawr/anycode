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

it("does not publish a base price for unknown conditions", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parseOpenCodeGoSnapshot } = await import("./model-route.js");
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/opencode-go-models.json", import.meta.url), "utf8"));
  const row = structuredClone(fixture.data[0]);
  row.cost.multipliers[0].when = { date: { gte: "2030-01-01" } };
  const parsed = parseOpenCodeGoSnapshot({ data: [row] }, "2026-11-05T00:00:00Z");
  const parsedEntry = parsed.ok ? parsed.snapshot.models[row.id] : undefined;
  expect(parsedEntry?.kind === "route" ? parsedEntry.route.metadata.pricing : "not a route").toBeUndefined();
  delete row.cost.multipliers;
  row.cost.text.input.overrides = [{ when: { tokens: { gt: 100 } }, price: 2 }];
  const tier = parseOpenCodeGoSnapshot({ data: [row] }, "2026-11-05T00:00:00Z");
  const tierEntry = tier.ok ? tier.snapshot.models[row.id] : undefined;
  expect(tierEntry?.kind === "route" ? tierEntry.route.metadata.pricing : "not a route").toBeUndefined();
});

it("resolves each supported static model with its own explicit policy", async () => {
  const { resolveOpenCodeGoEndpointPolicy } = await import("./opencode-go-policy.js");
  for (const [id, entry] of Object.entries(OPENCODE_GO_MODELS.models)) {
    const result = resolveOpenCodeGoEndpointPolicy("opencode", id);
    expect(result.kind).toBe("route");
    if (result.kind !== "route") continue;
    expect(result.route.transport).toBe(entry.route.transport);
    expect(result.route.baseUrl).toBe(entry.route.baseUrl);
    expect(result.route.metadata).toEqual(entry.route.metadata);
    expect(result.route.policy.model).toBe(id);
  }
  expect(resolveOpenCodeGoEndpointPolicy("opencode", "gemini-4-argon").kind).toBe("refusal");
  expect(resolveOpenCodeGoEndpointPolicy("other", "glm-5.3").kind).toBe("refusal");
  expect(resolveOpenCodeGoEndpointPolicy("opencode", "glm-5.3", { version: 1, models: {} }).kind).toBe("refusal");
});

it("projects exact model metadata without inventing effort levels or an output cap", async () => {
  const { openCodeGoCatalogEntry } = await import("./opencode-go-policy.js");
  const { getBuiltinCatalog } = await import("./catalog-data.js");
  const entry = getBuiltinCatalog().providers.find(p => p.id === "opencode")!;
  const kimi = openCodeGoCatalogEntry(entry, "kimi-k2.7-code").models[0]!;
  expect(kimi.maxOutputTokens).toBeUndefined();
  expect(kimi.effortLevels).toEqual([]);
  const longcat = openCodeGoCatalogEntry(entry, "longcat-2.0").models[0]!;
  expect(longcat.effortLevels).not.toContain("off");
  expect(longcat.supportsExplicitOff).toBe(false);
  const grok = openCodeGoCatalogEntry(entry, "grok-4.7").models[0]!;
  expect(grok.contextWindow).toBe(500000);
  expect(grok.maxOutputTokens).toBe(500000);
  const hy = openCodeGoCatalogEntry(entry, "hy4").models[0]!;
  expect(hy.contextWindow).toBe(1048576);
  expect(hy.effortLevels).toEqual(["off", "high"]);
  expect(openCodeGoCatalogEntry(entry, "muse-spark-1.2-contributor").models[0]!.effortLevels?.[0]).toBe("minimal");
});

it("catalog projects the supported fixture with the stable default and prices", async () => {
  const { getBuiltinCatalog } = await import("./catalog-data.js");
  const entry = getBuiltinCatalog().providers.find(provider => provider.id === "opencode")!;
  expect(entry.models[0]?.id).toBe("minimax-m3");
  expect(entry.models).toHaveLength(28);
  expect(entry.models.find(model => model.id === "grok-4.7")?.pricing?.tiers?.[0]?.gt).toBe(200000);
  expect(entry.models.find(model => model.id === "deepseek-v4-pro")?.pricing?.tariff).toBeDefined();
  expect(entry.models.some(model => model.id === "gemini-4-argon")).toBe(false);
});

it("projects every fixture name and complete reference price to both Go catalogs", async () => {
  const { readFile } = await import("node:fs/promises");
  const { getBuiltinCatalog } = await import("./catalog-data.js");
  const fixture = JSON.parse(await readFile(new URL("./__fixtures__/opencode-go-models.json", import.meta.url), "utf8"));
  for (const provider of ["opencode", "opencode-openai"]) {
    const models = getBuiltinCatalog().providers.find(p => p.id === provider)!.models;
    for (const row of fixture.data.filter((r: any) => r.id !== "gemini-4-argon")) {
      const model = models.find(m => m.id === row.id)!;
      expect(model.name, row.id).toBe(row.name);
      const input = row.cost.text.input, output = row.cost.text.output;
      const factor = row.cost.multipliers ? 2 : 1;
      const rates = (i: any, o: any) => ({ input: i.price * factor, ...(i.cache?.read !== undefined ? { cachedInput: i.cache.read * factor } : {}), ...(i.cache?.write !== undefined ? { cacheWrite: i.cache.write * factor } : {}), output: o.price * factor });
      const thresholds = [...new Set<number>([...(input.overrides ?? []), ...(output.overrides ?? [])].map((v: any) => v.when.context.gt))].sort((a, b) => a - b);
      const tiers = thresholds.map(gt => ({ gt, ...rates((input.overrides ?? []).find((v: any) => v.when.context.gt === gt) ?? input, (output.overrides ?? []).find((v: any) => v.when.context.gt === gt) ?? output) }));
      expect(model.pricing, row.id).toEqual({ basisId: `${row.id}-opencode-go-2026-11-05`, ...rates(input, output), ...(tiers.length ? { tiers } : {}), ...(row.cost.multipliers ? { tariff: { peakUtcDays: [1, 2, 3, 4, 5], peakUtcHours: [[1, 4], [6, 10]], offPeakMultiplier: 0.5 } } : {}) });
    }
  }
});
