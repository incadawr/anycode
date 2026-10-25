/**
 * Unit tests for the MCP secrets view-model (Taskana 4752, part C). Pure, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  MCP_SECRETS_NOTICE,
  canSubmitMcpSecret,
  mcpSecretFailureMessage,
  mcpSecretNameError,
  secretReferenceSnippet,
  sortedSecretNames,
} from "./mcp-secrets-model.js";

describe("mcpSecretNameError", () => {
  it("accepts an env-shaped name", () => {
    expect(mcpSecretNameError("GITHUB_TOKEN")).toBeUndefined();
    expect(mcpSecretNameError("_x1")).toBeUndefined();
  });

  it("asks for a name when empty", () => {
    expect(mcpSecretNameError("")).toBe("Enter a name.");
  });

  it("rejects a dash, a leading digit, a space, and a 65-character name", () => {
    for (const bad of ["a-b", "1x", "has space", "x".repeat(65)]) {
      expect(mcpSecretNameError(bad)).toMatch(/letters, digits and underscores/);
    }
  });

  it("accepts the 64-character maximum", () => {
    expect(mcpSecretNameError("a".repeat(64))).toBeUndefined();
  });
});

describe("canSubmitMcpSecret", () => {
  it("needs a valid name and a non-empty value", () => {
    expect(canSubmitMcpSecret("GH", "v")).toBe(true);
    expect(canSubmitMcpSecret("GH", "")).toBe(false);
    expect(canSubmitMcpSecret("a-b", "v")).toBe(false);
    expect(canSubmitMcpSecret("", "v")).toBe(false);
  });
});

describe("sortedSecretNames", () => {
  it("sorts by code unit and removes duplicates, with no locale", () => {
    expect(sortedSecretNames(["b", "B", "a", "a"])).toEqual(["B", "a", "b"]);
  });
});

describe("secretReferenceSnippet", () => {
  it("renders the reference a user copies", () => {
    expect(secretReferenceSnippet("GITHUB_TOKEN")).toBe("${secret:GITHUB_TOKEN}");
  });
});

describe("notice and failure text", () => {
  it("states write-only, encrypted, and new-sessions scope", () => {
    expect(MCP_SECRETS_NOTICE).toBe(
      "Values are write-only and stored in AnyCode's encrypted store. They apply to new sessions.",
    );
  });

  it("maps every refusal to fixed text that carries no value", () => {
    expect(mcpSecretFailureMessage("invalid")).toMatch(/not valid/);
    expect(mcpSecretFailureMessage("weak_storage_needs_consent")).toMatch(/weak storage/);
    expect(mcpSecretFailureMessage("io_error")).toMatch(/could not be saved/);
  });
});
