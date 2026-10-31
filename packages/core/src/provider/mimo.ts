/**
 * Xiaomi MiMo wire-mapping helper.
 *
 * MiMo speaks the Anthropic-messages protocol. Its documentation
 * (mimo.mi.com, accessed 2026-10-31) lists only `thinking.type` (enabled by
 * default) — no thinking budget, no effort vocabulary.
 *
 * Direct-API measurement (mimo-v2.6-pro, hard no-tool prompt, 2 reps per cell)
 * shows how the endpoint actually behaves:
 *
 *   - `thinking.budget_tokens` is IGNORED: the old `enabled` + budget bytes
 *     produced the same amount of reasoning at low (22.6k output tokens) and
 *     high (20.1k);
 *   - `output_config.effort` IS honoured: `low` 28.7k vs `high` 48.0k output
 *     tokens with no budget key (~1.7x).
 *
 * So a MiMo reasoning request carries the effort enum and NO thinking key,
 * exactly like MiniMax. Only the measured values `low` and `high` are ever
 * emitted; the mapping lives in `reasoningRequestOptions` (model-port.ts).
 *
 * `providerName` is the CATALOG ENTRY NAME (the wiring layer sets it from
 * `catalogEntry.name`), so the names are matched by prefix and pinned by a
 * test — renaming an entry's display name without updating this helper would
 * silently disable the mapping.
 */
export function isMiMoModel(providerName?: string, modelId?: string): boolean {
  return (providerName === "Xiaomi MiMo API" || providerName?.startsWith("Xiaomi MiMo Token Plan (") === true)
    && /^(mimo-v2\.6-pro|mimo-v2\.6-flash)$/.test(modelId ?? "");
}
