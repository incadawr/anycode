import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskCredentials } from "./claude-doctor.js";
import { describe, expect, it } from "vitest";
import { claudeCliIdentity, claudeCatalogKey, projectClaudeModels, selectClaudeCatalog } from "./claude-model-cache.js";
import { DEFAULT_SETTINGS, settingsSchema } from "../settings/schema.js";

const account = { email: "person@example.test", organization: "organization", tokenSource: "oauth" };
const key = () => claudeCatalogKey(account, "trusted-cli", "2.1.215")!;
const models = [{ id: "account-model", label: "Account model 6.0" }];

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
    expect(claudeCatalogKey({ ...account, tokenSource: "other" }, "trusted-cli", "2.1.215")).toBe(key());
    expect(claudeCatalogKey({}, "trusted-cli", "2.1.215")).toBeUndefined();
    expect(claudeCatalogKey(account, undefined, "2.1.215")).toBeUndefined();
  });
  it("uses a previous catalog only after a matching fresh identity verdict", () => {
    const cached = { identity: key(), models };
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key() }, cached)).toEqual(models);
    expect(selectClaudeCatalog({ status: "ready", catalogIdentity: key() }, undefined)).toEqual([]);
    expect(selectClaudeCatalog({ status: "ready" }, cached)).toEqual([]);
    expect(selectClaudeCatalog({ status: "signed_out", catalogIdentity: key() }, cached)).toEqual([]);
    for (const identity of [
      claudeCatalogKey({ ...account, email: "other@example.test" }, "trusted-cli", "2.1.215"),
      claudeCatalogKey({ ...account, organization: "different" }, "trusted-cli", "2.1.215"),
      claudeCatalogKey(account, "other-cli", "2.1.215"),
      claudeCatalogKey(account, "trusted-cli", "2.1.216"),
    ]) expect(selectClaudeCatalog({ status: "ready", catalogIdentity: identity }, cached)).toEqual([]);
  });
  it("prefers the latest initialize names and projects only selectable fields", () => {
    const fresh = projectClaudeModels([{ value: "fresh", displayName: "Fresh 7.0", account, token: "secret", supportsEffort: true, supportedEffortLevels: ["high", "invalid"] }], text => text);
    expect(fresh).toEqual([{ id: "fresh", label: "Fresh 7.0", efforts: ["high"] }]);
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
