/**
 * WebSearch backend helpers (slice 6.3 Wave A, design slice-6.3-cut.md §2-A3):
 * a pure URL builder and a defensive response parser per backend (`brave` |
 * `searxng`). Both are pure functions — no I/O, no ports — so they stay
 * trivially testable and reusable from the tool handler (Wave B).
 *
 * `WebSearchResultItem` is owned by tools/schemas.ts (Wave B, design §2-B1);
 * imported here rather than duplicated to avoid two competing definitions.
 */

import { WEBSEARCH_SNIPPET_MAX_CHARS } from "../types/config.js";
import type { ResolvedWebSearchBackend } from "./config.js";
import type { WebSearchResultItem } from "../tools/schemas.js";

/**
 * brave: `<endpoint>?q=&count=` (default endpoint
 * https://api.search.brave.com/res/v1/web/search); searxng:
 * `<endpoint>/search?q=&format=json` (endpoint is the instance base; a
 * trailing slash is tolerated). Built via `new URL(...)` + `searchParams.set`
 * — the query is always ONE percent-encoded param; the key never enters the

 */
export function buildSearchUrl(backend: ResolvedWebSearchBackend, query: string, count: number): string {
  if (backend.kind === "brave") {
    const url = new URL(backend.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    return url.toString();
  }

  // Parse first so an endpoint carrying its own query string (e.g. a reverse
  // proxy needing `?instance=x`) is not corrupted by naive string
  // concatenation of "/search" onto the end of the raw endpoint string.
  const endpointUrl = new URL(backend.endpoint);
  const pathname = endpointUrl.pathname.replace(/\/+$/, "");
  const url = new URL(`${endpointUrl.origin}${pathname}/search`);
  for (const [key, value] of endpointUrl.searchParams) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  return url.toString();
}

export type ParsedSearchResults = { ok: true; results: WebSearchResultItem[] } | { ok: false; error: string };

function capSnippet(text: string): string {
  return text.length > WEBSEARCH_SNIPPET_MAX_CHARS ? text.slice(0, WEBSEARCH_SNIPPET_MAX_CHARS) : text;
}

/** Extracts well-shaped items from a results array; skips entries whose title/url are not strings. Returns undefined when `raw` is not an array at all (caller reports ok:false). */
function extractItems(raw: unknown, snippetKey: "description" | "content"): WebSearchResultItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = record.title;
    const url = record.url;
    if (typeof title !== "string" || typeof url !== "string") continue;
    const snippetRaw = record[snippetKey];
    items.push({ title, url, snippet: typeof snippetRaw === "string" ? capSnippet(snippetRaw) : "" });
  }
  return items;
}

/**
 * Defensive narrowing (no zod-throw): brave `web.results[].{title,url,description}`,
 * searxng `results[].{title,url,content}` (field names pinned against current
 * public API docs — see report). Non-object body / missing results array =>

 * response body degrades to an honest error, not a crash.
 */
export function parseSearchResults(kind: "brave" | "searxng", body: string): ParsedSearchResults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      error: `WebSearch: could not parse ${kind} response as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: `WebSearch: ${kind} response was not a JSON object` };
  }

  if (kind === "brave") {
    const web = (parsed as { web?: unknown }).web;
    const rawResults = web && typeof web === "object" ? (web as { results?: unknown }).results : undefined;
    const items = extractItems(rawResults, "description");
    if (items === undefined) {
      return { ok: false, error: `WebSearch: brave response missing "web.results" array` };
    }
    return { ok: true, results: items };
  }

  const rawResults = (parsed as { results?: unknown }).results;
  const items = extractItems(rawResults, "content");
  if (items === undefined) {
    return { ok: false, error: `WebSearch: searxng response missing "results" array` };
  }
  return { ok: true, results: items };
}
