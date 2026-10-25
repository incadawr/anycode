/**
 * MCP secret store, value-only (Taskana 4752, part C). Zero imports: shared by the
 * main process (vault, IPC), the host (the fork env reader), and the renderer.
 *
 * A `${secret:NAME}` reference in an MCP server's `env`/`headers` resolves to the
 * value stored under the vault key `mcp.secret.<NAME>`. Main hands the host only
 * the values a tab's configs reference, in ONE env var (`ENV_MCP_SECRETS`), which
 * the host reads once and deletes. No channel here ever returns a value.
 */

/** The fork-env variable carrying `{NAME: value}` for one host; scrubbed like the API keys. */
export const ENV_MCP_SECRETS = "ANYCODE_MCP_SECRETS";

/** Same shape as an env-var name, capped at 64 characters. */
export const MCP_SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const MCP_SECRET_KEY_RE = /^mcp\.secret\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;

export const MCP_SECRETS_LIST_CHANNEL = "anycode:mcp-secrets-list";
export const MCP_SECRET_SET_CHANNEL = "anycode:mcp-secret-set";
export const MCP_SECRET_DELETE_CHANNEL = "anycode:mcp-secret-delete";

/** The vault key for a secret name (the caller has validated the name). */
export function mcpSecretKey(name: string): `mcp.secret.${string}` {
  return `mcp.secret.${name}`;
}

/** The secret name of a vault key, or undefined when the key is not an MCP secret. */
export function parseMcpSecretKey(key: string): string | undefined {
  const match = MCP_SECRET_KEY_RE.exec(key);
  return match?.[1];
}

export function isMcpSecretKey(key: string): key is `mcp.secret.${string}` {
  return parseMcpSecretKey(key) !== undefined;
}

export type McpSecretsListResult = { ok: true; names: string[] };

export type McpSecretMutationFailure = {
  ok: false;
  reason: "invalid" | "weak_storage_needs_consent" | "io_error";
};

/** Set/delete reply: names only, never a value. */
export type McpSecretMutationResult = { ok: true; names: string[] } | McpSecretMutationFailure;
