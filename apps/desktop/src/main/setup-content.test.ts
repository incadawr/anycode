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
    const updated = applySetupImport(planSetupImport(changed, first), choices);
    expect(updated.provider.connections[1]).toEqual(initial.provider.connections[1]);
    expect(updated.provider.connections[0]!.providerId).not.toBe(updated.provider.connections[1]!.providerId);
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
  it("requires explicit collision choices and refuses dangling skipped routes", () => {
    const content = buildSetupContent(fixture(), selection);
    const plan = planSetupImport(content, fixture());
    expect(() => applySetupImport(plan, { connections: {}, roleProfiles: {} })).toThrow(/Choose/);
    expect(() => applySetupImport(plan, { connections: { Team: "skip" }, roleProfiles: choices.roleProfiles })).toThrow(/skipped/);
  });
});
