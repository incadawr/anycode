import { expect, it } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSelfCheckProfile, selfCheckEnvironment, selfCheckBinaryFs } from "./self-check.js";
it("normal launch creates no self-check profile", () => expect(createSelfCheckProfile(["anycode"])).toBeUndefined());
it("self-check creates its own profile and cannot inherit production state or automation", () => {
  const root = createSelfCheckProfile(["anycode", "--self-check"])!;
  try {
    const original = { HOME: "/owner", ANYCODE_API_KEY: "secret-poison", ANYCODE_MODEL: "real", ANYCODE_SETTINGS_PATH: "/owner/settings", ANYCODE_SECRETS_PATH: "/owner/secrets", ANYCODE_AUTOMATION: "1", ANYCODE_WORKSPACE: "/owner/project", CODEX_HOME: "/owner/account", ELECTRON_RENDERER_URL: "http://localhost/", REMOTE_DEBUGGING_PORT: "9222" };
    const env = selfCheckEnvironment(original, root);
    expect(env.HOME).toBe("/owner");
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_AUTOMATION).toBeUndefined();
    expect(env.ANYCODE_WORKSPACE).toBeUndefined();
    expect(env.REMOTE_DEBUGGING_PORT).toBeUndefined();
    expect(env.CODEX_HOME).toBe(join(root, ".codex"));
    expect(env.ANYCODE_DB_PATH).toBe(join(root, "db.sqlite"));
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).provider.connections).toEqual([]);
    expect(original.ANYCODE_API_KEY).toBe("secret-poison");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("self-check cannot discover an installed CLI through ambient fallback rungs", async () => {
  const { discoverCodexBinary } = await import("./codex-binary.js");
  const { discoverClaudeBinary } = await import("./claude-binary.js");
  const inputs = { env: process.env, fs: selfCheckBinaryFs, envOverride: "/absent-self-check-cli" };
  expect(discoverCodexBinary(inputs).path).toBeNull();
  expect(discoverClaudeBinary(inputs).path).toBeNull();
});
