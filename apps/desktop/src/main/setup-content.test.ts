import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "./vault.js";
import { describe, expect, it } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { applySetupImport, buildSetupContent, planSetupImport, validateSetupContent } from "./setup-content.js";

function fixture() {
  const settings = cloneDefaults();
  settings.provider.custom = [{ id: "custom:one", name: "Gateway", kind: "openai-compatible", baseUrl: "https://example.test/v1", models: ["model"], modelsFetchedAt: "yesterday" }];
  settings.provider.connections = [{ id: "conn-original", providerId: "custom:one", label: "Team", model: "model", lastHealth: { status: "ready", at: "today" }, modelOverrides: { model: { contextWindowTokens: 8192 } } }];
  settings.roleProfiles = { profiles: [{ id: "role-original", name: "Team roles", roles: { planner: { primary: { connection: "conn-original", model: "model" }, fallbacks: [{ connection: "conn-original" }] } } }], projects: [{ projectRoot: "/project", profileId: "role-original" }] };
  return settings;
}
const selection = { connectionIds: ["conn-original"], roleProfileIds: ["role-original"] };
const choices = { connections: { Team: "update-existing" as const }, roleProfiles: { "Team roles": "update-existing" as const } };

describe("setup content", () => {
  it("exports a key-free projection and remaps role routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setup-content-"));
    const vault = new Vault({ secretsPath: join(dir, "secrets.json"), platform: "darwin", safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() } });
    await vault.setSecret("provider.connection.conn-original.apiKey", "secret-fixture-key", { allowWeak: false });
    expect(await vault.getSecretValue("provider.connection.conn-original.apiKey")).toBe("secret-fixture-key");
    const content = buildSetupContent(fixture(), selection);
    const json = JSON.stringify(content);
    expect(json).not.toContain("secret-fixture-key");
    await rm(dir, { recursive: true, force: true });
    expect(json).not.toContain("conn-original");
    expect(json).not.toMatch(/lastHealth|modelsFetchedAt|projectRoot/);
    const result = applySetupImport(planSetupImport(content, cloneDefaults()), { connections: {}, roleProfiles: {} });
    const id = result.provider.connections[0]!.id;
    expect(id).not.toBe("conn-original");
    expect(result.roleProfiles!.profiles[0]!.roles.planner).toEqual({ primary: { connection: id, model: "model" }, fallbacks: [{ connection: id }] });
  });
  it("updates idempotently and preserves unrelated shared connections", () => {
    const content = buildSetupContent(fixture(), selection);
    const initial = applySetupImport(planSetupImport(content, cloneDefaults()), { connections: {}, roleProfiles: {} });
    initial.provider.connections.push({ id: "conn-other", providerId: initial.provider.connections[0]!.providerId, label: "Other" });
    const first = applySetupImport(planSetupImport(content, initial), choices);
    const second = applySetupImport(planSetupImport(content, first), choices);
    expect(second).toEqual(first);
    const changed = structuredClone(content);
    changed.connections[0]!.provider.baseUrl = "https://new.example.test";
    expect(() => applySetupImport(planSetupImport(changed, first), choices)).toThrow(/Destination changed/);
    const updated = applySetupImport(planSetupImport(changed, first), { connections: { Team: "add-copy" }, roleProfiles: { "Team roles": "skip" } });
    expect(updated.provider.connections[0]).toEqual(first.provider.connections[0]);
    expect(updated.provider.connections[2]!.id).not.toBe(first.provider.connections[0]!.id);
  });
  it("rejects malformed content, duplicate names and missing references", () => {
    const content = buildSetupContent(fixture(), selection);
    expect(() => validateSetupContent({ ...content, secret: "key" })).toThrow();
    expect(() => validateSetupContent({ ...content, connections: [content.connections[0], content.connections[0]] })).toThrow(/Duplicate/);
    expect(() => validateSetupContent({ ...content, connections: [] })).toThrow(/Missing connection/);
    expect(() => validateSetupContent({ ...content, connections: [{ ...content.connections[0], provider: { ...content.connections[0]!.provider, baseUrl: "https://user:password@example.test" } }] })).toThrow();
    expect(() => validateSetupContent({ ...content, connections: [{ ...content.connections[0], modelOverrides: { model: { contextWindowTokens: "large" } } }] })).toThrow();
    expect(() => validateSetupContent({ ...content, agentFiles: { "../secret.md": "x" } })).toThrow();
  });
  it("gives copies a distinct name when the existing connection has no label", () => {
    const settings = fixture();
    delete settings.provider.connections[0]!.label;
    const content = buildSetupContent(settings, selection);
    const result = applySetupImport(planSetupImport(content, settings), { connections: { Gateway: "add-copy" }, roleProfiles: { "Team roles": "skip" } });
    expect(result.provider.connections[1]!.label).toBe("Gateway (2)");
  });
  it("exports and restores catalog connections", () => {
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "conn-catalog", providerId: "openai", label: "OpenAI" }];
    const content = buildSetupContent(settings, { connectionIds: ["conn-catalog"], roleProfileIds: [] });
    expect(content.connections[0]!.provider.catalogId).toBe("openai");
    const imported = applySetupImport(planSetupImport(content, cloneDefaults()), { connections: {}, roleProfiles: {} });
    expect(imported.provider.connections[0]!.providerId).toBe("openai");
    expect(planSetupImport(content, imported).connections[0]!.existingBaseUrls).toEqual([content.connections[0]!.provider.baseUrl]);
  });
  it("rejects URL query strings", () => {
    const content = buildSetupContent(fixture(), selection);
    content.connections[0]!.provider.baseUrl += "?key=secret";
    expect(() => validateSetupContent(content)).toThrow();
  });
  it("keeps a catalog credential bound to its original provider and shows the real destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "setup-identity-"));
    try {
      const vault = new Vault({ secretsPath: join(dir, "secrets.json"), platform: "darwin", safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() } });
      await vault.setSecret("provider.connection.conn-one.apiKey", "synthetic-key", { allowWeak: false });
      const settings = cloneDefaults();
      settings.provider.connections = [{ id: "conn-one", providerId: "openai", label: "Team" }];
      const content = buildSetupContent(settings, { connectionIds: ["conn-one"], roleProfileIds: [] });
      content.connections[0]!.provider.catalogId = "openrouter";
    delete content.connections[0]!.provider.catalogBaseUrlOnly;
      const plan = planSetupImport(content, settings);
      expect(plan.connections[0]!.runtimeBaseUrl).toBe("https://openrouter.ai/api/v1");
      expect(plan.connections[0]!.canUpdate).toBe(false);
      expect(() => applySetupImport(plan, choices)).toThrow(/Destination changed/);
      const imported = applySetupImport(plan, { connections: { Team: "add-copy" }, roleProfiles: {} });
      const copy = imported.provider.connections[1]!;
      expect(copy.id).not.toBe("conn-one");
      expect(await vault.getSecretValue(`provider.connection.${copy.id}.apiKey`)).toBeUndefined();
      expect(await vault.getSecretValue("provider.connection.conn-one.apiKey")).toBe("synthetic-key");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["vllm", "custom"])("restores configured %s template destinations", (providerId) => {
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "conn-local", providerId, label: "Local", baseUrl: "http://localhost:8000/v1" }];
    const content = buildSetupContent(settings, { connectionIds: ["conn-local"], roleProfileIds: [] });
    const plan = planSetupImport(content, cloneDefaults());
    expect(plan.connections[0]!.baseUrl).toBe("http://localhost:8000/v1");
    const imported = applySetupImport(plan, { connections: {}, roleProfiles: {} });
    expect(imported.provider.connections[0]).toMatchObject({ providerId, baseUrl: "http://localhost:8000/v1" });
  });
  it("rejects secret-like names and URL paths", () => {
    for (const [label, url] of [["sk-fixture-secret", "https://example.test/v1"], ["Team", "https://example.test/sk-fixture-secret"], ["Team", "https://example.test/Abcdef1234567890GhijkLMNOPQRSTuv"], ["Bearer abcdef0123456789abcdef", "https://example.test/v1"], ["Team", "https://user:password@example.test/v1"], ["Team", "https://example.test/v1?token=fixture"]]) {
      const settings = fixture(); settings.provider.connections[0]!.label = label;
      settings.provider.custom![0]!.baseUrl = url!;
      expect(() => buildSetupContent(settings, selection)).toThrow();
    }
  });
  it("refuses updates that change destination inputs used by credential consumers", () => {
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "conn-keyed", providerId: "openai", label: "Team", baseUrl: "https://api.openai.com/v1" }];
    settings.network = { proxyProfiles: [{ id: "proxy-one", name: "Office", mode: "system" }] };
    const content = buildSetupContent(settings, { connectionIds: ["conn-keyed"], roleProfileIds: [] });
    const probes: Array<[string, (value: typeof content) => void]> = [
      ["recognizer, models fetch, connection check and quota override", (v) => { v.connections[0]!.provider.baseUrl = "https://attacker.test/v1"; }],
      ["session catalog and auth kind", (v) => { v.connections[0]!.provider.catalogId = "openrouter"; }],
      ["request transport and headers", (v) => { v.connections[0]!.transport = "openai-responses"; }],
      ["proxy route", (v) => { v.connections[0]!.proxy = "Office"; }],
      ["authentication policy", (v) => { v.connections[0]!.authOptional = true; }],
    ];
    for (const [consumer, mutate] of probes) {
      const changed = structuredClone(content); mutate(changed);
      const plan = planSetupImport(changed, settings);
      expect(plan.connections[0]!.canUpdate, consumer).toBe(false);
      expect(() => applySetupImport(plan, { connections: { Team: "update-existing" }, roleProfiles: {} }), consumer).toThrow(/Destination changed/);
      const copy = applySetupImport(plan, { connections: { Team: "add-copy" }, roleProfiles: {} });
      expect(copy.provider.connections[1]!.id, consumer).not.toBe("conn-keyed");
      if (consumer.startsWith("recognizer")) {
        expect(plan.connections[0]!.baseUrl).toBe("https://attacker.test/v1");
        expect(plan.connections[0]!.runtimeBaseUrl).toBe("https://api.openai.com/v1");
      }
    }
  });
  it("requires a copy for custom provider kind and legacy proxy changes", () => {
    const settings = fixture();
    const content = buildSetupContent(settings, selection);
    content.connections[0]!.provider.kind = "anthropic";
    expect(planSetupImport(content, settings).connections[0]!.canUpdate).toBe(false);
    settings.provider.connections[0]!.proxyUrl = "http://localhost:9000";
    content.connections[0]!.provider.kind = "openai-compatible";
    expect(planSetupImport(content, settings).connections[0]!.canUpdate).toBe(false);
  });
  it("rejects JWTs and vault references in every exported text field", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlZml4dHVyZQ";
    const values = [jwt, "provider.connection.fixture-owner.apiKey", "provider.example.oauth", "proxy.profile.fixture.password", "mcp.secret.FIXTURE"];
    for (const value of values) {
      for (const field of ["name", "model", "path"] as const) {
        const settings = fixture();
        if (field === "name") settings.provider.connections[0]!.label = value;
        if (field === "model") settings.provider.connections[0]!.model = value;
        if (field === "path") settings.provider.custom![0]!.baseUrl = `https://example.test/${value}`;
        expect(() => buildSetupContent(settings, selection), `${field}: ${value}`).toThrow();
      }
    }
  });
  it("requires explicit collision choices and refuses dangling skipped routes", () => {
    const content = buildSetupContent(fixture(), selection);
    const plan = planSetupImport(content, fixture());
    expect(() => applySetupImport(plan, { connections: {}, roleProfiles: {} })).toThrow(/Choose/);
    expect(() => applySetupImport(plan, { connections: { Team: "skip" }, roleProfiles: choices.roleProfiles })).toThrow(/skipped/);
  });
});
