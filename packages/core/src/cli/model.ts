/**
 * `/model` mechanics (design slice-4.6-cut.md §2.1): the live model-switch port
 * wrapper, a catalog-by-endpoint matcher for show-hints, and the pure string
 * formatter both `/model` (cli/commands.ts) and the boot wiring (cli/main.ts)
 * consume. No module outside cli/ imports from here except commands.ts/main.ts
 * (L6: cli -> core is the legal direction; this file itself only reaches back
 * into core type-only plus the one normalizeAnthropicBaseUrl value import).
 */

import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { CatalogModel, CatalogProviderEntry, ProviderCatalog } from "../provider/catalog.js";
import { normalizeAnthropicBaseUrl } from "../provider/anthropic.js";

/**
 * Transparent delegate port with hot-swappable underlying port BETWEEN turns

 * and titling all capture by reference at boot — replacing the underlying port
 * is instantly visible to every holder without re-wiring. `streamText` is a
 * pure delegate: zero buffering, zero call-counting, zero double-subscription

 * it would directly). Reading `current` happens at call time, so a `setPort`
 * between two `streamText` calls routes the very next call into the new port;
 * mid-flight port swaps are impossible by construction (a single call's
 * `streamText` already closed over its target port; the REPL dispatches
 * commands and turns strictly sequentially, mirroring the mode invariant at
 * loop/agent-loop.ts:165).
 */
export class SwitchableModelPort implements ModelPort {
  private current: ModelPort;

  constructor(initial: ModelPort) {
    this.current = initial;
  }

  /** Replaces the underlying port for all subsequent `streamText` calls. */
  setPort(next: ModelPort): void {
    this.current = next;
  }

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return this.current.streamText(request);
  }
}

/**
 * Matches a catalog entry by its endpoint (for `/model` show-hints, design
 * §2.1). Both the target and each candidate `baseUrl` are normalized with
 * `normalizeAnthropicBaseUrl` before comparison, so a trailing slash or a
 * missing `/v1` suffix does not defeat the match. The `custom` entry (empty
 * `baseUrl`) is always skipped BEFORE normalizing it — `normalizeAnthropicBaseUrl`

 * "this is the endpoint the caller is on" anyway. No match => `undefined`.
 */
export function matchCatalogEntryByBaseUrl(
  catalog: ProviderCatalog,
  baseUrl: string,
): CatalogProviderEntry | undefined {
  const normalizedTarget = normalizeAnthropicBaseUrl(baseUrl);
  return catalog.providers.find((entry) => {
    if (entry.baseUrl === "") {
      return false;
    }
    return normalizeAnthropicBaseUrl(entry.baseUrl) === normalizedTarget;
  });
}

/**
 * Renders the `/model` show-lines (pure, testable; design §2.1). Always
 * emits the current-model line; the second line depends on whether a catalog
 * entry matched AND carries at least one static model hint:
 *
 *   [model] <current>
 *   [model] provider: <Name> — models: id1, id2, id3 (switch: /model <id>)   — matched, non-empty models
 *   [model] switch: /model <model-id> (any model id accepted)                — otherwise
 *
 * Every line is newline-terminated (mirror of the renderXxxTable convention in
 * cli/render.ts) so callers can `write(formatModelInfo(...))` directly.
 */
export function formatModelInfo(current: string, entry: CatalogProviderEntry | undefined): string {
  const lines = [`[model] ${current}`];
  if (entry !== undefined && entry.models.length > 0) {
    const ids = entry.models.map((model) => model.id).join(", ");
    lines.push(`[model] provider: ${entry.name} — models: ${ids} (switch: /model <id>)`);
  } else {
    lines.push("[model] switch: /model <model-id> (any model id accepted)");
  }
  return lines.join("\n") + "\n";
}
