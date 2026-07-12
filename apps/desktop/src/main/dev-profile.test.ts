/**
 * Gate truth table for the automation dev userData override (design
 * slice-P7.H-cut.md §5): packaged always refuses (even with both vars set),
 * automation unset/"0" refuses, an empty/whitespace-only dir refuses, a
 * relative path refuses, and the all-green combination returns the dir
 * verbatim (untrimmed of surrounding content, only trimmed for emptiness).
 */
import { describe, expect, it } from "vitest";
import {
  isRefusedUserDataOverride,
  resolveMcpImportHome,
  resolveSecretsPathOverride,
  resolveSettingsPathOverride,
  resolveUserDataOverride,
} from "./dev-profile.js";

const ABS_DIR = "/tmp/anycode-dev-profile-test";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("resolveUserDataOverride", () => {
  it("returns the path when automation=1, unpackaged, and the dir is absolute", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: ABS_DIR }), false);
    expect(result).toBe(ABS_DIR);
  });

  it("refuses when packaged, even with both vars set", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: ABS_DIR }), true);
    expect(result).toBeNull();
  });

  it("refuses when ANYCODE_AUTOMATION is unset", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_USER_DATA_DIR: ABS_DIR }), false);
    expect(result).toBeNull();
  });

  it('refuses when ANYCODE_AUTOMATION is "0"', () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "0", ANYCODE_USER_DATA_DIR: ABS_DIR }), false);
    expect(result).toBeNull();
  });

  it("refuses when ANYCODE_USER_DATA_DIR is unset", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1" }), false);
    expect(result).toBeNull();
  });

  it("refuses when ANYCODE_USER_DATA_DIR is empty", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: "" }), false);
    expect(result).toBeNull();
  });

  it("refuses when ANYCODE_USER_DATA_DIR is whitespace-only", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: "   " }), false);
    expect(result).toBeNull();
  });

  it("refuses a relative path", () => {
    const result = resolveUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: "relative/dir" }), false);
    expect(result).toBeNull();
  });
});

describe("isRefusedUserDataOverride", () => {
  it("is true for a packaged build with both vars set", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: ABS_DIR }), true)).toBe(true);
  });

  it("is true for a relative path", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: "relative/dir" }), false)).toBe(true);
  });

  it("is false for the all-green combination", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: ABS_DIR }), false)).toBe(false);
  });

  it("is false (quiet, not refused) when automation is off", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_USER_DATA_DIR: "relative/dir" }), false)).toBe(false);
  });

  it("is false (quiet, not refused) when the dir is simply unset", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_AUTOMATION: "1" }), true)).toBe(false);
  });

  it("is false (quiet, not refused) when the dir is empty", () => {
    expect(isRefusedUserDataOverride(env({ ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: "" }), true)).toBe(false);
  });
});

const ABS_SETTINGS_PATH = "/tmp/anycode-dev-profile-test/settings.json";
const ABS_SECRETS_PATH = "/tmp/anycode-dev-profile-test/secrets.json";
const ABS_MCP_IMPORT_HOME = "/tmp/anycode-dev-profile-test/import-home";

/**
 * Truth table for the settings.json/secrets.json path overrides (design
 * slice-P7.15-cut.md §2.6) — identical gate shape to resolveUserDataOverride
 * above, just keyed on a different pair of env vars. One shared table driven
 * by [resolver, envVar, absPath] avoids duplicating every case twice.
 */
describe.each([
  ["resolveSettingsPathOverride", resolveSettingsPathOverride, "ANYCODE_SETTINGS_PATH", ABS_SETTINGS_PATH] as const,
  ["resolveSecretsPathOverride", resolveSecretsPathOverride, "ANYCODE_SECRETS_PATH", ABS_SECRETS_PATH] as const,
  // W5-FIX (finding 5): the MCP import-home override obeys the SAME dev/automation
  // double gate — a packaged production build never honors it.
  ["resolveMcpImportHome", resolveMcpImportHome, "ANYCODE_MCP_IMPORT_HOME", ABS_MCP_IMPORT_HOME] as const,
])("%s", (_name, resolve, varName, absPath) => {
  it("returns the path when automation=1, unpackaged, and the path is absolute", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: absPath }), false);
    expect(result).toBe(absPath);
  });

  it("refuses when packaged, even with both vars set", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: absPath }), true);
    expect(result).toBeNull();
  });

  it("refuses when ANYCODE_AUTOMATION is unset", () => {
    const result = resolve(env({ [varName]: absPath }), false);
    expect(result).toBeNull();
  });

  it('refuses when ANYCODE_AUTOMATION is "0"', () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "0", [varName]: absPath }), false);
    expect(result).toBeNull();
  });

  it("refuses when the path var is unset", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1" }), false);
    expect(result).toBeNull();
  });

  it("refuses when the path var is empty", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: "" }), false);
    expect(result).toBeNull();
  });

  it("refuses when the path var is whitespace-only", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: "   " }), false);
    expect(result).toBeNull();
  });

  it("refuses a relative path", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: "relative/settings.json" }), false);
    expect(result).toBeNull();
  });

  it("trims surrounding whitespace off an otherwise-absolute path", () => {
    const result = resolve(env({ ANYCODE_AUTOMATION: "1", [varName]: `  ${absPath}  ` }), false);
    expect(result).toBe(absPath);
  });
});
