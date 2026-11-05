import { resolveOpenCodeGoEndpointPolicy } from "@anycode/core";
import type { ProviderConnection } from "../shared/settings.js";

/** Undefined means the connection is on the manual transport ladder. */
export function automaticGoRoute(connection: ProviderConnection | undefined, env: NodeJS.ProcessEnv): ReturnType<typeof resolveOpenCodeGoEndpointPolicy> | undefined {
  if (!connection || (connection.providerId !== "opencode" && connection.providerId !== "opencode-openai")) return undefined;
  if (env.ANYCODE_BASE_URL?.trim() || env.ANYCODE_PROVIDER_TRANSPORT?.trim() || connection.baseUrl?.trim() || connection.transport?.trim()) return undefined;
  return resolveOpenCodeGoEndpointPolicy(connection.providerId, env.ANYCODE_MODEL?.trim() || connection.model || "", connection.modelRoutes);
}
