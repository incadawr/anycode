/** Barrel for the hand-written WebSearch core (slice 6.3 Wave A). */

export { loadWebSearchConfig, webSearchConfigSchema } from "./config.js";
export type { LoadedWebSearchConfig, ResolvedWebSearchBackend, WebSearchConfigEntry } from "./config.js";
export { buildSearchUrl, parseSearchResults } from "./backends.js";
export type { ParsedSearchResults } from "./backends.js";
