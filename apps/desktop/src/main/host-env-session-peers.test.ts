import { describe, expect, it } from "vitest";
import { providerV2 } from "../shared/provider-v2-fixture.js";
import { NATIVE_SESSIONS_ENV, takeNativeSessionsCarrier } from "../shared/session-peers.js";
import { buildHostEnv, nativeSessionsEnabledForBoot } from "./host-env.js";

describe("native session boot carrier", () => {
  it.each([undefined, "0", "garbage", "true", " 1", "1 "])("defaults %s to off", raw => {
    expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: raw }, false)).toBe(false);
  });
  it("accepts the development boot opt-in and rejects packaged boot", () => {
    expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: "1" }, false)).toBe(true);
    expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: "1" }, true)).toBe(false);
  });
  it.each([undefined, false, true])("uses only the main-derived boolean %s", async enabled => {
    const env = await buildHostEnv({
      bootEnv: { [NATIVE_SESSIONS_ENV]: "1" }, settings: { version: 2, provider: providerV2({}), tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } },
      getSecret: async () => undefined,
      ...(enabled === undefined ? {} : { nativeSessionsEnabled: enabled }),
    });
    expect(env[NATIVE_SESSIONS_ENV]).toBe(enabled ? "1" : undefined);
    expect(takeNativeSessionsCarrier(env)).toBe(enabled === true);
    expect(env[NATIVE_SESSIONS_ENV]).toBeUndefined();
  });
  it.each([undefined, "0", "garbage", "1"])("consumes %s before subprocess inheritance", raw => {
    const env = { [NATIVE_SESSIONS_ENV]: raw, PATH: "/bin" };
    expect(takeNativeSessionsCarrier(env)).toBe(raw === "1");
    expect(env).toEqual({ PATH: "/bin" });
    expect(takeNativeSessionsCarrier(env)).toBe(false);
  });
});
