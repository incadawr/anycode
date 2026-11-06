import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadSettings, saveSettings } from "./files.js";
import { cloneDefaults, parseSettings } from "./schema.js";

// Frozen v0.0.77 plugin boundary: strict nested block, passthrough root.
const legacyShape = z.object({
  plugins: z.object({
    autoUpdateOfficial: z.boolean().optional(),
    officialIndexUrl: z.string().url().optional(),
    mcpConsent: z.array(z.object({ plugin: z.string().min(1), serversHash: z.string().min(1), grantedAt: z.string() })).optional(),
    serviceConsent: z.array(z.object({ plugin: z.string().min(1), servicesHash: z.string().min(1), grantedAt: z.string() }).strict()).optional(),
  }).strict().optional().catch(undefined),
}).passthrough();

it("preserves plugin grants and account sources through a legacy settings write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anycode-downgrade-"));
  try {
    const path = join(dir, "settings.json");
    const settings = cloneDefaults();
    settings.plugins = {
      autoUpdateOfficial: true, mcpConsent: [],
      serviceConsent: [{ plugin: "example", servicesHash: "hash", grantedAt: "2026-11-07" }],
      accountSources: [{ plugin: "example", source: "accounts", descriptorHash: "a".repeat(64),
        connectionId: "example", accountId: "local", ownership: { model: {
          model: { value: true }, pricing: { value: { input: 1, output: 2 }, overridden: true },
          contextWindowTokens: { value: 8192 }, capabilities: { value: { reasoning: true, effortLevels: ["minimal"], imageInput: true } },
          pricingOverride: true, contextWindowTokensOverride: true,
        } } }],
    };
    await saveSettings(path, settings);
    const disk = JSON.parse(await readFile(path, "utf8"));
    const downgraded = legacyShape.parse(disk);
    expect(downgraded.plugins).toEqual({ ...settings.plugins, accountSources: undefined });
    await writeFile(path, JSON.stringify(downgraded));
    expect((await loadSettings(path)).settings.plugins).toEqual(settings.plugins);
    // Existing nested files remain readable; the next save uses the safe shape.
    await writeFile(path, JSON.stringify(settings));
    expect((await loadSettings(path)).settings.plugins).toEqual(settings.plugins);
    settings.plugins.accountSources = [];
    await saveSettings(path, settings);
    expect((await loadSettings(path)).settings.plugins?.accountSources).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("validates disk bindings without losing grants and prefers existing nested bindings", () => {
  const settings = { ...cloneDefaults(), plugins: { autoUpdateOfficial: false, mcpConsent: [] },
    pluginAccountSources: { version: 1, bindings: [{ invalid: true }] } };
  const parsed = parseSettings(settings);
  expect(parsed.status).toBe("ok");
  expect(parsed.settings.plugins).toEqual({ ...settings.plugins, accountSources: [] });
  expect(parsed.settings).not.toHaveProperty("pluginAccountSources");
  expect(settings.pluginAccountSources.bindings).toEqual([{ invalid: true }]);
  const binding = { plugin: "example", source: "accounts", descriptorHash: "a".repeat(64),
    connectionId: "example", accountId: "nested", ownership: {} };
  const nested = parseSettings({ ...settings,
    plugins: { ...settings.plugins, accountSources: [binding] },
    pluginAccountSources: { version: 1, bindings: [{ ...binding, accountId: "envelope" }] } });
  expect(nested.settings.plugins?.accountSources).toEqual([binding]);
  const future = parseSettings({ ...settings, pluginAccountSources: { version: 2, bindings: [] } });
  expect(future.settings).toHaveProperty("pluginAccountSources.version", 2);
});


it("preserves additive version-one binding fields through load and save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anycode-binding-extension-"));
  try {
    const path = join(dir, "settings.json");
    const binding = { plugin: "example", source: "accounts", descriptorHash: "a".repeat(64),
      connectionId: "example", accountId: "local", ownership: {}, label: "future label" };
    await writeFile(path, JSON.stringify({ ...cloneDefaults(),
      pluginAccountSources: { version: 1, bindings: [binding] } }));
    await saveSettings(path, (await loadSettings(path)).settings);
    expect(JSON.parse(await readFile(path, "utf8")).pluginAccountSources.bindings).toEqual([binding]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Frozen binding/plugin schemas are identical in every tag v0.0.78–v0.0.85.
const tokenRatesSchema = z.object({ input: z.number().finite().nonnegative(), cachedInput: z.number().finite().nonnegative().optional(), output: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative().optional() }).strict();
const accountSourceBindingSchema = z.object({
  plugin: z.string().min(1), source: z.string().min(1),
  descriptorHash: z.string().regex(/^[a-f0-9]{64}$/),
  connectionId: z.string().min(1), accountId: z.string().min(1),
  ownership: z.record(z.string(), z.object({
    model: z.object({ value: z.literal(true), overridden: z.boolean().optional() }).optional(),
    pricing: z.object({ value: tokenRatesSchema, overridden: z.boolean().optional() }).optional(),
    contextWindowTokens: z.object({ value: z.number().int().min(1024).max(1_000_000), overridden: z.boolean().optional() }).optional(),
    capabilities: z.object({ value: z.object({ reasoning: z.boolean().optional(), effortLevels: z.array(z.string()).optional(), imageInput: z.literal(true).optional() }), overridden: z.boolean().optional() }).optional(),
    pricingOverride: z.literal(true).optional(),
    contextWindowTokensOverride: z.literal(true).optional(),
  })),
});

const mcpConsentEntrySchema = z.object({ plugin: z.string().min(1), serversHash: z.string().min(1), grantedAt: z.string() });
const serviceConsentEntrySchema = z.object({ plugin: z.string().min(1), servicesHash: z.string().min(1), grantedAt: z.string() }).strict();
const pluginsSettingsSchema = z
  .object({
    autoUpdateOfficial: z.boolean().optional(),
    officialIndexUrl: z.string().url().optional(),
    mcpConsent: z.array(mcpConsentEntrySchema).optional(),
    serviceConsent: z.array(serviceConsentEntrySchema).optional(),
    accountSources: z.preprocess((raw) => (Array.isArray(raw) ? raw : []).filter((item) => accountSourceBindingSchema.safeParse(item).success), z.array(accountSourceBindingSchema)).optional(),
  })
  .strict()
  .optional()
  .catch(undefined);

const nestedShape = z.object({ plugins: pluginsSettingsSchema }).passthrough();
it.each([77, 78, 79, 80, 81, 82, 83, 84, 85])("records the released 0.0.%i binding boundary", async (version) => {
  const dir = await mkdtemp(join(tmpdir(), "anycode-matrix-"));
  try {
    const path = join(dir, "settings.json");
    const binding = { plugin: "example", source: "accounts", descriptorHash: "a".repeat(64),
      connectionId: "example", accountId: "local", ownership: { model: { model: { value: true as const } } } };
    const settings = cloneDefaults();
    settings.plugins = { autoUpdateOfficial: true, mcpConsent: [], accountSources: [binding] };
    await saveSettings(path, settings);
    const disk = JSON.parse(await readFile(path, "utf8"));
    const shape = version === 77 ? legacyShape : nestedShape;
    const loaded = shape.parse(disk);
    expect(loaded.plugins).toEqual({ autoUpdateOfficial: true, mcpConsent: [] });
    expect(loaded.pluginAccountSources).toEqual({ version: 1, bindings: [binding] });
    await writeFile(path, JSON.stringify(loaded));
    expect((await loadSettings(path)).settings.plugins).toEqual(settings.plugins);
    // Dual writing solves nested readers, but makes the oldest reader drop grants.
    const dual = shape.parse({ ...disk, plugins: settings.plugins });
    expect(dual.plugins).toEqual(version === 77 ? undefined : settings.plugins);
    if (version > 77) {
      await writeFile(path, JSON.stringify({ ...loaded,
        plugins: { ...loaded.plugins, accountSources: [{ ...binding, ownership: {} }] } }));
      expect((await loadSettings(path)).settings.plugins?.accountSources?.[0]?.ownership).toEqual({});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


it.each([
  [undefined, { version: 1, bindings: [] }],
  [{ version: 1, bindings: ["old"] }, { version: 1, bindings: [] }],
  [{ version: 2, bindings: ["future"], extra: { keep: true } }, undefined],
  [{ version: "malformed", extra: true }, undefined],
  [null, undefined],
])("preserves unknown account envelopes on save: %j", async (envelope, replacement) => {
  const dir = await mkdtemp(join(tmpdir(), "anycode-envelope-"));
  try {
    const path = join(dir, "settings.json");
    const settings = { ...cloneDefaults(), plugins: { accountSources: [] },
      ...(envelope !== undefined ? { pluginAccountSources: envelope } : {}) };
    await saveSettings(path, settings);
    expect(JSON.parse(await readFile(path, "utf8")).pluginAccountSources).toEqual(replacement ?? envelope);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
