/**
 * Pure view-model for the MCP secrets block of Settings → MCP (Taskana 4752, part C).
 * Name validation, ordering, the reference snippet, the notice, and the failure
 * text. The component is a thin shell over these, and every one is unit-tested
 * directly (mcp-secrets-model.test.ts).
 *
 * Renderer rules this module encodes:
 *  - A secret VALUE is never part of a list, a message, or a rendered reference.
 *  - The name is validated with the same shape main enforces (MCP_SECRET_NAME_RE).
 */

import { MCP_SECRET_NAME_RE, type McpSecretMutationFailure } from "../../../shared/mcp-secrets.js";

/** Shown under the block: write-only, encrypted, applies to new sessions. */
export const MCP_SECRETS_NOTICE =
  "Values are write-only and stored in AnyCode's encrypted store. They apply to new sessions.";

/** The problem text for a name that main would refuse; undefined when the name is acceptable. */
export function mcpSecretNameError(name: string): string | undefined {
  if (name.length === 0) return "Enter a name.";
  if (!MCP_SECRET_NAME_RE.test(name)) {
    return "Use letters, digits and underscores, starting with a letter or underscore (up to 64 characters).";
  }
  return undefined;
}

/** A save is allowed only with a valid name and a non-empty value. */
export function canSubmitMcpSecret(name: string, value: string): boolean {
  return mcpSecretNameError(name) === undefined && value.length > 0;
}

/** Names in plain code-unit order (no locale), without duplicates. */
export function sortedSecretNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The reference a user copies into an env or headers value. */
export function secretReferenceSnippet(name: string): string {
  return `\${secret:${name}}`;
}

/** Fixed, value-free text for a refused write. */
export function mcpSecretFailureMessage(reason: McpSecretMutationFailure["reason"]): string {
  switch (reason) {
    case "invalid":
      return "The name or value is not valid.";
    case "weak_storage_needs_consent":
      return "Encrypted storage is not available on this system. Allow weak storage in Settings → Security to save secrets.";
    case "io_error":
      return "The secret could not be saved. Try again.";
  }
}
