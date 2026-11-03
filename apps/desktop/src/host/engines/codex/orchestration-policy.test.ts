import { describe, expect, it } from "vitest";
import { captureBaseConfig, orchestrationOverrides, verifyConfig, verifyReadOnlyEcho } from "./orchestration-policy.js";

describe("Codex orchestration process policy", () => {
  const base = captureBaseConfig({ config: { mcp_servers: { 'a.b': { enabled: true }, ambient: {} }, features: { multi_agent: true } } });
  it("quotes MCP names and requires effective process overrides", () => {
    expect(orchestrationOverrides(base)).toContain('mcp_servers."a.b".enabled=false');
    const on = { config: { mcp_servers: { 'a.b': { enabled: false }, ambient: { enabled: false } }, features: { multi_agent: false }, sandbox_mode: "read-only", approval_policy: "never" } };
    expect(() => verifyConfig(on, base, true)).not.toThrow();
    expect(() => verifyConfig({ config: { ...on.config, sandbox_mode: "workspace-write" } }, base, true)).toThrow();
    expect(() => verifyConfig({ config: {} }, base, true)).toThrow();
    expect(() => verifyConfig({ config: { mcp_servers: { 'a.b': { enabled: true }, ambient: {} }, features: { multi_agent: true } } }, base, false)).not.toThrow();
  });
  it("rejects weak and malformed thread policy echoes", () => {
    expect(() => verifyReadOnlyEcho({ approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } })).not.toThrow();
    for (const echo of [{}, { approvalPolicy: "never", sandbox: { type: "readOnly" } }, { approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false } }]) expect(() => verifyReadOnlyEcho(echo)).toThrow();
    expect(() => captureBaseConfig({ config: { mcp_servers: [] } })).toThrow();
  });
  it("includes forwarded-only names in isolation without requiring them in ambient restoration", () => {
    const captured = captureBaseConfig({ config: { mcp_servers: {} } }, { forwarded: { url: "https://example.test", http_headers: { Authorization: "secret" } } });
    const overrides = orchestrationOverrides(captured);
    expect(overrides).toContain('mcp_servers."forwarded".command="anycode-disabled-mcp"');
    expect(overrides).toContain('mcp_servers."forwarded".enabled=false');
    expect(overrides.join(" ")).not.toContain("secret");
    expect(() => verifyConfig({ config: { mcp_servers: { forwarded: { enabled: false } }, features: { multi_agent: false }, sandbox_mode: "read-only", approval_policy: "never" } }, captured, true)).not.toThrow();
    expect(() => verifyConfig({ config: { mcp_servers: {} } }, captured, false)).not.toThrow();
  });
  it("requires a complete MCP inventory and rejects unexpected or enabled servers", () => {
    expect(() => captureBaseConfig({ config: {} })).toThrow();
    const captured = captureBaseConfig({ config: { mcp_servers: { ambient: {} } } }, { forwarded: {} });
    const config = { mcp_servers: { ambient: { enabled: false }, forwarded: { enabled: false } }, features: { multi_agent: false }, sandbox_mode: "read-only", approval_policy: "never" };
    expect(() => verifyConfig({ config }, captured, true)).not.toThrow();
    expect(() => verifyConfig({ config: { ...config, mcp_servers: { ...config.mcp_servers, extra: { enabled: false } } } }, captured, true)).toThrow();
    expect(() => verifyConfig({ config: { ...config, features: { multi_agent: true } } }, captured, true)).toThrow();
    expect(() => verifyConfig({ config: { ...config, mcp_servers: { ambient: { enabled: false }, forwarded: { enabled: true } } } }, captured, true)).toThrow();
  });
  it("produces parseable -c assignments with a disabled transport for each forwarded server", async () => {
    // Use the same TOML parser as the core package to check actual argument syntax.
    const { createRequire } = await import("node:module");
    const require = createRequire(new URL("../../../../../../packages/core/package.json", import.meta.url));
    const { parse } = require("smol-toml") as { parse: (input: string) => Record<string, unknown> };
    const base = captureBaseConfig({ config: { mcp_servers: {} } }, { 'a.b': { command: "server" }, http: { url: "https://example.test" } });
    const args = orchestrationOverrides(base).flatMap((value) => ["-c", value]);
    expect(args.filter((_, i) => i % 2 === 0).every((arg) => arg === "-c")).toBe(true);
    const config = parse(args.filter((_, i) => i % 2 === 1).join("\n"));
    expect(config.mcp_servers).toEqual({ 'a.b': { command: "anycode-disabled-mcp", enabled: false }, http: { command: "anycode-disabled-mcp", enabled: false } });
  });
});
