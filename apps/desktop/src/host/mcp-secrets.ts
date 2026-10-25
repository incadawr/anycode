/**
 * Host side of the MCP secret hand-off (Taskana 4752, part C). The host forks with
 * no vault access: main puts `{NAME: value}` for the workspace's referenced
 * secrets in `ANYCODE_MCP_SECRETS`. The host reads that once (boot.ts's MCP load),
 * deletes it, and builds a resolver. The resolver's closure is the only holder of
 * the values: nothing stores them on a global, logs them, or emits them.
 */

import type { McpSecretResolver } from "@anycode/core/mcp-admin";
import { ENV_MCP_SECRETS, MCP_SECRET_NAME_RE } from "../shared/mcp-secrets.js";

const mcpSecretNameOk = (name: string): boolean => MCP_SECRET_NAME_RE.test(name);

/**
 * Reads the hand-off from `env` and DELETES the var in the same step, so no child
 * spawned after this point can inherit it. Returns the resolver built from the value.
 */
export function takeMcpSecretsEnv(env: NodeJS.ProcessEnv): McpSecretResolver {
  const raw = env[ENV_MCP_SECRETS];
  delete env[ENV_MCP_SECRETS];
  return parseMcpSecretsEnv(raw);
}

/**
 * Builds the resolver from the raw env value. A bad or non-object payload resolves
 * nothing (boot continues; the affected servers fail closed with the name-only
 * message). Lookup is an own-property check on a null-prototype map, so a name such
 * as `__proto__` or `constructor` never resolves through the prototype chain.
 */
export function parseMcpSecretsEnv(raw: string | undefined): McpSecretResolver {
  const table = new Map<string, string>();
  if (raw !== undefined && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          if (typeof value === "string" && mcpSecretNameOk(name)) {
            table.set(name, value);
          }
        }
      }
    } catch {
      // bad JSON: resolve nothing.
    }
  }
  return (name: string) => (mcpSecretNameOk(name) ? table.get(name) : undefined);
}
