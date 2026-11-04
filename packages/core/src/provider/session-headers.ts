/**
 * Session-header resolution for catalog entries that declare `headers`
 * templates (OpenCode Go is the first reader of the previously dead
 * `CatalogProviderEntry.headers` field).
 *
 * The templates carry `{sessionId}` / `{version}` tokens; this helper is
 * called ONCE per boot (CLI run or desktop host fork) so every request of one
 * conversation carries the same values — subagents (which reuse the parent
 * port) and /model hot-swaps (which rebuild through the same factory)
 * included. An entry without `headers` resolves to undefined, which every
 * EndpointConfig construction site already treats as "spread nothing" —
 * byte-identical to the pre-helper behaviour.
 */

import type { CatalogProviderEntry } from "./catalog.js";

/** User-agent fallback when the host does not stamp a version into the env. */
const FALLBACK_VERSION = "dev";

export function resolveProviderHeaders(
  entry: CatalogProviderEntry | undefined,
  sessionId: string,
  appVersion?: string,
): Record<string, string> | undefined {
  if (entry?.headers === undefined) {
    return undefined;
  }
  const version = appVersion ?? FALLBACK_VERSION;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.headers)) {
    resolved[key] = value.replaceAll("{sessionId}", sessionId).replaceAll("{version}", version);
  }
  return resolved;
}

/**
 * The `user-agent` a config explicitly declares, if any (case-insensitive
 * key, like the factories' Authorization handling).
 */
export function declaredUserAgent(headers: Record<string, string> | undefined): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === "user-agent") {
      return value;
    }
  }
  return undefined;
}

/**
 * Enforces an explicitly declared `user-agent` on the wire. The AI SDK's
 * `withUserAgentSuffix` unconditionally APPENDS its own markers
 * (`ai-sdk/<provider>/<version> ... runtime/...`) to whatever user-agent the
 * caller supplies, so a config-declared agent string can never reach the wire
 * through the SDK's header path alone — and endpoints that require a specific
 * non-SDK agent identity (OpenCode Go) reject or misclassify the suffixed
 * value. This wrapper is the one interception point the SDK cannot decorate
 * (the transport factories install it as their `fetch`), rewriting the
 * outgoing header to exactly the declared value.
 */
export function wrapFetchWithUserAgent(fetchImpl: typeof fetch, userAgent: string): typeof fetch {
  return (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    requestHeaders.set("user-agent", userAgent);
    return fetchImpl(input, { ...init, headers: requestHeaders });
  };
}
