# Reasoning history (thinking replay) — per-provider support

Reasoning replay sends a model's own reasoning output (Anthropic `thinking`
blocks, Chat Completions `reasoning_content` / `reasoning_details`) back to the
provider as part of the conversation history on later turns of the same
session. Whether a provider accepts this — and whether it silently ignores the
replayed blocks — is a provider-side fact. This table records, per provider,
what AnyCode does today, the wire field involved, the provider documentation,
and whether a direct-API measurement backs the claim.

Rule (same discipline as the reasoning-effort matrix): a provider is only
listed as supporting replay when BOTH (1) its documentation describes the
replay field and (2) a direct-API measurement shows replayed reasoning reaches
the model. A provider with only a documentation citation stays OFF in the
catalog; enabling it later is a one-line `preserveReasoning` flag flip plus a
matrix run.

## What AnyCode does

- The replay gate is `reasoningReplaySource` in
  `packages/core/src/provider/model-port.ts`: replay runs only for the
  `anthropic-messages` and `openai-chat-completions` transports
  (`openai-responses` is out of scope — with `store: false` its reasoning items
  would need encrypted content), and only when the catalog entry sets
  `preserveReasoning: true` or a connection-level override says so.
- Modes (`ANYCODE_REASONING_HISTORY`): unset = full replay of the original
  reasoning (the default), `none` = replay off, `factual_N` = replay a compacted
  factual summary instead. These modes are env-only; they do not change WHICH
  provider accepts replay, only WHAT is replayed.
- Overrides, most specific wins:
  1. the shell env `ANYCODE_PRESERVE_REASONING` (`true`/`false`) — always wins;
  2. the connection's persisted `preserveReasoning` choice (Settings →
     Provider → connection drawer, "Reasoning replay" select; shown for custom
     endpoints and vLLM);
  3. the catalog entry's `preserveReasoning` flag.
  A catalog provider whose entry has no flag can never be enabled by the
  override path (the catalog gate runs first); an explicit `false` DOES disable
  replay on an entry whose own flag is on.
- Wire shapes (packages/core/src/provider/sdk-mapping.ts): Anthropic messages
  replay the assistant `thinking` block plus
  `providerMetadata.anthropic.signature` (an unsigned replay adds
  `signature: ""`); Chat Completions replay `reasoning_content` (and add an
  empty one on a tool-call message that carried none); OpenRouter additionally
  carries `reasoning_details`.

## Support table

"Matrix" = direct-API measurement of 2026-11-02 (see below). "Not measured"
means no key was available; those rows must not be read as support claims.
Cells marked "inferred" are extrapolations from a measured host of the same
vendor or family — they are not measurements on that host.

| Provider (catalog entry) | Transport · wire field | Replay in AnyCode | Doc source | Matrix result |
|---|---|---|---|---|
| Z.AI (GLM) | anthropic-messages · assistant `thinking` + `signature` | On (full replay) | measured directly on the live endpoint (2026-11-02 matrix, provenance below) | all replay variants HTTP 200; replayed thinking grows input tokens (208 vs 187 when dropped); signature not validated |
| DeepSeek | anthropic-messages · assistant `thinking` + `signature` | On (full replay) | measured directly on the live endpoint (2026-11-02 matrix, provenance below) | variants a/c/d HTTP 200; signature (36 chars) not validated; input-token growth NOT recorded on this host (only z.ai and MiniMax International have token evidence) |
| MiniMax (International, `minimax`) | anthropic-messages · assistant `thinking` + `signature` | On (full replay) | measured directly on the live endpoint (2026-11-02 matrix, provenance below) | variants a/b/b2/c/d all HTTP 200; signature (64 chars) not validated; replayed thinking grows input tokens (135 vs 54 when dropped) |
| MiniMax (China, `minimax-cn`) | anthropic-messages · assistant `thinking` + `signature` | On (full replay) | same vendor as International — inferred, not measured on this host | not measured on this host (`api.minimaxi.com` was not probed) — inferred from the same vendor (International endpoint measured) |
| Xiaomi MiMo (`xiaomi-mimo-api/sgp/cn/ams`) | anthropic-messages · assistant `thinking` (MiMo sends NO signature) | On (full replay) | measured on the SGP token plan only — inferred for the other hosts, not measured here | SGP token plan (mimo-v2.6-pro): all variants HTTP 200, nothing to validate. `api.xiaomimimo.com` and token-plan-cn/ams: not measured — inferred from the same vendor |
| OpenRouter | openai-chat-completions · `reasoning_content` + `reasoning_details` | On (full replay) — flag predates this evidence pass and stays unmeasured (fails criterion 2 of the rule above) | [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), "Preserving Reasoning": pass `reasoning_details` (alias `reasoning` / `reasoning_content`) back on Chat Completions, sequence unmodified | not measured — no matrix exists for OpenRouter |
| Anthropic | anthropic-messages · `thinking` + `signature` | Off (catalog flag unset) | [Preserving thinking blocks](https://platform.claude.com/docs/en/build-with-claude/thinking): pass every thinking block back "complete and unmodified"; "Modified thinking blocks are rejected with a 400 error"; the signature is validated; Claude 5.1+ adds prefix checks on preserved thinking | not measured — no API key in the smoke-secret set |
| Moonshot (platform API) | anthropic-messages · `thinking` | Off (catalog flag unset) | [Kimi thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models): `reasoning_content` on Chat Completions; "pass the complete assistant message returned by the API back to messages as-is (including reasoning_content)"; `thinking: { keep: "all" }` (K2.6), always-on for K2.7-Code/K3/K3.1 — documented for the `/v1` Chat Completions route, NOT for the `/anthropic` transport this entry uses | not measured — no API key |
| Kimi subscription (`kimi`, kimi.com) | anthropic-messages · `thinking` | Off (catalog flag unset) | same doc family as Moonshot, different product/endpoint | not measured — no API key |
| OpenAI | openai-responses | Off — the transport is out of scope for replay (`store: false` would need encrypted reasoning content) | — | n/a |
| vLLM | openai-chat-completions · `reasoning_content` | Per-connection — Off by default, opt in with the drawer's "Reasoning replay" select or `ANYCODE_PRESERVE_REASONING` | server-dependent | not measured — deployment-dependent |
| Custom endpoint | any transport · `thinking` / `reasoning_content` | Per-connection — same as vLLM | endpoint-dependent | not measured — endpoint-dependent |

Note on the matrix rows: "replay accepted" means the continuation returned
HTTP 200 AND input tokens grew when thinking was replayed — i.e. the blocks
reached the model, not merely that the endpoint tolerated them. Token growth
was recorded for z.ai and MiniMax International only; the DeepSeek and MiMo
cells record HTTP 200 responses only, so their "blocks reach the model"
evidence is weaker. No measured provider validated the thinking signature;
MiMo does not send one at all. The
matrix is single-repetition per cell and its own notes say token differences
are within noise; it does NOT support changing any default
`ANYCODE_REASONING_HISTORY` mode.

## How to check a provider yourself

The probe used for the matrix (one `read_file` tool, direct API, key sourced
from the smoke-secret set and never printed):

1. **First call** — ask for something that needs the tool. The response's
   assistant message should contain a thinking/reasoning part plus a
   `tool_use` call. If there is no reasoning part, replay cannot be tested.
2. **Continuation** — send `tool_result` plus the assistant message replayed in
   two variants:
   - (a) the ORIGINAL thinking block with its original signature — the
     well-behaved replay AnyCode performs;
   - (d) the assistant message with thinking dropped — the baseline.
3. **Compare** status code and input tokens between (a) and (d):
   - both 200 and (a) uses MORE input tokens → the provider accepts and
     consumes replayed reasoning (the strongest result in the table);
   - 200 with equal input tokens → replayed blocks are silently dropped;
     replay is pointless but harmless;
   - 400 on (a) → the provider validates signatures/modifications (the
     Anthropic documented behaviour); unsigned replay (AnyCode's
     `replayUnsigned` adds `signature: ""`) may still work — try variant (b2),
     original text with `signature: ""`.
4. Repeat 2–3 times per variant: single requests are noise.

For a Chat Completions endpoint the same probe applies with
`reasoning_content` in place of the thinking block.

## Measurement provenance

- Matrix (Z.AI, DeepSeek, MiniMax, MiMo), variants and token evidence:
  measured 2026-11-02 against the live direct APIs; full notes in the local
  provider-reasoning wire reference (not committed — `working-docs/` is
  gitignored).
- Anthropic and Moonshot citations were read from the provider documentation
  pages linked above; no direct-API measurement exists for them in this
  repository's smoke-secret set (no keys), so their catalog flags stay off.
