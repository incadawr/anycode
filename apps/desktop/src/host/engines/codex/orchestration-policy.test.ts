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
    const captured = captureBaseConfig({ config: {} }, { forwarded: { command: "server" } });
    expect(orchestrationOverrides(captured)).toContain('mcp_servers."forwarded".enabled=false');
    expect(() => verifyConfig({ config: { mcp_servers: { forwarded: { enabled: false } }, features: { multi_agent: false }, sandbox_mode: "read-only", approval_policy: "never" } }, captured, true)).not.toThrow();
    expect(() => verifyConfig({ config: {} }, captured, false)).not.toThrow();
  });
});
