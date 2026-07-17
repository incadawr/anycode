# CC-W0 — pinned-contract draft (claude CLI v2.1.212)

Input to CC-B (`host/engines/claude/contract/`). NOT code — a spec, built entirely from
fixtures in `fixtures/w0-*.jsonl` (recon-only, see `W0-FINDINGS.md` for the
proof-of-work behind every claim below) and the typed reference at
`@anthropic-ai/claude-agent-sdk@0.3.212`'s `sdk.d.ts` (installed to a throwaway `/tmp`
dir for recon, never shipped — CC-B re-derives the subset it needs by hand, it does not
depend on the SDK package). Every shape marked "live" was independently confirmed on
raw bytes from the real CLI, not just read from the SDK types.

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

| subtype | Request fields | Response fields | Live? |
|---|---|---|---|
| `initialize` | all optional: `hooks?, sdkMcpServers?, jsonSchema?, systemPrompt?, appendSystemPrompt?, planModeInstructions?, toolAliases?, excludeDynamicSections?, agents?, title?, skills?, promptSuggestions?, agentProgressSummaries?, forwardSubagentText?, supportedDialogKinds?` — minimal valid: `{subtype:"initialize"}` | `commands[], agents[], output_style, available_output_styles[], models: ModelInfo[], account: AccountInfo, fast_mode_state?` | ✅ live |
| `set_permission_mode` | `mode: PermissionMode` | `{}` on success; **`error` if `mode:"bypassPermissions"` and process wasn't spawned with `--allow-dangerously-skip-permissions`** (live-confirmed — cannot escalate to bypass mid-session without that spawn flag) | ✅ live |
| `set_model` | `model?: string` | `{}` | typed only |
| `interrupt` | `{}` | `{still_queued: string[]}` (empty array both times observed live) — only present when `capabilities` includes `interrupt_receipt_v1`; older CLIs send bare success | ✅ live |
| `apply_flag_settings` | `settings: Record<string, unknown>` (e.g. `{effortLevel:"low"\|"medium"\|"high"\|"xhigh"}`) | `{}` on success | ✅ live (accepted, `effortLevel:"high"`) |
| `get_context_usage` | `{}` | `{categories[], totalTokens, maxTokens, percentage, gridRows[][], memoryFiles[], mcpTools[], systemPromptSections[], agents[], skills{...}, autoCompactThreshold, apiUsage{...}}` — same data `/context` renders | typed only (not captured live; `/context` slash-command output captured instead, semantically equivalent) |
| `get_usage` (SDK method name: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) | `{}` | `{session:{total_cost_usd,...}, subscription_type, rate_limits_available, rate_limits:{five_hour?:{utilization,resets_at}, seven_day?:{...}, ...}}` | typed only — **highest-priority residual for the quota UI**, see §6.7 override below |

### 2.2 Requests the CLI sends us (CLI → host)

| subtype | Request fields | Our response | Live? |
|---|---|---|---|
| `can_use_tool` | `tool_name, input, permission_suggestions?, blocked_path?, decision_reason?, decision_reason_type?, classifier_approvable?, title?, display_name?, tool_use_id, agent_id?, description?, requires_user_interaction?` | allow: `{behavior:"allow", updatedInput?, updatedPermissions?, toolUseID}`; deny: `{behavior:"deny", message, interrupt?, toolUseID}` | ✅ live |
| `hook_callback` | (not exercised) | fail-closed `control_response{subtype:"error"}` for MVP (no hook bridge) | not exercised |
| `mcp_message` | (not exercised — MVP has no MCP passthrough) | fail-closed | not exercised |

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

- `SUPPORTED_CLAUDE_VERSION` floor: `>=2.1.212` (no ceiling — CC releases weekly per
  research §6.3/cut hazard (в); pin drift is caught by `capabilities[]`, not by minor
  version).
- `EXPECTED_CAPABILITIES` (from live `system/init.capabilities`, v2.1.212):
  `["interrupt_receipt_v1", "msg_lifecycle_v1"]`. `interrupt_receipt_v1` is documented
  (governs whether `interrupt`'s response carries `still_queued`); `msg_lifecycle_v1`'s
  exact behavioral contract is undocumented in the SDK types read during W0 — treat as
  an open/unknown capability per the SDK doc's own instruction ("ignore unknown values,
  check each capability for exactly the behavior you use"). Missing
  `interrupt_receipt_v1` → fail-closed `EngineVersionError` (interrupt semantics
  degrade silently otherwise).
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
3. Given the isolation findings in §4 (this section number reused deliberately — see
   W0-FINDINGS probe #6): the drift test's `system/init` fixture MUST be captured with
   the full isolation flag set (`--setting-sources project,local --strict-mcp-config
   --disable-slash-commands`) so the pinned baseline reflects AnyCode's actual spawn
   argv, not a leakier default.

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

**⚠ Unresolved custody gap found in W0 (not fixed by any flag tested):** the `/context`
slash-command output (and, by inference, the underlying `get_context_usage` response)
includes the **owner's home-directory file paths** for the global `~/.claude/CLAUDE.md`
and the AutoMem `MEMORY.md`, loaded into the session **despite**
`--setting-sources project,local`. This is a real personal-data leak surface (reveals
username, directory layout, and use of a personal AI memory system) that none of
`--setting-sources`, `--strict-mcp-config`, or `--disable-slash-commands` suppressed in
this recon. **CC-A/CC-B must spawn with a dedicated `CLAUDE_CONFIG_DIR`** (not the
default `~/.claude`) — untested in W0 whether this closes the gap, but it's the only
remaining lever, and VERIFY-1 (§7 findings) shows `CLAUDE_CONFIG_DIR` genuinely
isolates credentials, so it's the most likely fix. **This must be re-verified with a
live `CLAUDE_CONFIG_DIR`-scoped `/context` (or `get_context_usage`) call before CC-B's
sentinel-leak PoC is trusted** — do not ship CC-B without that follow-up check.

**⚠ Process note, not a wire fact:** during this recon, a Keychain metadata command was
run with a grep filter that accidentally let the actual OAuth token/refresh-token pair
print to tool output (owner already notified live, recommended token rotation). No
credential value from that incident was written to any fixture or file — grep across
all of `fixtures/` for token/email/oauth patterns returns 0 matches. Flagging here only
so CC-B's own tooling docs can explicitly warn against `security find-generic-password
-g` in any future scripts (the `-g` flag prints the secret human-readably; only `-s`/`-a`
existence/metadata queries are safe).
