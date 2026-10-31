import { expect, it } from "vitest";
import { buildSmokeEnv } from "../../scripts/model-overrides-smoke-env.mjs";

it("isolates the smoke from inherited effort levels", () => {
  const parent = { ANYCODE_EFFORT_LEVELS: "max", KEEP_ME: "yes", PATH: "/usr/bin" };
  const env = buildSmokeEnv(parent, "/tmp/profile", 1234, "/tmp/bin");
  expect(env.ANYCODE_EFFORT_LEVELS).toBeUndefined();
  expect(env.KEEP_ME).toBeUndefined();
  expect(env.PATH).toContain("/usr/bin");
  expect(env.ANYCODE_SUBAGENTS_HOME).toBe("/tmp/profile");
  expect(env.ANYCODE_TELEMETRY_DIR).toBe("/tmp/profile/telemetry");
  expect(parent.ANYCODE_EFFORT_LEVELS).toBe("max");
});
