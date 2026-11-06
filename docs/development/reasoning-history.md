# Reasoning history (thinking replay) — per-provider support

Reasoning replay sends a model's own reasoning output (Anthropic `thinking`
blocks, Chat Completions `reasoning_content` / `reasoning_details`, Responses encrypted reasoning items) back to the
provider as part of the conversation history on later turns of the same
session. Whether a provider accepts this — and whether it silently ignores the
replayed blocks — is a provider-side fact. This table records, per provider,
what AnyCode does today, the wire field involved, the provider documentation,
and whether a direct-API measurement backs the claim.

Replay defaults on for all three transports when the model returns a replayable form. This
is an application policy, not a claim that every provider accepts or consumes
replayed reasoning. The existing measurements below retain their original
scope; unmeasured endpoints remain unverified. The catalog may record explicit
`preserveReasoning: false` exceptions with confirmed evidence; none are set.

Desktop can record validated rejection observations and restore Auto-off for the
same endpoint and model. The drawer shows `Auto (off: provider rejected)`;
saving On clears that model's remembered rejection. Main resolves the emitting
tab's pinned connection and rechecks current endpoint and explicit preference
under the settings lock. In Auto, an input-reasoning rejection before output
triggers one corrective request without replay and one fixed transcript notice.
A body-less 400 qualifies only on the port's first request with serialized replay;
transient retries do not rearm it. Auth, permission, quota, rate, missing-model and
context failures take precedence; output-thinking configuration errors alone do
not qualify. Explicit On/Off (including shell choices) never self-correct.
The port remembers the rejection immediately while main persists it. Correction
preserves generation options, tools, tool results and the original include_usage
option: a pending usage probe is rolled back first. A second corrective 4xx is
surfaced normally and cannot launch another usage probe. Transient retry budgets
remain independent. The same correction also covers Responses encrypted reasoning.

Responses streaming also accepts initial `output_text` / `reasoning_text` segments
in `response.content_part.added`, and supplies missing item starts for text and
reasoning deltas (including summaries). Populated added parts (also summary parts)
retain per-key prefix progress across deltas and repeated added events. Matching
short deltas are held until the entire preview repeats or the text diverges;
then one reconciled delta emits the preview and any continuation. Done-only text
uses this same delta source, preventing independent reasoning recovery from
replaying it. A partial match is contained in the preview, which is flushed at
part/item completion or stream end. Declared items and parts cannot borrow another
key's preview. An explicit unknown item owns a separate key; a missing part index
uses the single open part of that kind. An undeclared index may alias a single
held preview of the same item, but never another explicitly declared part.
An extended preview retains prefix progress and holds only its unconsumed tail;
a preview contradicting emitted text is ignored. Before emission, a divergent
preview flushes the previous preview first.
A legitimate continuation starting with the same characters is indistinguishable
from a repeated preview, so an intentional repeated prefix can still collapse.
An omitted delta `item_id` is resolved
through a known `output_index`, then a single open/compatible owner of its kind,
otherwise a stream-local fallback is used. Later identified done events share
that fallback key when ownership is unambiguous. Completion markers survive
part completion so repeated done events cannot replay text.
Whitespace-only Responses text blocks are withheld; leading whitespace is kept
once visible text arrives. Empty or whitespace-only text parts are omitted from
new assistant history and from the desktop history projection. These compatibility
paths are fixture-tested; they do not establish which shape a live gateway emits.
Text-only reasoning recovery does not enable replay without encrypted content.

## What AnyCode does

- The replay gate is `reasoningReplaySource` in
  `packages/core/src/provider/model-port.ts`: replay runs only for the
  `anthropic-messages`, `openai-chat-completions` and `openai-responses` transports,
  and defaults on unless a per-model override
  or explicit catalog exception disables it. The same endpoint and model must have produced the reasoning.
- Modes (`ANYCODE_REASONING_HISTORY`): unset = full replay of the original
  reasoning (the default), `none` = replay off, `factual_N` = replay a compacted
  factual summary instead. These modes are env-only and apply to OpenCode Go
  routes too. `none` disables replay regardless of the override ladder below.
- Overrides, most specific wins:
  1. the shell env `ANYCODE_PRESERVE_REASONING` (`true`/`false`) — always wins;
  2. the selected model's persisted `modelOverrides[model].preserveReasoning` choice (Settings →
     Provider → connection drawer, "Reasoning replay" select; shown for all connections);
  3. a remembered provider rejection for this endpoint and model disables Auto;
  4. an explicit catalog `preserveReasoning: false` exception; absent = replay on.
  An explicit On or Off overrides the catalog policy for the selected model.
  Auto clears only that model's preference. Legacy connection preferences migrate
  to the selected model; other models keep their own defaults. This precedence
  also applies in switched-core runtimes and their inline children.
- Wire shapes (packages/core/src/provider/sdk-mapping.ts): Anthropic messages
  replay the assistant `thinking` block plus
  `providerMetadata.anthropic.signature` (an unsigned replay adds
  `signature: ""`); Chat Completions replay `reasoning_content` (and add an
  empty one on a tool-call message that carried none); OpenRouter additionally
  carries `reasoning_details`.

## Support table

Auto enables replay for every endpoint/model with a supported wire form, with one
corrective retry on an eligible rejection and remembered rejection for that route.
The per-model On/Off choice overrides Auto; `ANYCODE_PRESERVE_REASONING` is senior
(the `none` history mode still disables replay). Policy is separate from measured
acceptance. All rows below use this policy, including unmeasured endpoints.

Live core-port run: **2026-11-07**, one first step with reasoning + a tool call,
then the same continuation with Auto and Off. “200” below means the core port completed successfully. For Auto, the observer
also saw reasoning on the continuation wire; Off does not require reasoning.
Input counts are Auto / Off, without inference about attention or answer quality.
No live corrective retry fired; remembered-rejection behaviour remains covered
by deterministic tests, not established by this run.

| Provider · model | Host · transport | Live outcome · input tokens Auto / Off |
|---|---|---|
| Z.AI · glm-5.3-flash | api.z.ai · Anthropic | 200 / 200; 224 / 207 |
| DeepSeek · deepseek-flash | api.deepseek.com · Anthropic | 200 / 200; 382 / 382 |
| MiniMax · MiniMax-M3.1-Flash | api.minimax.io · Anthropic | not measured: first step 429; plan key, stopped immediately; no PAYG fallback |
| MiMo · mimo-v2.6-flash | token-plan-sgp.xiaomimimo.com · Anthropic | 200 / 200; 157 / 157 |
| OpenRouter · deepseek/deepseek-v4.1-flash | openrouter.ai · Chat Completions | 200 / 200; 405 / 363 |
| Responses · openai/gpt-5-mini | openrouter.ai · Responses | not measured: POST /api/v1/responses returned 404 on first step with encrypted-output include and store:false; no available Responses endpoint established |
| Go free control · beam-free | opencode.ai · Chat Completions | 200 / 200; 161 / 151 |
| Go · deepseek-v4.1-flash | opencode.ai · both doors | not measured: one-day key allows free Chat Completions only; family has no zero-price catalog model |
| Go · glm-5.3-flash | opencode.ai · both doors | not measured: same key restriction; no zero-price family model |
| Go · kimi-k2.7-code | opencode.ai · both doors | not measured: same key restriction; no zero-price family model |
| Go · minimax-m3.1-flash | opencode.ai · both doors | not measured: same key restriction; no zero-price family model |
| Go · qwen3.8-flash | opencode.ai · both doors | not measured: same key restriction; no zero-price family model |
| Go · mimo-v2.6-flash | opencode.ai · both doors | not measured: same key restriction; no zero-price family model |
| MiniMax China | api.minimaxi.com · Anthropic | not measured on this host |
| MiMo API / CN / AMS | other MiMo hosts · Anthropic | not measured on these hosts |
| Anthropic / Moonshot / Kimi subscription | respective catalog hosts · Anthropic | not measured: no smoke keys |
| OpenAI direct / other Responses gateways | respective hosts · Responses | not measured: no direct OpenAI key or other Responses endpoint in this run |
| vLLM / custom endpoints | deployment-dependent · any supported transport | not measured |

Earlier **2026-11-02 direct-API** measurements remain separate evidence:
Z.AI glm-5.2/5.3 accepted original signed thinking (200), input 208 / 187;
MiniMax International M3.1-Flash accepted it (200), input 135 / 54;
DeepSeek deepseek-flash and MiMo SGP mimo-v2.6-pro accepted it (200), with no
input-token comparison recorded. Those probes did not validate signatures and
do not establish behaviour on other hosts. The new MiniMax 429 does not
supersede its earlier acceptance result. Equal token counts in a single pair
(DeepSeek and MiMo here) do not prove replay is discarded.

## Responses encrypted reasoning

Auto requests `include: ["reasoning.encrypted_content"]` so a later step can
return the encrypted reasoning. Same-source items retain their order among
function calls and results. The SDK maps `openai.itemId` and
`openai.reasoningEncryptedContent` metadata back into reasoning items, including
items with empty text. Foreign endpoint/model items and items without encrypted
content are stripped independently, without dropping tool calls or results.

Explicit Off, `none`, remembered rejection and `factual_N` omit reasoning items
and the encrypted-output include flag. `store: false` remains unconditional,
including with Off: AnyCode owns history locally and must not create server-side
persistence. The SDK's automatic encrypted include for known reasoning models is
removed when replay is disabled. Auto requests encrypted output even on the first
step and for unfamiliar gateway model names.

In Auto, a parameter rejection naming `include` or `reasoning.encrypted_content`
triggers the single corrective retry even on the first step without input reasoning.
The retry omits include and reasoning, preserves other options, emits one notice
and diagnostic, and remembers rejection for later requests. Explicit On and shell
overrides do not self-correct. Correction never follows output or external abort.
The Chat Completions include_usage probe does not run on Responses.

Text-only `reasoning_text` output cannot replay on Responses: no accepted
stateless plain-text input form is known or verified. AnyCode does
not invent one or send plain reasoning as an encrypted item. Recovered content
text is retained for display but never converted into a summary for replay. `factual_N` also
cannot replay on Responses: a compacted summary cannot replace original opaque
encrypted reasoning, so that mode disables Responses replay rather than sending
the original full reasoning. Text remains available for display. These are wire
limitations, including with explicit On. Fake SSE/request tests cover encrypted
metadata capture, serialization and one-shot correction; live Responses acceptance and
model consumption remain unverified (the available gateway returned 404).

## How to check a provider yourself

Run from the repository root with dependencies installed:

```sh
node apps/desktop/scripts/reasoning-replay-live-matrix.mjs --live
node --test apps/desktop/scripts/reasoning-replay-live-matrix.test.mjs
```

The script imports the production `AiSdkModelPort` and `ReasoningCapture` using
the core package's tsx loader. It does not launch Electron or hand-build HTTP
requests. A fetch observer records statuses and field-presence flags only.
Credentials are read inside the process from the fixed `.smoke-secrets/*.env`
directory; ambient provider credentials and replay overrides are cleared.
HOME, user data and config homes point to a fresh temporary profile, removed
on exit; owner settings, vault and account credentials are never loaded.

One short tool loop per cell, plus one Off continuation for comparison. Requests
use a 512-token output cap (a wire cap above 2048 is refused), 8192-token context
and a 60-second timeout. Ordinary retries are disabled; only the production
corrective retry remains. A quota/rate-limit response stops the cell immediately.
MiniMax requires the plan-key prefix and never automatically spends PAYG credit.
Go requests carry `x-opencode-session`; only zero-price Chat Completions models
are eligible with the one-day smoke key. Restricted family/door cells remain
explicitly not measured. Errors are reported using fixed classifications rather
than raw provider bodies, which might echo credentials or reasoning.

An `ok` row requires reasoning + a tool call on the first step and observed
reasoning on the successful Auto continuation wire. Missing reasoning, quota,
unsupported routes and incomplete streams are not acceptance evidence. The
retry column records the production rejection diagnostic; remembered state is
read back from that same port after a correction. A missing-replay product
defect stops that cell before the Off request. No forced rejection is injected
into the live matrix. Token deltas are observations from one pair, not a causal
proof of consumption; repeat only under a separately approved spend budget.

## Measurement provenance

- 2026-11-07: the script above, production core model port, 17 HTTP responses,
  3659 reported input tokens and 409 reported output tokens across all steps.
  Conservative spend estimate **$0.011408**, applying $2/M input and $10/M
  output even to subscription/free usage. This is not an invoice; failed-request
  usage is unavailable. Five successful replay pairs, no corrective rejection.
- 2026-11-02: direct-API probes of Z.AI, DeepSeek, MiniMax International and
  MiMo SGP; original-thinking and dropped-thinking variants, as described above.
  Full notes are in the local provider reasoning wire reference (not published).
- Unmeasured rows make no live acceptance claim. Fake-wire tests cover the
  corrective retry, remembered rejection and Responses encrypted serialization.
