import { describe, expect, it } from "vitest";
import { providerV2 } from "../shared/provider-v2-fixture.js";
import { NATIVE_SESSIONS_ENV, takeNativeSessionsCarrier } from "../shared/session-peers.js";
import { buildHostEnv, nativeSessionsEnabledForBoot } from "./host-env.js";

describe("native session boot carrier", () => {
  it("is on by default on macOS and Linux, packaged or not", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(nativeSessionsEnabledForBoot({}, platform)).toBe(true);
      expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: "garbage" }, platform)).toBe(true);
    }
  });
  it("lets 0 switch it off and keeps Windows opt-in", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: "0" }, platform)).toBe(false);
    }
    expect(nativeSessionsEnabledForBoot({}, "win32")).toBe(false);
    expect(nativeSessionsEnabledForBoot({ [NATIVE_SESSIONS_ENV]: "1" }, "win32")).toBe(true);
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
