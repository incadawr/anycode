# CC-W0 — pinned-contract draft (claude CLI v2.1.212, verified unchanged on 2.1.214)

Input to CC-B (`host/engines/claude/contract/`). NOT code — a spec, built entirely from
fixtures in `fixtures/w0-*.jsonl` (recon-only, see `W0-FINDINGS.md` for the
proof-of-work behind every claim below) and the typed reference at
`@anthropic-ai/claude-agent-sdk@0.3.212`'s `sdk.d.ts` (installed to a throwaway `/tmp`
dir for recon, never shipped — CC-B re-derives the subset it needs by hand, it does not
depend on the SDK package). Every shape marked "live" was independently confirmed on
raw bytes from the real CLI, not just read from the SDK types.

**Trust labels are load-bearing throughout this document.** ✅ **live** = exact bytes captured, fixture
named. ⬜ **typed only** = read from `sdk.d.ts`, never observed on the wire — a hypothesis CC-B must
confirm before depending on it. These are not interchangeable and are never merged into one column.

**Provenance of this revision (R4 finalization).** Folds in the follow-up recon lanes:
**R1** custody isolation (§5.1) · **R2** live `get_usage`/`get_context_usage` (§6, §7) ·
**R3** live `set_model` (§2.1, §8) · **R5** version drift 2.1.212→2.1.214 (§3, §4).
All four spent **0 live turns**. Open residuals are indexed with reasons in `W0-FINDINGS.md`
§"Таблица остатка" — the two that bear directly on this contract are **R5-a** (the capability gate's
own input is unverified across versions, §3) and **R-W0-8** (custody inconsistency in the committed
fixtures, §5.1).

---

## 1. Stream-json message types (stdout) + key fields

All messages share `session_id: string` and (except the earliest `system/init` of a
process) `uuid: string`. Turn-scoped vs process-scoped: `system/init` re-emits **once
per turn**, not once per process (live finding, probe #1) — treat it as "turn started",
not "process started".

| `type` | `subtype` | Key fields (live-confirmed unless noted) | Notes |
|---|---|---|---|
| `system` | `init` | `session_id, model, permissionMode, cwd, tools[], mcp_servers[], slash_commands[], skills[], plugins[], output_style, capabilities[], apiKeySource, claude_code_version` | `capabilities` open set — currently `["interrupt_receipt_v1","msg_lifecycle_v1"]` live. Emitted per-turn. |
| `system` | `status` | `status:"requesting"\|"compacting"\|null, permissionMode?` | Lightweight turn-progress ping. |
| `system` | `permission_denied` | (shape not fully captured; fires alongside a `tool_result{is_error:true}` on auto-deny, e.g. `dontAsk` mode) | Structured signal, prefer over parsing `tool_result.content` text. |
| `system` | `api_retry` | `attempt, max_retries, retry_delay_ms, error_status, error` | `error` ∈ `SDKAssistantMessageError` enum (see §1.1). Not captured live in W0 (no natural retry hit); typed shape only. |
| `rate_limit_event` | — | `rate_limit_info: {status, resetsAt?, rateLimitType?, utilization?, overageStatus?, overageResetsAt?, overageDisabledReason?, isUsingOverage?, overageInUse?, surpassedThreshold?, errorCode?, canUserPurchaseCredits?, hasChargeableSavedPaymentMethod?}` | **Live-confirmed**, fires automatically on ordinary turns (no request needed). `rateLimitType` ∈ `five_hour\|seven_day\|seven_day_opus\|seven_day_sonnet\|seven_day_overage_included\|overage`. |
| `assistant` | — | `message: BetaMessage (Anthropic Messages shape), parent_tool_use_id, error?: SDKAssistantMessageError` | `message.model === "<synthetic>"` marks a locally-generated response (not-logged-in text, slash-command replies) — **zero cost**, useful discriminator. |
| `user` | — | `message.content` (string echo, or `tool_result` blocks), `isReplay?: true` on echoed input | `--replay-user-messages` echo; dedupe on `uuid`. |
| `stream_event` | — | `event: BetaRawMessageStreamEvent` (raw Anthropic streaming: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) | Arrives progressively (live-confirmed non-buffered on this pipe config, probe #5). |
| `result` | `success` | `is_error, result, num_turns, duration_ms, duration_api_ms, total_cost_usd, usage{...}, modelUsage{}, permission_denials[], stop_reason, terminal_reason?, structured_output?` | `num_turns:0` + `duration_api_ms:0` marks a **local, zero-cost** result (slash command, not-logged-in). |
| `result` | `error_during_execution` \| `error_max_turns` \| `error_max_budget_usd` \| `error_max_structured_output_retries` | subset of success fields, no `result`/`structured_output` | Live-confirmed for `error_during_execution` (interrupt). |

### 1.1 Shared enums

- `SDKAssistantMessageError` = `authentication_failed | oauth_org_not_allowed | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | unknown | max_output_tokens` (live: `authentication_failed`).
- `TerminalReason` = `blocking_limit | rapid_refill_breaker | prompt_too_long | image_error | model_error | api_error | malformed_tool_use_exhausted | aborted_streaming | aborted_tools | stop_hook_prevented | hook_stopped | tool_deferred | max_turns | background_requested | completed | budget_exhausted | structured_output_retry_exhausted | tool_deferred_unavailable | turn_setup_failed` (typed only, not live).
- `PermissionMode` (wire value, as seen in `system/init.permissionMode` and control responses) = `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`. **CLI flag value differs**: `--permission-mode` accepts `manual` (not `default`) for the same mode — confirmed live, flag-value `manual` round-trips to wire-value `default`. CC-B must map `manual`(flag) ↔ `default`(wire) explicitly.

---

## 2. Control protocol (bidirectional, same stdin/stdout, NDJSON)

**Precondition (live-confirmed, probe #2): the `initialize` handshake alone is NOT
sufficient to receive `can_use_tool` over the control channel.** The CLI silently
auto-denies tool permission in headless `-p` mode unless spawned with the hidden flag
`--permission-prompt-tool stdio` (absent from `--help` in v2.1.212, confirmed present by
reading `@anthropic-ai/claude-agent-sdk`'s argv builder and independently verified live
— the exact byte-for-byte difference between the no-flag auto-deny and the with-flag
real `can_use_tool` exchange is preserved side-by-side in
`fixtures/w0-02-control-writeprobe-noflag-autodeny.jsonl` vs
`fixtures/w0-02-control-writeprobe.jsonl`). **CC-B's spawn argv MUST include
`--permission-prompt-tool stdio`.**

Envelope (both directions):
```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"...", ...}}
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{...}} | {"subtype":"error","request_id":"<uuid>","error":"..."}}
{"type":"control_cancel_request","request_id":"<uuid>"}
```
`control_cancel_request` (CLI→us) — the CLI withdrawing one of its own pending
requests to us (live-confirmed: happens to a pending `can_use_tool` when we fire
`interrupt` while it's outstanding, probe #3). Our client must drop the pending
handler for that `request_id` without answering it.

### 2.1 Requests we send (host → CLI)

**Trust levels are not interchangeable — do not merge these columns.** `✅ live` = the exact bytes were
captured from the real CLI and the fixture is named. `⬜ typed only` = read from `sdk.d.ts`, never
observed on the wire; treat as a hypothesis CC-B must confirm before depending on it.

| subtype | Request fields | Response | Trust |
|---|---|---|---|
| `initialize` | all optional: `hooks?, sdkMcpServers?, jsonSchema?, systemPrompt?, appendSystemPrompt?, planModeInstructions?, toolAliases?, excludeDynamicSections?, agents?, title?, skills?, promptSuggestions?, agentProgressSummaries?, forwardSubagentText?, supportedDialogKinds?` — minimal valid: `{subtype:"initialize"}` | `commands[], agents[], output_style, available_output_styles[], models: ModelInfo[], account: AccountInfo, fast_mode_state?` | ✅ **live** — `w0-13-authprobe-signedin.jsonl` (signed-in), `w0-07-verify1-configdir-probe.jsonl` (signed-out) |
| `interrupt` | `{}` | `{still_queued: string[]}` — empty array in both captures; present only when `capabilities` includes `interrupt_receipt_v1`, older CLIs send bare success | ✅ **live** — `w0-03-interrupt-early.jsonl`, `w0-03-interrupt-pending.jsonl` |
| `set_permission_mode` | `mode: PermissionMode` (wire values, see §1.1) | success carries an **echo body** `{"mode":"acceptEdits"}` confirming what was applied; **`error` if `mode:"bypassPermissions"` and the process wasn't spawned with `--dangerously-skip-permissions`** — error text is a launch-flag precondition, not a bad-value complaint | ✅ **live** — `w0-08-permmodes.jsonl` L73→L74, L106→L107; `w0-08-permmodes2.jsonl` L37→L38; rejection L41→L42 |
| `set_model` | `model: string` ∈ `initialize.models[].value` (observed offer set: `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`) | success = `{"subtype":"success","request_id":…}` **with NO `response` key at all** (absent, not empty — differs from `set_permission_mode`, which echoes); reject = `{"subtype":"error","error":"Model \"…\" is not a recognized model id. Run /model to see available models."}` | ✅ **live** — `w0-16-setmodel.jsonl` L9→L11 (accept), L17→L18 (reject) |
| `apply_flag_settings` | `settings: Record<string, unknown>` (e.g. `{effortLevel:"low"\|"medium"\|"high"\|"xhigh"}`) | `{subtype:"success"}` on accept | ✅ **live** — `w0-14-apply-flag-settings.jsonl` (accepted `effortLevel:"high"`) |
| `get_usage` (SDK method name: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) | `{}` — bare, exactly as the type declares | see **§6 (quota channel)** — full live payload pinned there | ✅ **live** — `w0-15-usage.jsonl` L5 (~766ms after init ack) |
| `get_context_usage` | `{}` — bare | `{categories[], totalTokens, maxTokens, rawMaxTokens, percentage, gridRows[][], model, memoryFiles[], mcpTools[], agents[], slashCommands{}, skills{}, autoCompactThreshold, isAutoCompactEnabled, messageBreakdown{}, apiUsage, autocompactSource}` — see §7 (context meter) | ✅ **live** — `w0-15-usage.jsonl` L8; also `w0-17-custody-*.jsonl` (3 arms) |
| `set_model` with `model` **omitted** | type declares `model?: string`, implying reset-to-default | unknown | ⬜ **typed only** — never probed (residual R3-b; $0 to close) |
| `hook_callback` response path | — | — | ⬜ **typed only** — not exercised (MVP has no hook bridge) |

**Normative notes on the mutating requests (all live-derived):**

1. **Discriminate accept vs reject on `response.subtype` (`success`|`error`) — never on the error
   text.** The strings are human prose ("Run /model to see available models") and will drift.
2. **`set_model` applies immediately, no turn required**, and a rejected call is a **clean no-op** —
   the previously-applied model survives. Failure is safe.
3. ⚠ **Read-back returns the RESOLVED id, not the requested one.** Requested `claude-fable-5[1m]`
   reads back as `claude-fable-5` via `get_context_usage.model`; likewise `opus[1m]` →
   `claude-opus-4-8[1m]`. **A product that sets `X` then asserts `context.model === X` will report a
   spurious mismatch.** Compare against the chosen `initialize.models[]` entry's `resolvedModel`, or
   don't round-trip-assert at all.
4. ⚠ **`bypassPermissions` is not reachable at runtime** — it is a spawn-time argv decision. AnyCode
   should never expose it (matches the codex `never` non-exposure precedent).
5. ⚠ **A successful `set_model` emits an unsolicited `type:"user"` frame BEFORE the control ack**
   (`w0-16-setmodel.jsonl` L10 precedes L11), wrapping
   `<local-command-stdout>Set model to claude-fable-5[1m] (claude-fable-5)</local-command-stdout>`
   with `isReplay:true`. **This is NOT `--replay-user-messages`** — verified by re-running with the
   flag dropped (`W0_NO_REPLAY=1`): the frame is emitted identically either way. See §8 (stream
   filtering) — unfiltered, this paints a phantom user message into the transcript on every model
   switch. A rejected `set_model` emits no such frame.
6. Validation of `set_model` is **local** (4ms reject vs ~1ms accept, no server round-trip) — it is
   checked against the same `models[]` list `initialize` returned.

### 2.2 Requests the CLI sends us (CLI → host)

| subtype / type | Request fields | Our response | Trust |
|---|---|---|---|
| `can_use_tool` | `tool_name, input, permission_suggestions?, blocked_path?, decision_reason?, decision_reason_type?, classifier_approvable?, title?, display_name?, tool_use_id, agent_id?, description?, requires_user_interaction?` | allow: `{behavior:"allow", updatedInput?, updatedPermissions?, toolUseID}`; deny: `{behavior:"deny", message, interrupt?, toolUseID}` | ✅ **live** — `w0-02-control-writeprobe.jsonl` (full exchange), `w0-08-permmodes*.jsonl` (all modes) |
| `control_cancel_request` (top-level `type`, not a `subtype`) | `{type:"control_cancel_request", request_id}` | **none — do not answer it.** Drop the pending handler for that `request_id` | ✅ **live** — `w0-03-interrupt-pending.jsonl`: CLI withdraws its own outstanding `can_use_tool` when we fire `interrupt` while it is open |
| `hook_callback` | — | fail-closed `control_response{subtype:"error"}` for MVP (no hook bridge) | ⬜ **typed only** — not exercised |
| `mcp_message` | — | fail-closed (MVP has no MCP passthrough) | ⬜ **typed only** — not exercised |
| **any unrecognized subtype** | — | **fail-closed `control_response{subtype:"error", request_id}`, never silence** | ⚠ **required behavior** — see below |

**Unhandled-subtype rule (normative).** The CLI blocks on an outstanding `control_request` until it
gets a response or cancels it. A subtype we do not implement MUST still be answered with an `error`
envelope carrying the same `request_id` — silently dropping it hangs the turn. The `initialize`
handshake does not enumerate which subtypes this CLI build may send, so this path is reachable on any
version bump, not just in theory.

**Pairing rule.** Every `control_request` we receive terminates in exactly one of: our
`control_response`, or a `control_cancel_request` from the CLI. A client that only implements the
first leaks pending handlers on every interrupt-during-approval — live-observed, not hypothetical.

`decision_reason_type` enum (live: `workingDir` observed; typed superset):
`rule | mode | subcommandResults | permissionPromptTool | hook | asyncAgent | sandboxOverride | workingDir | safetyCheck | classifier | other`.

**Important product-behavior facts from the `--permission-mode` sweep (probe #8,
live, all 6 modes exercised):**
- `default` (wire) / `manual` (flag): asks via `can_use_tool` for anything outside the
  working-directory allowlist.
- `bypassPermissions`: cannot be entered mid-session via `set_permission_mode` (see
  table above); must be a spawn-time flag combo AnyCode should never expose (matches
  codex's `never` non-exposure precedent).
- `acceptEdits`: still asks for writes **outside cwd** (working-dir is an orthogonal
  gate to mode). In-cwd behavior not verified live — inferred auto-accept from docs.
- `dontAsk`: auto-denies **without ever reaching the control channel** — no
  `can_use_tool` at all, just `system/permission_denied` + a `tool_result{is_error:true}`
  with human-readable text. The approval bridge gets no event to show for this mode.
- `auto`: the CLI's own classifier can silently approve a tool call **without any
  control-channel round-trip** — the host has zero visibility into what auto-mode
  approved. Do not promise the UI an approval-log entry for every executed tool under
  `auto`.
- `plan`: not a hard read-only block at the tool-gate level. The model writes a plan
  file to `~/.claude/plans/<slug>.md` unprompted, then **must** call `ExitPlanMode`
  (always gated by `can_use_tool`, no `decision_reason`, mode-independent) before any
  real tool executes — and once that's approved, subsequent real tool calls in the same
  turn ran with **no further prompt** in our capture. `ExitPlanMode` is the one
  universally-gated tool in the system — best anchor point for the MVP approval bridge.

---

## 3. Minimum version + capability gate

- `SUPPORTED_CLAUDE_VERSION` floor: **`>=2.1.212`, no ceiling** — and this is now **measured, not
  assumed**. An identical handshake-only probe was run against 2.1.212 and 2.1.214 (both
  `--version`-verified as genuinely distinct builds) and compared by extracting a **typed key-path
  set** from each payload (every nested path, arrays fully traversed, leaves reduced to their JS
  type) and diffing the sets — structural, so it ignores values that legitimately move between runs:

  | Control response | 2.1.212 | 2.1.214 | Drift |
  |---|---|---|---|
  | `initialize` | 62 typed key-paths | 62 | **none** |
  | `get_usage` | 221 | 221 | **none** |
  | `get_context_usage` | 96 | 96 | **none** |

  Nothing added, nothing removed, no leaf changed type. `models[].value` identical in content and
  order; `maxTokens` 1000000 and `autoCompactThreshold` 967000 identical; same 7 `categories` in the
  same order. **The v2.1.212 contract transfers to 2.1.214 as-is** ⇒ the pin is a floor for these
  three surfaces, not a ceiling. Fixture: `fixtures/w0-18-version-drift-2.1.214.jsonl`.

  ⚠ **Scope limit on that measurement, stated so it is not over-read:** drift was measured on **three
  read-only control surfaces only**. The mutating requests (`set_model`, `set_permission_mode`,
  `can_use_tool`) were not re-probed on 2.1.214 (residual R5-b, $0 to close), and `system/init`
  `capabilities` were **not compared at all** (residual R5-a — see the ⚠ under `EXPECTED_CAPABILITIES`
  immediately below, where it matters most).
- `EXPECTED_CAPABILITIES` (from live `system/init.capabilities`, v2.1.212):
  `["interrupt_receipt_v1", "msg_lifecycle_v1"]`. `interrupt_receipt_v1` is documented
  (governs whether `interrupt`'s response carries `still_queued`); `msg_lifecycle_v1`'s
  exact behavioral contract is undocumented in the SDK types read during W0 — treat as
  an open/unknown capability per the SDK doc's own instruction ("ignore unknown values,
  check each capability for exactly the behavior you use"). Missing
  `interrupt_receipt_v1` → fail-closed `EngineVersionError` (interrupt semantics
  degrade silently otherwise).
  - ⚠⚠ **Known hole directly under this gate (residual R5-a).** `system/init` is emitted **only after
    a `user` message**, so `capabilities[]` is not observable on a handshake-only run and was
    therefore **not compared across 2.1.212 and 2.1.214** — closing it costs one billed turn per
    version. The version-drift evidence above is real but does **not** cover the one field this
    capability gate is built on. **CC-B must close R5-a before relying on `capabilities[]` as the
    drift detector**, otherwise the gate's own input is unverified across the very version range the
    floor permits.
- Required spawn flags, beyond the ones already in the cut (§1.3 argv list) — **two
  additions this recon surfaced that the existing cut plan does not list**:
  1. `--permission-prompt-tool stdio` (§2 above — without it, `can_use_tool` never
     reaches us).
  2. `--disable-slash-commands` (§4 below — without it, the CLI's own built-in
     slash-command/skill catalog leaks into `system/init.slash_commands`/`.skills` and
     the `initialize` control-response's `commands[]`, none of which AnyCode wants
     surfaced under its own product identity).

---

## 4. Drift gate strategy (no `generate-json-schema` — subset-check against fixtures)

Same approach as codex's `contract/` (cut §1.3 B4): copy the scrubbed `fixtures/w0-*.jsonl`
into `host/engines/claude/contract/fixtures/`, and a `contract-drift.test.ts` that:

1. Replays each fixture's raw bytes through the real line-parser (byte-for-byte,
   including split-across-chunks framing) and asserts the parsed message matches a
   **subset** of expected keys per `type`/`subtype` (superset drift — CLI adding new
   optional fields — is not a failure; **subset** drift — a field this contract depends
   on disappearing — is).
2. A second, env-gated live layer (`ANYCODE_CLAUDE_DRIFT_BIN`) re-runs a cheap subset of
   the W0 probes against whatever `claude` binary is on the machine and diffs the
   resulting message *shapes* (not values) against the same subset-check — this is what
   actually catches upstream protocol drift between W0 and ship time, since the
   fixtures alone can only prove "this shape existed on 2026-07-18."
3. Given the isolation findings (see W0-FINDINGS probe #6): the drift test's `system/init` fixture
   MUST be captured with the full isolation flag set (`--setting-sources project,local
   --strict-mcp-config --disable-slash-commands`) **and an isolated `CLAUDE_CONFIG_DIR`** so the
   pinned baseline reflects AnyCode's actual spawn argv/env, not a leakier default.

4. **Direction of the assertion, made explicit (this is what R5 validates).** The gate asserts
   **subset**, never equality. The live `get_usage` payload is already a strict **superset** of the
   SDK type *today, on the pinned version* — 11 undeclared keys under `rate_limits`, 3 per window, 4
   under `extra_usage`, plus `autocompactSource` on `get_context_usage` (§6/§7). An equality- or
   `.strict()`-based gate therefore fails on **correct** traffic on day one. Superset drift (CLI adds
   optional fields) = pass; subset drift (a field this contract depends on disappears) = fail.

5. **Use the same typed-key-path method R5 used**, not value comparison: extract every nested key
   path with array traversal, reduce leaves to their JS type, diff the sets. This is what made the
   2.1.212↔2.1.214 comparison meaningful — it ignores timestamps, `utilization`, and request counters
   that legitimately move between runs, and would still have caught a renamed or retyped field. A
   value-diff gate would have been pure noise (three of the compared payloads carry live quota
   numbers and ISO timestamps).

6. ⚠ **The gate's coverage must be stated, not implied.** Fixtures alone prove only "this shape
   existed on 2026-07-18 on these surfaces." Currently uncovered and therefore NOT protected by this
   gate: `system/init.capabilities` across versions (R5-a — and §3's capability gate depends on it),
   mutating control requests on any version above 2.1.212 (R5-b), and the post-turn-only fields
   (`deferredBuiltinTools`/`systemTools`/`systemPromptSections`, `session.model_usage` — R2-a/R2-b).
   If CC-B ships the gate without noting these, a green gate will read as "protocol verified" when
   three load-bearing surfaces were never checked.

---

## 5. Custody redaction (fields that must NEVER reach settings.json / logs / shadow-transcript)

Confirmed by direct observation (live, not inference) that these fields appear
**unprompted, un-gated by `--setting-sources`**, in the control-protocol `initialize`
response:

| Field | Path | Contains | Redact/strip in |
|---|---|---|---|
| `account.email` | `initialize` response | Owner's Anthropic account email | client parse layer — never store, never log |
| `account.organization` | `initialize` response | Org display name (often derived from email) | same |
| `account.subscriptionType` | `initialize` response | Plan tier (`"Claude Max"` etc.) | OK to surface in doctor UI (not secret), but do not persist to disk logs verbatim without review |
| `result.total_cost_usd`, `modelUsage[].costUSD` | every `result` | Real dollar amounts | per cut §0.2 invariant 2 — aggregate only in memory for the session cost display, never persist raw to settings.json |
| Keychain-adjacent env/CLI flags | n/a | `CLAUDE_CODE_OAUTH_TOKEN`, any `setup-token` output | never write to settings.json; profile custody is AnyCode's own vault, same as the codex-profiles precedent |

### 5.1 Custody gap — RESOLVED (R1), and what it makes mandatory

The gap: the `/context` output and the underlying `get_context_usage` response load and enumerate the
owner's global `~/.claude/CLAUDE.md` **and** the AutoMem `MEMORY.md` into the session, **despite**
`--setting-sources project,local`. None of `--setting-sources`, `--strict-mcp-config`, or
`--disable-slash-commands` suppress it.

**Resolved by live three-arm probe** (`fixtures/w0-17-custody-{A-default,B-isolated,C-project}.jsonl`,
0 turns spent — no fixture contains a `result` frame at all):

| Arm | `CLAUDE_CONFIG_DIR` | `memoryFiles[]` | `totalTokens` |
|---|---|---|---|
| A (RED baseline) | default `~/.claude` | `CLAUDE.md` **660 tok** + AutoMem `MEMORY.md` **8969 tok** | 28385 |
| B (isolated) | fresh empty dir | `CLAUDE.md` **0 tok**, AutoMem row **absent entirely** | 1931 |
| C (isolated + project cwd) | fresh empty dir | **byte-identical to B** | 1931 |

**`CLAUDE_CONFIG_DIR` closes the content leak** — content drops to 0 tokens, the AutoMem entry
disappears completely (the CLI relocates where it looks for AutoMem too), cross-verified by two
independent methods (structural `get_context_usage` + human-readable `/context`). The planned
`CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-<id>` scheme is therefore **validated as the correct
custody mechanism**; no second mechanism is needed for memory-file custody on top of what it already
does for credentials (VERIFY-1).

**⚠ NORMATIVE — isolation is necessary but NOT sufficient.** Two requirements survive isolation and
are architecture requirements, not footnotes:

| # | Requirement | Why (live evidence) |
|---|---|---|
| **C1** | **Spawn every engine process with a dedicated `CLAUDE_CONFIG_DIR`.** Never the default `~/.claude`. | Without it the owner's personal notes (9629 tok) enter the model's context verbatim — arm A. |
| **C2** | **Redact `memoryFiles[].path` at the client parse layer regardless of isolation.** | Under full isolation the global `CLAUDE.md` path **survives as a 0-token placeholder pointing at the REAL home path**, not the isolated tmp dir: arm B returns `[{"path":"[HOME]/.claude/CLAUDE.md","type":"Project","tokens":0}]`. Zero content crosses, but username + home layout still do. This is CLI behavior — **no flag removes it**, so it must be handled in code. |

**Home paths appear in two encodings — a scrub that handles one and not the other silently passes.**
`get_context_usage` returns both the literal form (`/Users/<user>/.claude/CLAUDE.md`) and a
**dash-encoded slug** (`~/.claude/projects/-Users-<user>-projects-…/memory/MEMORY.md`), because Claude
Code names per-project state dirs by replacing `/` with `-` in the cwd. A redactor (or a PII grep)
matching only `/Users/<user>` leaves the username fully readable in the slug. **Both forms must be
rewritten** (`[HOME]`, `[HOME-SLUG]`), applied to string values **and object keys**, and to
unparseable raw lines. This is not hypothetical: it is exactly how the leak recorded as **R-W0-8** in
`W0-FINDINGS.md` evaded the recon's own prescribed scan.

**Sentinel-leak PoC (CC-B DoD) stands, with its purpose changed:** run it against the
`get_context_usage` response (not just a log grep) — now as a **regression test pinning a known-good
state**, rather than as the experiment that answers the question.

**Still open (both carried in W0-FINDINGS' residual table, neither blocking C1/C2):** whether
isolating the global level breaks legitimate project-level `AGENTS.md` pickup (**R-W0-5** — no
discriminating signal exists even in the RED baseline, so there is nothing to compare against), and
whether the `System prompt`/`System tools` categories vanish in arms B/C because of isolation or
merely because a fresh config dir is necessarily signed-out (**R-W0-7** — needs a signed-in isolated
profile).

**⚠ Process note, not a wire fact:** during this recon, a Keychain metadata command was
run with a grep filter that accidentally let the actual OAuth token/refresh-token pair
print to tool output (owner already notified live, recommended token rotation). No
credential value from that incident was written to any fixture or file — grep across
all of `fixtures/` for credential patterns returns 0 live matches. Flagging here only
so CC-B's own tooling docs can explicitly warn against `security find-generic-password
-g` in any future scripts (the `-g` flag prints the secret human-readably; only `-s`/`-a`
existence/metadata queries are safe).

---

## 6. Quota channel — `get_usage` (supersedes research §3.8/§6.7)

**This section replaces the prior assumption that honest subscription percentages are unavailable
without the grey `api.anthropic.com/api/oauth/usage` endpoint. They are available, officially, over
the control protocol.** `control_request{subtype:"get_usage"}` is the supported machine-readable quota
source, requires **no turn** ($0), and answers in ~770ms — cheap to poll on demand, too slow for a
synchronous UI hot path. ✅ live: `fixtures/w0-15-usage.jsonl` L5.

The SDK method is named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Treat that
literally: it is first-party and supported, but its shape is explicitly volatile — which is exactly
why §6.2 below is normative rather than advisory.

### 6.1 Live payload (subscription account)

Top level: `{session, subscription_type, rate_limits_available, rate_limits, behaviors}`.
Observed: `subscription_type:"max"`, `rate_limits_available:true`.

- **Flat windows:** `five_hour{utilization, resets_at, limit_dollars, used_dollars, remaining_dollars}`,
  `seven_day{…}` (dollar fields all `null` on this account).
- **`limits[]` — self-describing, and the surface to build on:**
  `{kind, group, percent, severity:"normal"|"warning"|"critical", resets_at, scope, is_active}`.
  Live: `session` 3% normal · `weekly_all` 76% warning · `weekly_scoped` **94% critical
  `is_active:true`** with `scope.model.display_name:"Fable"`.
- `spend{used, limit, percent, severity, enabled, cap, …}`, `extra_usage{…}`, `model_scoped[]`,
  `member_dashboard_available`.
- `session{total_cost_usd, total_api_duration_ms, total_duration_ms, total_lines_added,
  total_lines_removed, model_usage}` — all zeros / `model_usage:{}` on a handshake-only session; its
  populated shape is **⬜ typed only** (residual R2-b).

⚠ **Read severity from `limits[]`, not from the flat windows.** On the captured account the flat
`seven_day` read 76% `warning` while the binding constraint was a `weekly_scoped` bucket at 94%
`critical` — **an 18-point understatement of how close the account was to its real limit.** The flat
windows also carry no `severity` or `is_active` signal at all; `limits[]` is what the TUI's own
severity colouring keys off.

### 6.2 Schema discipline (NORMATIVE — both rules are live-derived, not stylistic)

1. **Never validate this payload with a closed schema** (`z.object().strict()`, exhaustive switch over
   window keys). The live response is a **strict superset of the SDK type today, on the pinned
   version** — declared-but-absent fields: none; live-only: 11 keys under `rate_limits`, 3 per window,
   4 under `extra_usage`. A strict parser rejects correct traffic immediately, before any version
   bump. Parse permissively, read what you need, ignore the rest.
2. **Never render `rate_limits` by enumerating its keys.** Eight undeclared buckets are
   **unreleased-feature codenames** — `tangelo`, `iguana_necktie`, `nimbus_quill`, `cinder_cove`,
   `amber_ladder`, `seven_day_omelette`, `omelette_promotional`, `seven_day_cowork` — all `null`
   today, and they will light up without notice. A UI that maps over the object and renders each as a
   labelled meter **will one day display an Anthropic codename to the owner.** Render from an
   allowlist of known windows, or from `limits[]` (self-describing by construction).
   Their populated shape is unknown and unknowable right now (residual R2-c) — do not guess it.

## 7. Context meter — `get_context_usage`

✅ live: `fixtures/w0-15-usage.jsonl` L8 (+989ms), plus all three custody arms.

- **Meter source:** `totalTokens` / `maxTokens` / `percentage` directly (live: 28659 / 1000000 / 3).
- **"Room left before compaction":** `autoCompactThreshold` (967000 of 1000000) with
  `isAutoCompactEnabled` — this, not `maxTokens`, is the number a compaction indicator needs.
- **Category totals:** `categories[]` (`System prompt`, `System tools`, `System tools (deferred)`
  with `isDeferred:true`, `Memory files`, `Skills`, `Messages`, `Free space`).
- **Current model:** `model` — the **resolved** id (see §2.1 note 3).
- ⚠ **Do NOT use `apiUsage` as the meter source** — it is `null` on a fresh session, i.e. exactly when
  no turn has happened yet. It is declared `… | null`, so this is type-legal and permanent, not a bug.
- ⚠ **Treat `systemTools` / `deferredBuiltinTools` / `systemPromptSections` as absent-by-default.**
  All three are optional in the type and were **not** emitted on a fresh session. Their headline
  token totals remain reachable via `categories[]`; only the per-tool breakdown is lost. Whether they
  appear post-turn is untested (residual R2-a).
- Live-only field not in the SDK type: `autocompactSource` (`"auto"`).

## 8. Stream filtering (defect class — unfiltered, this reaches the user's transcript)

**A successful `set_model` emits an unsolicited `{"type":"user", …, "isReplay":true}` frame wrapping
`<local-command-stdout>Set model to … (…)</local-command-stdout>`, and it arrives BEFORE the control
ack.** It is emitted **independently of `--replay-user-messages`** — verified by re-running with the
flag dropped. ✅ live: `w0-16-setmodel.jsonl` L10 (frame) → L11 (ack).

**Consumers MUST filter `type:"user"` frames carrying `isReplay:true` and/or the
`<local-command-stdout>` wrapper**, or a phantom user message appears in the transcript on every model
switch. Note the general shape of the hazard: the CLI uses the `user` channel for local command echo,
so this is a class, not a single frame — `--replay-user-messages` echoes are a separate source of the
same defect (dedupe on `uuid`).
