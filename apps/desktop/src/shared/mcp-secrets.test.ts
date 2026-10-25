import { describe, expect, it } from "vitest";
import {
  ENV_MCP_SECRETS,
  MCP_SECRETS_LIST_CHANNEL,
  MCP_SECRET_DELETE_CHANNEL,
  MCP_SECRET_SET_CHANNEL,
  isMcpSecretKey,
  mcpSecretKey,
  parseMcpSecretKey,
} from "./mcp-secrets.js";

describe("MCP secret store names (Taskana 4752, part C)", () => {
  it("uses the literal fork-env and IPC channel names", () => {
    expect(ENV_MCP_SECRETS).toBe("ANYCODE_MCP_SECRETS");
    expect(MCP_SECRETS_LIST_CHANNEL).toBe("anycode:mcp-secrets-list");
    expect(MCP_SECRET_SET_CHANNEL).toBe("anycode:mcp-secret-set");
    expect(MCP_SECRET_DELETE_CHANNEL).toBe("anycode:mcp-secret-delete");
  });

  it("builds and parses the vault key for a valid name", () => {
    expect(mcpSecretKey("GITHUB_TOKEN")).toBe("mcp.secret.GITHUB_TOKEN");
    expect(parseMcpSecretKey("mcp.secret.GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(isMcpSecretKey("mcp.secret.A")).toBe(true);
  });

  it("accepts the 64-character maximum and rejects 65", () => {
    expect(parseMcpSecretKey(`mcp.secret.${"a".repeat(64)}`)).toBe("a".repeat(64));
    expect(parseMcpSecretKey(`mcp.secret.${"a".repeat(65)}`)).toBeUndefined();
  });

  it("rejects names outside the env-name shape, and other namespaces", () => {
    for (const bad of ["a-b", "1x", "", "has space", "dot.name"]) {
      expect(parseMcpSecretKey(`mcp.secret.${bad}`)).toBeUndefined();
    }
    expect(parseMcpSecretKey("provider.apiKey")).toBeUndefined();
    expect(parseMcpSecretKey("provider.connection.c1.apiKey")).toBeUndefined();
    expect(isMcpSecretKey("provider.apiKey")).toBe(false);
  });
});
