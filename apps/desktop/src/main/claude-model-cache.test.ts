import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskCredentials } from "./claude-doctor.js";
import { describe, expect, it } from "vitest";
import { loadClaudeCatalogSalt, claudeCliIdentity, claudeCatalogKey, projectClaudeModels, selectClaudeCatalog } from "./claude-model-cache.js";
import { DEFAULT_SETTINGS, settingsSchema } from "../settings/schema.js";

const account = { email: "person@example.test", organization: "organization", tokenSource: "oauth" };
const key = () => claudeCatalogKey(account, "trusted-cli", "2.1.215", "test-profile-salt")!;
const models = [{ id: "account-model", label: "Account model 6.0", resolvedId: "claude-account-6" }];

describe("Claude catalog cache", () => {
  it("invalidates the CLI fingerprint when its executable changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-catalog-")), path = join(dir, "cli");
    try {
      expect(claudeCliIdentity(path)).toBeUndefined();
      writeFileSync(path, "old");
      const first = claudeCliIdentity(path);
      writeFileSync(path, "new executable");
      expect(claudeCliIdentity(path)).not.toBe(first);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("hashes stable account and CLI identity without retaining account data", () => {
    expect(key()).toMatch(/^[a-f0-9]{64}$/);
    expect(claudeCatalogKey({ ...account, tokenSource: "other" }, "trusted-cli", "2.1.215", "test-profile-salt")).toBe(key());
    expect(claudeCatalogKey({}, "trusted-cli", "2.1.215", "test-profile-salt")).toBeUndefined();
    expect(claudeCatalogKey(account, undefined, "2.1.215", "test-profile-salt")).toBeUndefined();
  });
  it("uses a previous catalog only after a matching fresh identity verdict", () => {
    const cached = { identity: key(), models };
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key() }, cached)).toEqual(models);
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key() }, undefined)).toEqual([]);
    expect(selectClaudeCatalog({ status: "ready" }, cached)).toEqual([]);
    expect(selectClaudeCatalog({ status: "signed_out", catalogIdentity: key() }, cached)).toEqual([]);
    for (const identity of [
      claudeCatalogKey({ ...account, email: "other@example.test" }, "trusted-cli", "2.1.215", "test-profile-salt"),
      claudeCatalogKey({ ...account, organization: "different" }, "trusted-cli", "2.1.215", "test-profile-salt"),
      claudeCatalogKey(account, "other-cli", "2.1.215", "test-profile-salt"),
      claudeCatalogKey(account, "trusted-cli", "2.1.216", "test-profile-salt"),
    ]) expect(selectClaudeCatalog({ status: "ready", catalogIdentity: identity }, cached)).toEqual([]);
  });
  it("prefers the latest initialize names and projects only selectable fields", () => {
    const fresh = projectClaudeModels([{ value: "fresh", resolvedModel: "claude-fresh-7", displayName: "Fresh 7.0", account, token: "secret", supportsEffort: true, supportedEffortLevels: ["high", "invalid"] }], text => text);
    expect(fresh).toEqual([{ id: "fresh", label: "Fresh 7.0", resolvedId: "claude-fresh-7", efforts: ["high"] }]);
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key(), models: fresh }, { identity: key(), models })).toEqual(fresh);
    expect(projectClaudeModels([{ value: "safe", displayName: "person@example.test" }, { value: "sk-ant-api03-abcdef123456" }], maskCredentials)).toEqual([{ id: "safe", label: "<redacted>" }]);
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key(), models: [] }, { identity: key(), models })).toEqual([]);
    expect(projectClaudeModels([null, { value: "bad id" }], text => text)).toEqual([]);
  });
  it("retains the cache in per-engine settings and drops a malformed identity locally", () => {
    // Use schema defaults for the existing settings format.
    const base = DEFAULT_SETTINGS;
    const result = settingsSchema.parse({ ...base, claude: { modelCatalog: { identity: key(), models } } });
    expect(result.claude?.modelCatalog).toEqual({ identity: key(), models });
    const bad = settingsSchema.parse({ ...base, claude: { modelCatalog: { identity: "not-a-hash", models }, contextWindowTokens: 260000 } });
    expect(bad.claude?.modelCatalog).toBeUndefined();
    expect(bad.claude?.contextWindowTokens).toBe(260000);
  });
});

it("requires salted email identities and binds subscription and organization shape", () => {
  expect(claudeCatalogKey(account, "cli", "version")).toBeUndefined();
  expect(claudeCatalogKey({ ...account, organization: {} }, "cli", "version", "salt")).toBeUndefined();
  expect(claudeCatalogKey(account, "cli", "version", "salt-a")).not.toBe(claudeCatalogKey(account, "cli", "version", "salt-b"));
  const uuid = { ...account, accountUuid: "random-account-id" };
  expect(claudeCatalogKey(uuid, "cli", "version")).toMatch(/^[a-f0-9]{64}$/);
  expect(claudeCatalogKey(uuid, "cli", "version", "a")).toBe(claudeCatalogKey({ ...uuid, email: "other@example.test" }, "cli", "version", "b"));
  expect(claudeCatalogKey({ ...uuid, subscriptionType: "max" }, "cli", "version")).not.toBe(claudeCatalogKey({ ...uuid, subscriptionType: "pro" }, "cli", "version"));
});
it("persists a random salt per cache profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-salt-"));
  try {
    const salt = loadClaudeCatalogSalt(dir);
    expect(salt).toMatch(/^[a-f0-9]{64}$/);
    expect(loadClaudeCatalogSalt(dir)).toBe(salt);
    expect(readFileSync(join(dir, "claude-catalog.salt"), "utf8")).toBe(salt);
    expect(loadClaudeCatalogSalt(join(dir, "missing", "profile"))).toBeUndefined();
    writeFileSync(join(dir, "claude-catalog.salt"), "corrupt");
    expect(loadClaudeCatalogSalt(dir)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
