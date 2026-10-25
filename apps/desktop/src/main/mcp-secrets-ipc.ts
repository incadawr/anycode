/**
 * MCP secrets control-plane IPC (Taskana 4752, part C). Three channels, all
 * write-only: `list` returns names; `set` takes `{name, value}` and returns names;
 * `delete` takes `{name}` and returns names. NO channel ever returns a value.
 *
 * The handlers are exported pure functions over a deps bag (unit-testable without
 * ipcMain), zod-validated at this trust boundary (`.strict()`, so an extra key such
 * as `path` is refused). The weak-storage consent is read from the same
 * `settings.security.allowWeakSecretStorage` flag provider keys use, through the
 * `allowWeak` dep the wiring supplies. Handlers log NO payloads: a failure logs a
 * fixed string plus the error message, after the submitted value is redacted from it.
 */

import { ipcMain } from "electron";
import { z } from "zod";
import {
  MCP_SECRETS_LIST_CHANNEL,
  MCP_SECRET_DELETE_CHANNEL,
  MCP_SECRET_NAME_RE,
  MCP_SECRET_SET_CHANNEL,
  mcpSecretKey,
  type McpSecretMutationResult,
  type McpSecretsListResult,
} from "../shared/mcp-secrets.js";
import type { SecretKey } from "../shared/settings.js";
import { redactSecrets } from "@anycode/core/mcp-admin";

/** The vault surface these handlers need (structural; `Vault` satisfies it). */
export interface McpSecretsVault {
  setSecret(
    key: SecretKey,
    value: string,
    opts: { allowWeak: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: "weak_storage_needs_consent" }>;
  clearSecret(key: SecretKey): Promise<void>;
  listMcpSecretNames(): Promise<string[]>;
}

export interface McpSecretsIpcDeps {
  vault: McpSecretsVault;
  /** `settings.security.allowWeakSecretStorage`, read at call time. */
  allowWeak(): Promise<boolean> | boolean;
  /** Fired after a successful set/delete (refreshes the main-side fork-secret cache). */
  onMutation(): Promise<void> | void;
}

const nameSchema = z.string().regex(MCP_SECRET_NAME_RE);
const setSchema = z
  .object({
    name: nameSchema,
    value: z.string().min(1).max(8192),
  })
  .strict();
const deleteSchema = z.object({ name: nameSchema }).strict();

/** Logs a fixed line with the error message, the submitted value redacted from it. */
function logFailure(action: string, error: unknown, secretValues: readonly string[]): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[mcp-secrets] ${action} failed: ${redactSecrets(message, secretValues)}`);
}

async function namesAfterMutation(deps: McpSecretsIpcDeps): Promise<McpSecretMutationResult> {
  try {
    await deps.onMutation();
  } catch (error) {
    logFailure("refresh", error, []);
  }
  return { ok: true, names: await deps.vault.listMcpSecretNames() };
}

export async function handleMcpSecretsList(deps: McpSecretsIpcDeps): Promise<McpSecretsListResult> {
  return { ok: true, names: await deps.vault.listMcpSecretNames() };
}

export async function handleMcpSecretSet(deps: McpSecretsIpcDeps, raw: unknown): Promise<McpSecretMutationResult> {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { name, value } = parsed.data;
  try {
    const result = await deps.vault.setSecret(mcpSecretKey(name), value, { allowWeak: await deps.allowWeak() });
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return await namesAfterMutation(deps);
  } catch (error) {
    logFailure("set", error, [value]);
    return { ok: false, reason: "io_error" };
  }
}

export async function handleMcpSecretDelete(deps: McpSecretsIpcDeps, raw: unknown): Promise<McpSecretMutationResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    await deps.vault.clearSecret(mcpSecretKey(parsed.data.name));
    return await namesAfterMutation(deps);
  } catch (error) {
    logFailure("delete", error, []);
    return { ok: false, reason: "io_error" };
  }
}

/** Registers the three handlers on `ipcMain`. */
export function registerMcpSecretsIpc(deps: McpSecretsIpcDeps): void {
  ipcMain.handle(MCP_SECRETS_LIST_CHANNEL, () => handleMcpSecretsList(deps));
  ipcMain.handle(MCP_SECRET_SET_CHANNEL, (_event, raw: unknown) => handleMcpSecretSet(deps, raw));
  ipcMain.handle(MCP_SECRET_DELETE_CHANNEL, (_event, raw: unknown) => handleMcpSecretDelete(deps, raw));
}
