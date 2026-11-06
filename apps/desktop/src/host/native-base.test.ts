import { describe, expect, it } from "vitest";
import { checkedNativeBase, claudeMcpDigest, nativeConfigDigest, savedNativeRecovery, recoveryNativeBase } from "./native-base.js";

describe("native base fingerprints", () => {
  const server = { command: "server", env: { TOKEN: "credential-sentinel" } };
  const forward = (servers: object) => ({ claudeJson: JSON.stringify({ mcpServers: servers }), claudeNames: Object.keys(servers),
    claudeConfigPath: "/private/ephemeral", loaderProblems: [], forwardProblems: [] });
  it("canonicalizes object order and fingerprints credential or inventory changes", () => {
    expect(nativeConfigDigest({ a: 1, b: { x: 2, y: 3 } })).toBe(nativeConfigDigest({ b: { y: 3, x: 2 }, a: 1 }));
    const digest = claudeMcpDigest(forward({ b: server, a: {} }));
    expect(digest).toBe(claudeMcpDigest(forward({ a: {}, b: server })));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain("credential-sentinel");
    expect(digest).not.toBe(claudeMcpDigest(forward({ b: { ...server, env: { TOKEN: "changed" } }, a: {} })));
    expect(digest).not.toBe(claudeMcpDigest(forward({ b: server })));
  });
  it("refuses incomplete resolution rather than hashing a permissive empty fallback", () => {
    for (const value of [undefined, {}, { ...forward({ a: server }), loaderProblems: ["error"] },
      { ...forward({ a: server }), forwardProblems: ["error"] }, { ...forward({ a: server }), claudeConfigPath: undefined },
      { ...forward({ a: server }), claudeNames: [] }, { ...forward({}), claudeJson: "[]" }]) {
      expect(() => claudeMcpDigest(value)).toThrow();
    }
    expect(() => claudeMcpDigest(forward({}))).not.toThrow();
  });
  it("requests recovery from either durable projection even with unknown version", () => {
    expect(savedNativeRecovery()).toBeUndefined();
    const invalid = { version: 99, engine: "claude", preset: "workspace" };
    const on = { orchestration: { enabled: true as const, nativeBase: invalid } };
    expect(savedNativeRecovery({ selected: on, applied: {} })).toEqual({ nativeBase: undefined });
    expect(savedNativeRecovery({ selected: {}, applied: on })).toEqual({ nativeBase: invalid });
    expect(recoveryNativeBase({ nativeBase: invalid }, "claude")).toBeUndefined();
  });
  it("returns detached versioned policy facts and rejects cross-engine or secret-bearing objects", () => {
    const value = { version: 1, engine: "claude", model: "m", preset: "read-only", permissionMode: "plan", mcpDigest: "a".repeat(64), tools: ["Read"] };
    const snapshot = checkedNativeBase(value, "claude");
    if (snapshot.engine === "claude") snapshot.tools.push("Write");
    expect(value.tools).toEqual(["Read"]);
    expect(() => checkedNativeBase(value, "codex")).toThrow("engine mismatch");
    expect(() => checkedNativeBase({ ...value, env: server.env }, "claude")).toThrow();
    expect(() => checkedNativeBase({ ...value, version: 99 }, "claude")).toThrow();
  });
});
