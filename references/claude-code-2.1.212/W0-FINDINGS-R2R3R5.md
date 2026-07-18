# CC-W0 — R2 / R3 / R5 findings (control protocol: usage, model, version drift)

Lane: CC-W0-R2/R3/R5. Pure recon, **zero product code**. Companion to `W0-FINDINGS.md`
(written by a parallel lane — deliberately NOT edited here; the orchestrator merges).

**Binary under test:** `/Users/incadawr/.local/share/claude/versions/2.1.212` (`2.1.212 (Claude Code)`),
plus `.../2.1.214` (`2.1.214 (Claude Code)`) for R5. Both `--version`-verified in-run, so the drift
comparison is between two genuinely distinct binaries, not the same one twice.

**Cost: $0. Zero model turns.** See §"$0 proof" at the bottom.

New fixtures:

| Fixture | Scenario | Binary | Lines |
|---|---|---|---|
| `fixtures/w0-15-usage.jsonl` | `usage-probe` | 2.1.212 | 10 |
| `fixtures/w0-16-setmodel.jsonl` | `setmodel-probe` | 2.1.212 | 24 |
| `fixtures/w0-18-version-drift-2.1.214.jsonl` | `usage-probe` | 2.1.214 | 10 |

Harness additions (`harness/w0-control-harness.mjs`): scenarios `usage-probe` and `setmodel-probe`,
a labelled pending-control tracker (`sendControl`/`probeStep`) so a probe can chain control requests
off each other's acks, `W0_NO_REPLAY=1` toggle, and an extended custody scrub (see §Custody).
Pre-existing scenarios are untouched and remain reproducible.

---

## R2 — `get_usage` and `get_context_usage`, live

Both were captured live for the first time. Probe shape (`usage-probe`):
`initialize` → ack → `get_usage` → resp → `get_context_usage` → resp → finish. No `user` message is
ever sent, so no turn is billed.

Requests are bare, exactly as the SDK type declares:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"get_usage"}}
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"get_context_usage"}}
```

Latency, measured from harness `t_ms` (`w0-15-usage.jsonl`): initialize ack at 762ms,
`get_usage` resp +766ms, `get_context_usage` resp +989ms. Both are ~1s-class calls — cheap enough to
poll on demand, too slow to sit on a UI hot path synchronously.

### R2.1 — `get_usage` live payload (`w0-15-usage.jsonl` L5)

Envelope is the standard `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{…}}}`.
Payload, abridged to structure (full bytes in fixture L5):

```json
{
  "session": { "total_cost_usd": 0, "total_api_duration_ms": 0, "total_duration_ms": 1383,
               "total_lines_added": 0, "total_lines_removed": 0, "model_usage": {} },
  "subscription_type": "max",
  "rate_limits_available": true,
  "rate_limits": {
    "five_hour": { "utilization": 3,  "resets_at": "2026-07-18T09:49:59.900817+00:00",
                   "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
    "seven_day": { "utilization": 76, "resets_at": "2026-07-18T16:59:59.900837+00:00",
                   "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
    "seven_day_oauth_apps": null, "seven_day_opus": null, "seven_day_sonnet": null,
    "seven_day_cowork": null, "seven_day_omelette": null, "tangelo": null,
    "iguana_necktie": null, "omelette_promotional": null, "nimbus_quill": null,
    "cinder_cove": null, "amber_ladder": null,
    "extra_usage": { "is_enabled": true, "monthly_limit": 10000, "used_credits": 5824,
                     "utilization": 58.24, "currency": "USD", "decimal_places": 2,
                     "disabled_reason": null, "daily": null, "weekly": null },
    "limits": [
      { "kind": "session",       "group": "session", "percent": 3,  "severity": "normal",
        "resets_at": "…", "scope": null, "is_active": false },
      { "kind": "weekly_all",    "group": "weekly",  "percent": 76, "severity": "warning",
        "resets_at": "…", "scope": null, "is_active": false },
      { "kind": "weekly_scoped", "group": "weekly",  "percent": 94, "severity": "critical",
        "resets_at": "…", "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
        "is_active": true }
    ],
    "spend": { "used": { "amount_minor": 5824, "currency": "USD", "exponent": 2 },
               "limit": { "amount_minor": 10000, "currency": "USD", "exponent": 2 },
               "percent": 58, "severity": "normal", "enabled": true, "disabled_reason": null,
               "cap": { "money": null, "credits": { "amount_minor": 10000, "exponent": 2 } },
               "balance": null, "auto_reload": null, "disclaimer": "…", 
               "can_purchase_credits": false, "can_toggle": false },
    "member_dashboard_available": false,
    "model_scoped": [ { "display_name": "Fable", "utilization": 94, "resets_at": "…" } ]
  },
  "behaviors": { "day": { "request_count": 2041, "session_count": 43,
                          "behaviors": [ { "key": "long_context", "pct": 42, "count": 698 }, … ],
                          "agents": […], "skills": […], "plugins": […], "mcp_servers": [] },
                 "week": { … same shape … } }
}
```

**Confirmed: this is the official machine-readable quota channel.** `subscription_type:"max"`,
`rate_limits_available:true`, and populated windows on a subscription session — no scraping needed.

**Divergence type ↔ live byte (this is the important part).** The live payload is a strict
**superset** of `SDKControlGetUsageResponse`. Mechanically diffed (not eyeballed):

- Declared-but-absent: **none**. Every field in the SDK type showed up live.
- **Live-only under `rate_limits` (11 keys, undeclared):** `seven_day_cowork`, `seven_day_omelette`,
  `tangelo`, `iguana_necktie`, `omelette_promotional`, `nimbus_quill`, `cinder_cove`, `amber_ladder`,
  `limits`, `spend`, `member_dashboard_available`.
- **Live-only inside each window object:** `limit_dollars`, `used_dollars`, `remaining_dollars`
  (all `null` here; the SDK type declares only `utilization` + `resets_at`).
- **Live-only inside `extra_usage`:** `decimal_places`, `disabled_reason`, `daily`, `weekly`.

Two consequences for the product, both real:

1. **Never validate this payload with an exact/closed schema** (`z.object().strict()`, exhaustive
   switch on window keys, etc.) — it will reject live traffic today, before any version bump. Parse
   permissively, read the fields you need, ignore the rest.
2. Eight of the undeclared window keys are **unreleased-feature codenames** (`tangelo`,
   `iguana_necktie`, `nimbus_quill`, `cinder_cove`, `amber_ladder`, `omelette*`, `cowork`), all `null`
   here. They will light up without notice. A UI that enumerates `rate_limits` keys and renders each
   as a labelled meter will one day render a codename to the owner. **Render from an allowlist of
   known windows, not by enumerating the object.** The `limits[]` array is the safer surface: it is
   self-describing (`kind`/`group`/`percent`/`severity`/`is_active`/`display_name`) and is what the
   TUI's own severity colouring keys off.

Note `limits[]` carries a signal the flat windows do not: `severity` (`normal`/`warning`/`critical`)
and `is_active`. Here the binding constraint is `weekly_scoped` at 94% `critical` `is_active:true`
(the Fable weekly bucket) while `seven_day` sits at 76% `warning` — a flat-window reading would have
understated how close the account is to its real limit.

### R2.2 — `get_context_usage` live payload (`w0-15-usage.jsonl` L8)

```json
{
  "categories": [
    { "name": "System prompt",           "tokens": 2884,   "color": "promptBorder" },
    { "name": "System tools",            "tokens": 14055,  "color": "inactive" },
    { "name": "System tools (deferred)", "tokens": 15555,  "color": "inactive", "isDeferred": true },
    { "name": "Memory files",            "tokens": 9629,   "color": "claude" },
    { "name": "Skills",                  "tokens": 2083,   "color": "warning" },
    { "name": "Messages",                "tokens": 8,      "color": "purple_FOR_SUBAGENTS_ONLY" },
    { "name": "Free space",              "tokens": 971341, "color": "promptBorder" }
  ],
  "totalTokens": 28659, "maxTokens": 1000000, "rawMaxTokens": 1000000,
  "autocompactSource": "auto", "percentage": 3,
  "gridRows": [ [ { "color": "promptBorder", "isFilled": true, "categoryName": "System prompt",
                    "tokens": 2928, "percentage": 0, "squareFullness": 0.5856 }, … ×20 ], … ×10 ],
  "model": "claude-opus-4-8[1m]",
  "memoryFiles": [
    { "path": "[HOME]/.claude/CLAUDE.md", "type": "Project", "tokens": 660 },
    { "path": "[HOME]/.claude/projects/[HOME-SLUG]-projects-tools-anycode/memory/MEMORY.md",
      "type": "AutoMem", "tokens": 8969 }
  ],
  "mcpTools": [], "agents": [],
  "slashCommands": { "totalCommands": 15, "includedCommands": 15, "tokens": 872 },
  "skills": { "totalSkills": 15, "includedSkills": 15, "tokens": 2083,
              "skillFrontmatter": [ { "name": "deep-research", "source": "built-in", "tokens": 162 }, … ×15 ] },
  "autoCompactThreshold": 967000, "isAutoCompactEnabled": true,
  "messageBreakdown": { "toolCallTokens": …, "toolResultTokens": …, "attachmentTokens": …,
                        "assistantMessageTokens": …, "userMessageTokens": …,
                        "redirectedContextTokens": …, "unattributedTokens": …,
                        "toolCallsByType": [], "attachmentsByType": [] },
  "apiUsage": null
}
```

Divergence vs `SDKControlGetContextUsageResponse`, mechanically diffed:

- **Live-only (undeclared): `autocompactSource`** — value `"auto"`. Not in the SDK type at all.
- **Declared-but-absent on this handshake:** `deferredBuiltinTools`, `systemTools`,
  `systemPromptSections`. All three are optional (`?`) in the type. Their token totals *are* still
  reachable via `categories[]` ("System tools", "System tools (deferred)" with `isDeferred:true`), so
  the headline numbers are not lost — only the per-tool breakdown is. Whether they appear once a
  session has real messages is **NOT tested** (would need a live turn) → residual R2-a below.
- `apiUsage` is **`null`** on a fresh handshake-only session, not an object. It is declared
  `… | null`, so this is type-legal, but it means **`apiUsage` cannot be the product's context meter
  source** — it is null exactly when no turn has happened.

**`memoryFiles[]` is present and populated** (R1 cross-reference — flagged only, not analysed here,
per lane split): 2 entries, each `{path, type, tokens}`, with `type` distinguishing `"Project"` from
`"AutoMem"`. Both paths are absolute and home-rooted; see §Custody — this field is why the scrub
needed extending.

Useful for the product: `totalTokens`/`maxTokens`/`percentage` give the context meter directly, and
`autoCompactThreshold` (967000 vs `maxTokens` 1000000) exposes the compaction trigger point, which is
what a "context left before compact" indicator actually needs.

### R2 residuals

- **R2-a** — whether `deferredBuiltinTools` / `systemTools` / `systemPromptSections` populate once the
  session has messages. Untested: distinguishing "optional and omitted" from "only emitted post-turn"
  requires a billed turn. Not spent, per the lane's $0 budget.
- **R2-b** — `get_usage.session.*` is all zeros / `model_usage:{}` on a handshake-only session. Its
  populated shape (`ModelUsage` per model) is **from the type, not observed live** — it can only fill
  after a real turn.
- **R2-c** — the eight codenamed rate-limit windows were all `null` on this account; their populated
  shape is unknown. Assume it matches the `{utilization, resets_at}` window shape, but that is an
  inference, not evidence.

---

## R3 — `set_model` (+ `set_permission_mode` for free, from existing fixtures)

### R3.1 — `set_permission_mode`, already captured (no new spend)

Extracted from the existing fixtures, per the brief — no re-run.

Request: `{"subtype":"set_permission_mode","mode":"<PermissionMode>"}`

Success (`w0-08-permmodes.jsonl` L73→L74, L106→L107; `w0-08-permmodes2.jsonl` L37→L38) — note the
success carries an **echo body** confirming the applied mode:

```json
{"subtype":"success","request_id":"b2304d2d-…","response":{"mode":"acceptEdits"}}
```

Rejection (`w0-08-permmodes.jsonl` L41→L42) — a launch-flag precondition, not a bad value:

```json
{"subtype":"error","request_id":"126c2d6d-…",
 "error":"Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"}
```

Live-confirmed applied: `acceptEdits`, `dontAsk`, `plan`. Live-confirmed rejected: `bypassPermissions`
(absent `--dangerously-skip-permissions`). **Product consequence:** `bypassPermissions` is not
reachable by runtime control — it must be decided at spawn time, in argv.

### R3.2 — `set_model`, newly captured (`w0-16-setmodel.jsonl`)

Valid model taken from the `initialize` response's `models[].value`, as briefed. Offered on this
build: `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`.

**Positive arm** (L9 → L11):

```json
// →
{"type":"control_request","request_id":"7cd032e7-…","request":{"subtype":"set_model","model":"claude-fable-5[1m]"}}
// ←
{"type":"control_response","response":{"subtype":"success","request_id":"7cd032e7-…"}}
```

**The success has NO `response` body at all** — the key is absent, not empty. This differs from
`set_permission_mode`, which echoes `{"mode":…}`. So a client cannot read back the applied model from
the ack; it only learns "accepted".

**Negative arm** (L17 → L18) — the discriminating failure form the product needs:

```json
// →
{"type":"control_request","request_id":"de41e615-…","request":{"subtype":"set_model","model":"no-such-model-xyz"}}
// ←
{"type":"control_response","response":{"subtype":"error","request_id":"de41e615-…",
  "error":"Model \"no-such-model-xyz\" is not a recognized model id. Run /model to see available models."}}
```

So **accepted vs rejected is discriminated by `response.subtype` (`success` | `error`)**, uniformly
with the rest of the control protocol — the product does not need to parse the error string. Good:
the string is human prose ("Run /model to see available models") and will drift.

Rejection latency is 4ms vs ~1ms for accept — validation is local (against the same `models[]` list
`initialize` returned), not a server round-trip.

### R3.3 — `set_model` effect IS observable for $0 (brief anticipated a residual here)

The brief allowed writing this off as a residual if the effect needed a live turn. It does not.
`get_context_usage.model` is a free read-back, so the probe sandwiches the mutations between context
reads:

| Step | fixture line | `get_context_usage.model` |
|---|---|---|
| baseline, after `initialize` | L6 | `claude-opus-4-8[1m]` |
| after **valid** `set_model claude-fable-5[1m]` | L14 | **`claude-fable-5`** |
| after **rejected** `set_model no-such-model-xyz` | L21 | `claude-fable-5` (unchanged) |

Three facts, all evidenced:

1. A successful `set_model` **takes effect immediately**, with no turn required.
2. A rejected `set_model` is a **clean no-op** — it does not clobber or reset the previously applied
   model. Failure is safe.
3. **The read-back value is the *resolved* id, not the requested one**: requested
   `claude-fable-5[1m]`, reads back `claude-fable-5`. Also visible in `initialize`: each entry has
   both `value` (what you send) and `resolvedModel` (what you get). Likewise `opus[1m]` resolves to
   `claude-opus-4-8[1m]`. **A product that sets `X` and then asserts `context.model === X` will report
   a spurious mismatch.** Compare against the `resolvedModel` of the chosen entry, or don't
   round-trip-assert at all.

### R3.4 — side finding: successful `set_model` emits an unsolicited `type:"user"` frame

Between the request and its ack, the CLI emits an out-of-band message on stdout (L10):

```json
{"type":"user","message":{"role":"user",
  "content":"<local-command-stdout>Set model to claude-fable-5[1m] (claude-fable-5)</local-command-stdout>"},
 "session_id":"a922ec74-…","parent_tool_use_id":null,"uuid":"f9f9ce9b-…",
 "timestamp":"2026-07-18T05:09:34.772Z","isReplay":true}
```

Ordering matters: **the echo arrives BEFORE the control ack** (L10 then L11).

The obvious suspicion is that this is just `--replay-user-messages` (which the harness passes)
reflecting something back. **It is not** — verified by re-running the same probe with the flag
dropped (`W0_NO_REPLAY=1`, harness toggle added for this): the echo is emitted identically, once,
with `isReplay:true`, in both configurations.

**Product consequence:** a stream consumer that renders every `type:"user"` frame as a user turn will
paint a phantom user message reading `<local-command-stdout>Set model to …</local-command-stdout>`
into the transcript every time the model is switched. The frame must be filtered — by
`isReplay === true` and/or by the `<local-command-stdout>` wrapper. The rejected `set_model` emits no
such frame, so the echo doubles as a (redundant) success signal.

### R3 residuals

- **R3-a** — whether a mid-session `set_model` actually routes the *next inference* to the new model
  is not directly proven; what is proven is that the CLI's own resolved session state flips
  (`get_context_usage.model`) and that `maxTokens` stayed `1000000`. Confirming the inference path
  requires a billed turn.
- **R3-b** — `set_model` with the `model` field **omitted** (the SDK type declares it optional,
  `model?: string`, implying a reset-to-default) was not probed. Cheap and $0 to add later; it was
  outside the two arms the brief specified, and I did not widen scope.

---

## R5 — version drift 2.1.212 → 2.1.214

Identical handshake-only `usage-probe` run against both binaries; `--version` checked on each to
confirm they really are different builds. Compared by extracting a **typed key-path set** from each
payload (every nested key path, arrays fully traversed, leaves reduced to their JS type) and diffing
the sets — structural, so it ignores the values that legitimately move between runs (timestamps,
utilization, request counts).

| Control response | 2.1.212 | 2.1.214 | Drift |
|---|---|---|---|
| `initialize` | 62 typed key-paths | 62 | **none** |
| `get_usage` | 221 typed key-paths | 221 | **none** |
| `get_context_usage` | 96 typed key-paths | 96 | **none** |

Nothing added, nothing removed, no leaf changed type, in any of the three.

Spot-checks on stable scalars, both versions identical:

- `initialize` top-level keys: `commands, agents, output_style, available_output_styles, models,
  account, pid, remote_control_auto_enable, remote_control_auto_on_by_default, ide_rc_auto_enable_gate`
- `models[].value`: `default | opus[1m] | claude-fable-5[1m] | sonnet | haiku` — same list, same order
- `commands` 43 / `agents` 5 on both
- `subscription_type` `max`; `rate_limits_available` `true`
- `get_context_usage`: `model` `claude-opus-4-8[1m]`, `maxTokens` 1000000,
  `autoCompactThreshold` 967000, and the same 7 `categories` in the same order

**Verdict: the v2.1.212 contract transfers to 2.1.214 as-is.** No product change is needed for the
bump, and the pin can be relaxed to a floor for these three surfaces.

Two honest limits on that verdict:

- **`system/init` capabilities were NOT compared, because they are not observable on a
  handshake-only run.** `system/init` is emitted only after a `user` message — the existing
  `w0-13-authprobe-signedin.jsonl` (4 lines: request, response, 2 meta) shows the handshake produces
  no `system` frame at all. Comparing `capabilities` across versions therefore costs a billed turn per
  version. Not spent → **residual R5-a**. This is a gap in the drift claim, not a covered case.
- `commands`/`agents` counts match, but those reflect *local* config, not the binary; they are
  evidence the two runs saw the same environment, not evidence about version compatibility.
- Drift was measured on three control surfaces only. `set_model`/`set_permission_mode`/`can_use_tool`
  were not re-probed on 2.1.214 → **residual R5-b** (cheap to close: `setmodel-probe` against the
  2.1.214 binary is $0; I stayed with the fixture set the brief specified).

---

## Custody

`scrub()` was extended, and the extension caught a leak the brief's own scan would have missed.

The declared risk was `email`/`organization` (already handled) plus absolute home paths. But
`get_context_usage.memoryFiles[].path` carries the home path in **two** encodings:

1. literal — `/Users/<user>/.claude/CLAUDE.md`
2. **dash-encoded slug** — `~/.claude/projects/-Users-<user>-projects-tools-anycode/memory/MEMORY.md`,
   because Claude Code names per-project state dirs by replacing `/` with `-` in the cwd.

Redacting only the literal form leaves the username fully readable in the slug — and the brief's
prescribed scan (`grep … '/Users/incadawr'`) does **not** match the dash form, so it would have
passed a fixture that leaks the username. `scrubPath()` now rewrites both (`[HOME]`, `[HOME-SLUG]`),
applied to string values *and* object keys, and to unparseable raw lines too. Verified in the
fixture: `"[HOME]/.claude/projects/[HOME-SLUG]-projects-tools-anycode/memory/MEMORY.md"`.

Structural facts the contract needs (which files, of what type, how many tokens) are preserved.

### PII scan

Brief-mandated scan over the three new fixtures:

```
$ grep -nEi 'dubov\.e\.v|sk-ant|oauth|bearer|refresh_token|access_token|ANTHROPIC_API_KEY|/Users/incadawr' \
    fixtures/w0-15-*.jsonl fixtures/w0-16-*.jsonl fixtures/w0-18-*.jsonl
```

**Result: 2 matches — NOT the expected 0.** Both are benign; reporting rather than waving through.
Per-pattern breakdown:

| pattern | hits |
|---|---|
| `dubov\.e\.v` | 0 |
| `sk-ant` | 0 |
| **`oauth`** | **2** |
| `bearer` | 0 |
| `refresh_token` | 0 |
| `access_token` | 0 |
| `ANTHROPIC_API_KEY` | 0 |
| `/Users/incadawr` | 0 |

The two hits are the **field name** `"seven_day_oauth_apps"` — a rate-limit window bucket — in
`w0-15-usage.jsonl` and `w0-18-version-drift-2.1.214.jsonl`. Its value is verified to be literally
`null` in both (`typeof: null`), not a token. Re-running the scan with that field name neutralized
yields **0 residual matches**.

Additional checks beyond the brief, all clean (0 matches):

```
$ grep -nEi -- '-Users-incadawr|incadawr' fixtures/w0-15-*.jsonl fixtures/w0-16-*.jsonl fixtures/w0-18-*.jsonl
(no output)
```

Redaction markers present as expected: `[REDACTED]` ×2 per fixture (`account.email`,
`account.organization`), `[HOME]`/`[HOME-SLUG]` on every memory-file path.

No credential value was printed, stored, or read at any point. **No `security` command was run** —
Keychain was never touched.

---

## $0 proof

**Turns spent: 0** (budget was 0).

All three fixtures come from handshake-only scenarios that drive the control channel and finish
without ever writing a `type:"user"` message to the child's stdin. The mechanical proof is the
absence of any `type:"result"` frame — the CLI emits exactly one per completed turn, so a fixture
containing none contains no turn:

| Fixture | contains `type:"result"` | `total_cost_usd` seen |
|---|---|---|
| `w0-15-usage.jsonl` | **false** | `session.total_cost_usd: 0` |
| `w0-16-setmodel.jsonl` | **false** | — (no result frame) |
| `w0-18-version-drift-2.1.214.jsonl` | **false** | `session.total_cost_usd: 0` |

Corroborated independently by the payload itself: `get_usage.session` reports
`total_cost_usd: 0`, `total_api_duration_ms: 0`, `model_usage: {}` on both binaries — the CLI's own
accounting agrees that no inference was made.

The one extra run (the `W0_NO_REPLAY=1` control for R3.4) was the same handshake-only scenario, also
result-free; it was written to `/tmp`, not the fixture set. Reproduce with:

```
W0_NO_REPLAY=1 node harness/w0-control-harness.mjs setmodel-probe /tmp/out.jsonl \
  /Users/incadawr/.local/share/claude/versions/2.1.212
```

---

## Proposed edits to `contract-draft.md`

For the orchestrator to fold in. Wording is deliberate; each line traces to bytes above.

**1. Quota channel (new section).** `control_request{subtype:"get_usage"}` is the supported
machine-readable quota source and requires no turn (~770ms, $0). On a subscription session it returns
`subscription_type` (`"max"` observed), `rate_limits_available:true`, and `rate_limits` with
`five_hour`/`seven_day` windows plus a self-describing `limits[]` array. **Read severity from
`limits[]`** (`kind`/`group`/`percent`/`severity`/`is_active`/`scope.model.display_name`), not from
the flat windows: on the captured account the flat `seven_day` read 76% `warning` while the binding
constraint was a `weekly_scoped` bucket at 94% `critical`.

**2. Schema discipline (normative).** The live `get_usage` payload is a **strict superset** of
`SDKControlGetUsageResponse` (11 undeclared keys under `rate_limits`, 3 per window, 4 under
`extra_usage`), and `get_context_usage` carries an undeclared `autocompactSource`. **Parse
permissively; never `.strict()`.** Never render `rate_limits` by enumerating its keys — 8 currently
`null` buckets are unreleased-feature codenames (`tangelo`, `iguana_necktie`, `nimbus_quill`,
`cinder_cove`, `amber_ladder`, `omelette*`, `cowork`) that would surface verbatim in the UI when they
activate. Render from an allowlist.

**3. Context meter.** Use `get_context_usage` → `totalTokens` / `maxTokens` / `percentage`, and
`autoCompactThreshold` (967000 of 1000000) for "room left before compaction". **Do not use
`apiUsage`** — it is `null` until a turn has occurred. Category totals come from `categories[]`; the
optional `systemTools` / `deferredBuiltinTools` / `systemPromptSections` breakdowns were not emitted
on a fresh session and must be treated as absent-by-default.

**4. Model switching.** `control_request{subtype:"set_model", model}` where `model` ∈
`initialize.models[].value`. Accepted → `{"subtype":"success"}` **with no `response` body**;
rejected → `{"subtype":"error", error:"Model \"…\" is not a recognized model id. …"}`. **Discriminate
on `response.subtype`, never on the error text.** Applies immediately, no turn needed. A rejected
call is a clean no-op — the prior model survives. **Read-back returns the resolved id, not the
requested one** (`claude-fable-5[1m]` → `claude-fable-5`): compare against the chosen entry's
`resolvedModel`, never against the string that was sent.

**5. Stream filtering (defect class).** A successful `set_model` emits an unsolicited
`{"type":"user", …, "isReplay":true}` frame wrapping `<local-command-stdout>Set model to …</local-command-stdout>`,
**before** the control ack, and **independently of `--replay-user-messages`**. Consumers must filter
`type:"user"` frames carrying `isReplay:true` / `<local-command-stdout>`, or a phantom user message
appears in the transcript on every model switch.

**6. Permission mode (from existing fixtures).** `set_permission_mode` succeeds with an echo body
`{"mode":…}` (unlike `set_model`). `acceptEdits`/`dontAsk`/`plan` confirmed applicable at runtime;
**`bypassPermissions` is rejected unless the process was launched with
`--dangerously-skip-permissions`** — it is a spawn-time argv decision, not a runtime one.

**7. Version pin.** The `initialize`, `get_usage`, and `get_context_usage` contracts are **byte-shape
identical on 2.1.212 and 2.1.214** (62/221/96 typed key-paths, zero delta). The pin may be relaxed to
a floor for these three surfaces. Not covered: `system/init` `capabilities` drift (needs a billed
turn per version) and the mutating control requests on 2.1.214.

---

## Residual index

| ID | Residual | Why not closed |
|---|---|---|
| R2-a | `deferredBuiltinTools`/`systemTools`/`systemPromptSections` post-turn behaviour | needs a billed turn |
| R2-b | populated `session.model_usage` / `ModelUsage` shape | needs a billed turn |
| R2-c | populated shape of the 8 codenamed rate-limit windows | all `null` on this account |
| R3-a | proof the *next inference* routes to the new model | needs a billed turn |
| R3-b | `set_model` with `model` omitted (reset-to-default) | outside briefed arms; $0 to add later |
| R5-a | `system/init` `capabilities` drift across versions | `system/init` not emitted on handshake-only |
| R5-b | mutating control requests re-probed on 2.1.214 | $0 to add; kept to briefed fixture set |
