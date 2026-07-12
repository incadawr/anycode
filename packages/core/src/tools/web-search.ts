/**
 * WebSearch tool (design slice-6.3-cut.md §2-B2): a factory closing over a

 * thin GET through the existing HttpPort.fetchText: build the backend's
 * search URL, fetch, defensively parse the backend-shaped JSON, cap and
 * return. Every failure path (network/status/size/shape) degrades to an


 */

import type { ResolvedWebSearchBackend } from "../websearch/index.js";
import { buildSearchUrl, parseSearchResults } from "../websearch/index.js";
import {
  WEBSEARCH_MAX_BYTES,
  WEBSEARCH_MAX_OUTPUT_BYTES,
  WEBSEARCH_MAX_RESULTS,
  WEBSEARCH_TIMEOUT_MS,
} from "../types/config.js";
import type { HttpTextResponse } from "../ports/http.js";
import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { webSearchInputSchema, type WebSearchInput, type WebSearchOutput } from "./schemas.js";

/**
 * Metadata mirrors the WebFetch class verbatim (readOnly/network/ask, design

 */
export function createWebSearchTool(
  backend: ResolvedWebSearchBackend,
): ToolDefinition<WebSearchInput, WebSearchOutput> {
  const metadata: ToolMetadata = {
    name: "WebSearch",
    description:
      "Search the web via the configured search backend and return result titles, URLs and snippets.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    riskLevel: "medium",
    sideEffectScope: "network",
    // Network tool: escalates allow -> ask in plan/build/edit (mirror of WebFetch, design §2.8).
    needsApproval: true,
    timeoutMs: WEBSEARCH_TIMEOUT_MS,
    maxOutputBytes: WEBSEARCH_MAX_OUTPUT_BYTES,
  };

  return {
    metadata,
    inputSchema: webSearchInputSchema,
    handler: async (input, ctx) => {
      const count = Math.min(input.max_results ?? backend.maxResults, WEBSEARCH_MAX_RESULTS);
      const url = buildSearchUrl(backend, input.query, count);

      let response: HttpTextResponse;
      try {
        response = await ctx.ports.http.fetchText({
          url,
          headers: backend.headers,
          timeoutMs: metadata.timeoutMs,
          maxBytes: WEBSEARCH_MAX_BYTES,
          abortSignal: ctx.abortSignal,
        });
      } catch (err) {
        // Fetch-level failures (DNS/connect/abort) carry no headers or body to leak.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (response.truncated) {
        return { ok: false, error: `WebSearch: ${backend.kind} response exceeded the size cap` };
      }

      if (response.status !== 200) {

        const hint =
          response.status === 401 || response.status === 403
            ? " (check the API key env var)"
            : response.status === 429
              ? " (rate limited)"
              : "";
        return {
          ok: false,
          error: `WebSearch: ${backend.kind} returned HTTP ${response.status} ${response.statusText}${hint}`,
        };
      }

      const parsed = parseSearchResults(backend.kind, response.body);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const results = parsed.results.slice(0, count);
      const truncated = parsed.results.length > count;

      return {
        ok: true,
        output: { backend: backend.kind, query: input.query, results, truncated },
      };
    },
  };
}
