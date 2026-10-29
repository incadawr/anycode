import { expect, it } from "vitest";
import { buildSmokeEnv } from "../../scripts/model-overrides-smoke-env.mjs";

it("isolates the smoke from inherited effort levels", () => {
  const parent = { ANYCODE_EFFORT_LEVELS: "max", KEEP_ME: "yes" };
  const env = buildSmokeEnv(parent, "/tmp/profile", 1234, "/tmp/bin");
  expect(env.ANYCODE_EFFORT_LEVELS).toBeUndefined();
  expect(env.KEEP_ME).toBe("yes");
  expect(parent.ANYCODE_EFFORT_LEVELS).toBe("max");
});
