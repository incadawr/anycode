import { describe, expect, it } from "vitest";
import {
  ENV_SESSION_ID,
  ENV_SESSION_WORKSPACE,
  applySessionToolEnv,
  sessionToolEnv,
} from "./session-env.js";

describe("session tool env names", () => {
  it("uses the literal public names", () => {
    expect(ENV_SESSION_ID).toBe("ANYCODE_SESSION_ID");
    expect(ENV_SESSION_WORKSPACE).toBe("ANYCODE_SESSION_WORKSPACE");
  });
});

describe("sessionToolEnv", () => {
  it("returns both keys for a populated session", () => {
    expect(sessionToolEnv("s-1", "/work/repo")).toEqual({
      ANYCODE_SESSION_ID: "s-1",
      ANYCODE_SESSION_WORKSPACE: "/work/repo",
    });
  });

  it("A-6: omits an empty session id", () => {
    expect(sessionToolEnv("", "/work/repo")).toEqual({ ANYCODE_SESSION_WORKSPACE: "/work/repo" });
  });

  it("A-6: omits an empty workspace", () => {
    expect(sessionToolEnv("s-1", "")).toEqual({ ANYCODE_SESSION_ID: "s-1" });
  });

  it("A-6: returns an empty object when both are empty", () => {
    expect(sessionToolEnv("", "")).toEqual({});
  });
});

describe("applySessionToolEnv (host fallback, ??= semantics)", () => {
  it("A-5: fills both keys when absent", () => {
    const env: Record<string, string | undefined> = {};
    applySessionToolEnv(env, "s-1", "/work/repo");
    expect(env).toEqual({ ANYCODE_SESSION_ID: "s-1", ANYCODE_SESSION_WORKSPACE: "/work/repo" });
  });

  it("A-5: never overrides an existing value", () => {
    const env: Record<string, string | undefined> = {
      ANYCODE_SESSION_ID: "from-main",
      ANYCODE_SESSION_WORKSPACE: "/from/main",
    };
    applySessionToolEnv(env, "other", "/other");
    expect(env).toEqual({ ANYCODE_SESSION_ID: "from-main", ANYCODE_SESSION_WORKSPACE: "/from/main" });
  });

  it("A-5: fills only the missing key", () => {
    const env: Record<string, string | undefined> = { ANYCODE_SESSION_ID: "from-main" };
    applySessionToolEnv(env, "other", "/work/repo");
    expect(env.ANYCODE_SESSION_ID).toBe("from-main");
    expect(env.ANYCODE_SESSION_WORKSPACE).toBe("/work/repo");
  });

  it("A-6: does not stamp an empty value", () => {
    const env: Record<string, string | undefined> = {};
    applySessionToolEnv(env, "", "");
    expect(env).toEqual({});
  });

  it("never touches the launch directive ANYCODE_WORKSPACE", () => {
    const env: Record<string, string | undefined> = {};
    applySessionToolEnv(env, "s-1", "/work/repo");
    expect("ANYCODE_WORKSPACE" in env).toBe(false);
  });
});
