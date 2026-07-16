# Codex rollout fixtures

Scrubbed excerpts of REAL `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files, collected for
gold-tests of the future rollout → `HistoryItem[]` importer (see
`working-docs/build/design/slice-codex-profiles-cut.md` §1.3 and §8.3). Every fixture is
structurally a real trace — no invented record shapes. `scrub.mjs` is the exact tool used to
produce them from the source files and doubles as origin documentation.

Scan basis: 721 real rollout files under `~/.codex/sessions/` were scanned read-only (never
written to) to find real specimens for every required record shape before falling back to
truncation or intentional injection.

## Coverage matrix

Numbers refer to the coverage checklist (1 = plain chat, 2 = `exec_command` call/output pairs,
3 = `apply_patch` custom_tool_call + output, 4 = `exec` custom_tool_call with raw-string input,
5 = `message{role:"developer"}`, 6 = `reasoning` with empty AND non-empty `summary`, 7 =
`input_image`, 8 = unpaired call (no output), 9 = `custom_tool_call_output` with array output, 10
= a deliberately malformed JSON line, 11 = `web_search_call` / other exotic type).

| Fixture | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `basic-chat-developer-reasoning.jsonl` | x | | | | x | x(empty) | | | | | |
| `exec-pairs-and-apply-patch.jsonl` | | x | x | | x | x(empty) | | | | | |
| `exec-custom-tool-call-array-output.jsonl` | | | | x | x | | | | x | | |
| `unpaired-call-and-web-search.jsonl` | | | | | x | x(empty) | | x | | | x (`web_search_call`) |
| `input-image.jsonl` | | | | | x | x(empty) | x | | | | |
| `reasoning-nonempty-summary.jsonl` | | x | | | x | x(non-empty) | | | | | |
| `tool-search-and-batched-exec.jsonl` | | x | | | x | x(empty) | | | | | x (`tool_search_call`/`_output`) |
| `agent-message-inter-agent.jsonl` | | | | x | x | x(empty) | | | x | | x (`agent_message` as `response_item`, `inter_agent_communication_metadata`) |
| `malformed-json-line.jsonl` | x | | | | x | x(empty) | | | | x | |

All 11 checklist items are covered; ≥8 fixtures were requested, 9 were produced.

## Amendment (TASK.52, lane D): tier-2 default-skip fixture

AMENDMENT-1 §A5 (post-W0-R3) requires a three-tiered default-skip in the importer: an
unrecognized top-level record type (tier 1 — covered above by
`agent-message-inter-agent.jsonl`'s real `inter_agent_communication_metadata` record), an
unrecognized `response_item.payload.type` (tier 2), and an unrecognized content-part type inside
`content` (tier 3 — covered above by that same fixture's real `encrypted_content` part). Tier 2
was NOT found in any of the 721 scanned real files (every `response_item.payload.type` observed
matches the design doc's enumeration or the two anomalies already covered), so per the task's own
instruction ("synthetic MINIMAL fixture ... if none is found in the existing corpus") a small
**synthetic** fixture was added instead of a scrubbed real one:

### `unknown-item-type.jsonl` (synthetic, NOT derived from a real session)

- **Content:** minimal 5-line file — `session_meta` + `turn_context` + a real `user` message +
  one invented `response_item` whose `payload.type` is `"future_streaming_delta"` (a shape that
  does not exist in any Codex CLI version seen; chosen to read plausibly as "a future item type"
  without colliding with any real payload name) + a real `assistant` message.
- **Purpose:** proves the importer's tier-2 default-skip: the unknown item is skipped whole
  (`stats.unknownItemsSkipped === 1`), does NOT collapse to text (per §A5, an unknown payload may
  carry opaque/encrypted content unsafe to print), and does not stop the surrounding `user`/
  `assistant` messages from importing normally.
- No scrubbing needed (no real user data, paths, or secrets — everything in the file was written
  by hand for this fixture).

## Fixture-by-fixture provenance

### `basic-chat-developer-reasoning.jsonl`
- **Source:** `~/.codex/sessions/2026/04/08/rollout-2026-04-08T17-10-56-019d6d6e-929a-79e1-baa4-0191003bae96.jsonl`
  (13-line file, taken whole — smallest real session found with no tool calls at all).
- **Cut:** none — entire source file (all 13 lines), verbatim order.
- **Content:** `session_meta` → `developer` message (sandbox/skills instructions) → 2×`user`
  message → `reasoning` (empty `summary`) → `assistant` message. A one-shot "say X" MCP smoke
  session — no tool calls anywhere, exactly the "chistый chat" shape.

### `exec-pairs-and-apply-patch.jsonl`
- **Source:** `~/.codex/sessions/2026/05/01/rollout-2026-05-01T23-47-12-019de54b-a302-7203-b37e-263162c638d6.jsonl`
  (28-line file, taken whole).
- **Cut:** none — entire source file.
- **Content:** two `function_call{name:"exec_command"}`/`function_call_output` pairs bracketing
  one `custom_tool_call{name:"apply_patch"}`/`custom_tool_call_output` pair (string output). A
  real multi-agent "design discussion round" session (`cwd: /tmp/feature-dev-discussion`), no
  personal data beyond the harness boilerplate.

### `exec-custom-tool-call-array-output.jsonl`
- **Source:** `~/.codex/sessions/2026/07/12/rollout-2026-07-12T21-30-58-019f5798-ca2c-7c12-9b30-67eff08b708f.jsonl`
  (21-line file, taken whole).
- **Cut:** none — entire source file.
- **Content:** `custom_tool_call{name:"exec", input: <raw JS string>}` (not JSON — a literal
  `const patch = "..."; ...` script body) paired with a `custom_tool_call_output` whose `output`
  is an **array** of `{type:"input_text", text}` parts (not a plain string) — the exact shape
  flagged in §1.3/§8.3. Also carries a `world_state` top-level record. Session is our own
  Codex-engine smoke test (`cwd: /private/tmp/anycode-codex-w0/repo`, `originator: "anycode"`).

### `unpaired-call-and-web-search.jsonl`
- **Source:** `~/.codex/sessions/2026/05/25/rollout-2026-05-25T22-10-04-019e608b-55fd-7313-a828-cfd26c00200f.jsonl`
  (28-line file, taken whole).
- **Cut:** none — entire source file, ends exactly where the real session did.
- **Content:** 5× `web_search_call` (with completed `open_page` actions), then a final
  `function_call{name:"search", namespace:"mcp__ozon__"}` with **no matching
  `function_call_output`** — the session was genuinely cut off mid-tool-call. **This is one of
  the exactly 2 naturally-occurring unpaired calls found across all 721 scanned files** (the
  other lives in a 1.1 MB file, not used here to keep the fixture small); no truncation was
  needed to produce this specimen — it is a REAL interrupted turn, not derived-by-truncation.

### `input-image.jsonl`
- **Source:** `~/.codex/sessions/2026/07/14/rollout-2026-07-14T21-07-16-019f61cf-cd55-7971-8900-c59bd933024d.jsonl`
  (622 KB original; smallest of the 17 files found with an `input_image` part).
- **Cut:** first 12 lines (`session_meta` + `task_started` + 3×`developer` + `user` +
  `world_state` + `turn_context` + the `user` message carrying `input_image` + `reasoning` +
  `agent_message`/`assistant`), dropping the remainder of the (long) session.
- **Scrub note:** the real base64 PNG payload (≈179 KB) was replaced by `scrub.mjs` with a tiny
  valid 1×1 PNG, encoded the same way (`data:image/png;base64,...`), keeping the 3-part
  `content` array shape (`input_text` clipboard-path marker → `input_image` → `input_text`
  closing tag → `input_text` question) intact. This is what shrank the fixture from ~180 KB to
  ~31 KB — content was scrubbed, not the record shape.

### `reasoning-nonempty-summary.jsonl`
- **Source:** `~/.codex/sessions/2026/04/11/rollout-2026-04-11T16-32-05-019d7cbe-1583-7bc2-a1a9-069617cb1413.jsonl`
  (986 KB original; one of only **2 files out of 721** where any `reasoning.summary` is
  non-empty — confirms the design doc's "93 of 10458" measurement is real and rare).
  Line 149 was the first hit of the file for the required shape.
- **Cut:** `session_meta` (line 0) + lines 140–156 (a mid-session window), which is NOT a file
  prefix — a representative fragment was excised from the middle of a long session, per the
  "усечение до репрезентативного фрагмента" allowance. The window was widened once
  (140–155 → 140–156) specifically to include the `function_call_output` that pairs with the
  last `function_call` in range — an early cut had accidentally produced a SECOND, unintended
  unpaired call as a truncation artifact; the fixture's purpose is the non-empty reasoning
  summary, not unpaired calls, so pairing was restored.
- **Content:** 4 `reasoning`/`function_call{exec_command}`/`function_call_output` turns; the 3rd
  `reasoning` record (originally line 149) has a non-empty
  `summary: [{"type":"summary_text","text":"**Analyzing roll reveal logic..."}]` — real model
  reasoning text about an unrelated project, left intact (no secrets, no PII beyond generic
  engineering discussion).

### `tool-search-and-batched-exec.jsonl`
- **Source:** `~/.codex/sessions/2026/06/18/rollout-2026-06-18T22-07-02-019edc21-2ebe-7c13-a539-8622b3398126.jsonl`
  (898 KB original; the only file across all 721 with a `tool_search_call`/`tool_search_output`
  pair).
- **Cut:** first 32 lines (`session_meta` through the `tool_search_call`/`tool_search_output`
  pair at the original lines 30–31), dropping the rest of a long session.
- **Content:** demonstrates **multiple `function_call{exec_command}` records back-to-back in one
  turn** (3, then 4 calls) followed by all of their `function_call_output`s in the same order —
  the exact "batch assistant tool_calls, flush one tool message on first output" shape from §8.6
  — plus the `tool_search_call`/`_output` exotic pair. One `function_call_output` (38 KB, a long
  `rg`/`find`-style command dump) was truncated by `scrub.mjs`'s generic >4000-char leaf cap;
  structure (still one `function_call_output` record) is unchanged.

### `agent-message-inter-agent.jsonl`
- **Source:** `~/.codex/sessions/2026/07/14/rollout-2026-07-14T23-17-07-019f6246-aed9-7b51-b49c-77f2c92f7213.jsonl`
  (377 KB original; smallest of 18 files with a `response_item.payload.type === "agent_message"`
  record — distinct from the far more common `event_msg{type:"agent_message"}`).
- **Cut:** `session_meta` (line 0) + lines 39–52 (a mid-session window covering one full turn),
  not a prefix.
- **Content / anomaly found:** a `response_item` of type `agent_message` with `author`/
  `recipient` fields (`"/root"` → `"/root/terra_d1_recon"`) and a content array containing an
  `{type:"encrypted_content", encrypted_content: "..."}` part — a THIRD content-part shape
  alongside `input_text`/`output_text`/`input_image`, not enumerated in §1.3's part-type table.
  Also present: a **top-level `inter_agent_communication_metadata` record**
  (`{"type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}`) — a 6th
  top-level record type beyond the five listed in §1.3 (`session_meta`, `turn_context`,
  `response_item`, `event_msg`, `world_state`). Both are **real, observed anomalies against
  §1.3** worth flagging to the importer author: the record-type enumeration in the design doc is
  not exhaustive, and importer code must not `switch`-exhaust on it without a `default: skip`.
  Also carries one `custom_tool_call{name:"exec"}`/`custom_tool_call_output` pair and a
  `world_state`/`turn_context` pair. This is one of our own multi-agent orchestration sessions
  (`cwd` under `/Users/incadawr/projects/tools/anycode` — scrubbed).

### `malformed-json-line.jsonl`
- **Source:** same file as `basic-chat-developer-reasoning.jsonl` (04/08 session), reused because
  it is the smallest clean specimen available.
- **Cut:** entire 13-line file, PLUS **one intentional injection**: line index 5 (the second
  `user` message, `"Say \"Codex MCP is working\"..."`) was truncated mid-JSON-string by
  `scrub.mjs --corrupt-line 5` (cut at 60% of the line's length, leaving a dangling open
  brace/string). **This does not occur naturally** — 0 malformed lines were found across all 721
  real files scanned — so per the task instructions it is deliberately injected and documented
  here rather than left unrepresented. All other 12 lines in the file remain valid JSON, so a
  gold-test can assert: `stats.malformedLines === 1`, and every other line's content still
  produces the expected `HistoryItem`s (import must not throw on this line, only skip it).

## Scrub rules (`scrub.mjs`)

Applied to every leaf string of every JSON record, in this order:
1. Base64 PNG/JPEG data URIs → a tiny valid 1×1 PNG (`data:image/png;base64,...`), keeping the
   part's shape unchanged.
2. SSH-style git remotes (`git@host:owner/repo.git`) → `git@scrubbed:scrubbed/scrubbed.git`
   (run BEFORE the e-mail regex, which would otherwise treat `git@host` as an address and leave
   the real owner/repo slug exposed).
3. E-mail addresses (anything not already `@example.com`) → `user@example.com`.
4. Absolute home paths `/Users/<name>/` → `/Users/scrubbed/`.
5. `https://user@host/...`-style credentialed URLs → `https://scrubbed@host/...`.
6. Secret-shaped tokens (`sk-…`, `ghp_…`, `gh[oprsu]_…`, `Bearer …`, `api_key=…`/`secret=…`/
   `access_token=…`) → `SCRUBBED`.
7. `reasoning.encrypted_content` and any part named `encrypted_content` → the literal string
   `"SCRUBBED-OPAQUE"` (per task instructions — the field is opaque ciphertext, useless for
   tests, and unnecessary to preserve byte-for-byte).
8. Any remaining leaf string longer than 4000 characters is truncated with a
   `…[truncated N chars for fixture size]` marker (keeps big real command outputs from blowing
   past the ~200 KB fixture cap without altering record shape).

`scrub.mjs` also accepts `--corrupt-line <idx>` to intentionally truncate one line's raw JSON
(used only for `malformed-json-line.jsonl`), and always keeps `session_meta` (line 0 of the
source) as the fixture's first line even when a `--lines a-b` window starts later in the file.

## Verification performed

`grep`-swept every fixture for: e-mail addresses other than `@example.com`, `/Users/` paths other
than `/Users/scrubbed/`, the real system username, and `sk-`/`ghp_`/`Bearer` secret shapes — zero
hits in all cases. Also verified, per fixture, that the set of `call_id`s appearing in
`function_call`/`custom_tool_call` records equals the set appearing in
`function_call_output`/`custom_tool_call_output` records — except
`unpaired-call-and-web-search.jsonl`, where exactly one call is (deliberately, and really)
unpaired, matching the design doc's "2 unpaired calls in 662 files" measurement.
