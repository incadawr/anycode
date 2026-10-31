import { describe, expect, it, vi } from "vitest";
import { isolatedSmokeEnv, launchReloadSmoke, readGroupDom, assertReloadSnapshot } from "../../scripts/renderer-reload-smoke-support.mjs";

describe("reload smoke isolation", () => {
  it("replaces inherited profile and import overrides with temporary paths", () => {
    const env = isolatedSmokeEnv({ HOME: "/owner", ANYCODE_PROFILE_HOME: "/owner", ANYCODE_TELEMETRY_DIR: "/owner", XDG_CONFIG_HOME: "/owner", PATH: "/bin" }, "/tmp/profile");
    expect(Object.entries(env).filter(([key]) => key !== "PATH").every(([, value]) => value?.startsWith("/tmp/profile"))).toBe(true);
    expect(env.PATH).toBe("/bin");
  });
  it("passes only explicitly selected provider credentials from the environment", () => {
    const env = isolatedSmokeEnv({ ANYCODE_API_KEY: "fixture", ANYCODE_BASE_URL: "https://example.test", ANYCODE_DB_PATH: "/owner/db" }, "/tmp/profile");
    expect(env.ANYCODE_API_KEY).toBe("fixture");
    expect(env.ANYCODE_BASE_URL).toBe("https://example.test");
    expect(env.ANYCODE_DB_PATH).toBeUndefined();
  });
  it("launches the smoke with isolated overrides despite hostile inherited paths", () => {
    const spawn = vi.fn();
    launchReloadSmoke(spawn, { HOME: "/owner", ANYCODE_PROFILE_HOME: "/owner", GIT_CONFIG_GLOBAL: "/owner/config", BASH_ENV: "/owner/hooks", NODE_OPTIONS: "--require=/owner/hook", PYTHONPATH: "/owner/modules", ANYCODE_API_KEY: "fixture" }, "/tmp/profile", "/tmp/profile/workspace", 1234, "/tmp/profile/unavailable");
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe("pnpm");
    expect(args).toEqual(["--filter", "@anycode/desktop", "dev", "--", "--use-mock-keychain", "--no-sandbox", "--disable-gpu"]);
    expect(options.env.HOME).toBe("/tmp/profile");
    expect(options.env.ANYCODE_PROFILE_HOME).toBe("/tmp/profile");
    expect(options.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(options.env.BASH_ENV).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.PYTHONPATH).toBeUndefined();
    expect(options.env.ANYCODE_DB_PATH).toBe("/tmp/profile/db.sqlite");
    expect(options.env.ANYCODE_API_KEY).toBe("fixture");
  });
  it("fails the reload check if an observed title or connection is lost", () => {
    const before = { tabs: [{ tabId: "t", sessionId: "s", title: "Saved title" }] };
    const ready = { tabs: [{ tabId: "t", sessionId: "s", title: "Saved title" }], states: { t: { connection: "ready" } } };
    expect(() => assertReloadSnapshot(before, ready)).not.toThrow();
    expect(() => assertReloadSnapshot(before, { ...ready, tabs: [{ ...ready.tabs[0]!, title: null }] })).toThrow("Title changed");
    expect(() => assertReloadSnapshot(before, { ...ready, states: { t: { connection: "connecting" } } })).toThrow("did not reconnect");
  });
  it("includes both original anchors in a collapsed two-message group", () => {
    const node = (id: string) => ({ hasAttribute: () => true, getAttribute: () => id });
    const root = { ...node("first"), querySelectorAll: () => [node("second")], querySelector: () => null };
    vi.stubGlobal("document", { querySelectorAll: () => [root] });
    try { expect(readGroupDom()[0]?.blockIds).toEqual(["first", "second"]); } finally { vi.unstubAllGlobals(); }
  });
});
