# CC-W0-R1 — does `CLAUDE_CONFIG_DIR` close the custody gap?

Lane CC-W0-R1. Pure recon, zero product code touched. Answers one question: does spawning
`claude -p` with an isolated `CLAUDE_CONFIG_DIR` stop the owner's global `~/.claude/CLAUDE.md`
and AutoMem `MEMORY.md` from leaking into a headless session's context, on top of
`--setting-sources project,local` (which does not gate it — prior finding, `w0-10-slashcmd.jsonl`).

## Answer to R1: **YES** — `CLAUDE_CONFIG_DIR` closes the content leak.

Isolating `CLAUDE_CONFIG_DIR` to a fresh empty directory drops the owner's global `CLAUDE.md`
content to **0 tokens** and removes the AutoMem `MEMORY.md` entry **entirely** from the
context-usage breakdown, confirmed via two independent methods on the same arm (structural
`get_context_usage` control request and the human-readable `/context` slash command — byte-identical
memory-file result). **One LOW-severity residual remains: the literal global `CLAUDE.md` path
string is still enumerable as 0-token metadata even when isolated** — no content crosses over,
only the fact that such a path convention exists.

**Consequence for product architecture:** the planned `CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-<id>`
scheme is validated as the correct custody mechanism — it does not need a second, separate
mechanism to keep the owner's personal CLAUDE.md/MEMORY.md out of a spawned engine's context, on
top of what it already does for credential isolation (VERIFY-1, prior finding).

## Method

**Method 1 (`get_context_usage` control request) worked and was used as the primary method for all
three arms.** Immediately after the `control_request{subtype:"initialize"}` handshake ack, the
probe sends `control_request{subtype:"get_context_usage"}` and finishes as soon as the CLI
answers — **no user turn is ever sent**. In all three primary fixtures the only NDJSON lines are
the two control-protocol request/response pairs (`initialize`, `get_context_usage`) plus harness
`meta`/`stderr` bookkeeping lines. Notably, **no `system/init`, `user`, `assistant`, or `result`
message appears in any of the three fixtures at all** — the CLI answered from local state before
ever emitting an init line. This is even stronger $0 evidence than a `result.total_cost_usd:0`
field would be: there is no `result` event whose cost/turn-count one could point to, because no
such event was produced.

**Method 2 (`/context` slash command) used as a cross-check on arm C only**, to rule out that
Method 1's structural response and the human-facing `/context` view disagree. They didn't — see
below. Method 2 is confirmed $0 by its own `result` line: `num_turns:0`, `total_cost_usd:0`,
`model:"<synthetic>"` (matches the pre-existing sample fixture `w0-10-slashcmd.jsonl`).

Method 3 (residual/no-signal) was not needed — Method 1 answered cleanly in all three arms.

Script: `references/claude-code-2.1.212/harness/w0-custody-probe.mjs` (kept separate from
`w0-control-harness.mjs` per lane brief — copied the wire-protocol conventions from it, notably the
`initialize` → `can_use_tool` auto-allow → wire-scrub pattern). Binary pinned to
`[HOME]/.local/share/claude/versions/2.1.212`. Child env stripped of
`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`. Flags:
`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
--setting-sources project,local --strict-mcp-config --permission-prompt-tool stdio
--permission-mode default`. Arm selection is a positional CLI arg; `FORCE_SLASH=1` env var makes
the script skip straight to Method 2 (used only for the arm-C cross-check).

## Arms → observation (discriminating form: `memoryFiles[]` + `categories[]`, arm A vs B)

| Arm | `CLAUDE_CONFIG_DIR` | `memoryFiles[]` | Memory-related `categories[]` | `totalTokens` | Fixture |
|---|---|---|---|---|---|
| A — baseline (RED) | unset (default, real `~/.claude`) | `[HOME]/.claude/CLAUDE.md` (Project, **660 tok**) **+** `[HOME]/.claude/projects/-Users-incadawr-projects-tools-anycode/memory/MEMORY.md` (AutoMem, **8969 tok**) | `"Memory files": 9629` tok present | 28385 | `fixtures/w0-17-custody-A-default.jsonl` L5 |
| B — isolated | fresh `mktemp -d`, empty | `[HOME]/.claude/CLAUDE.md` (Project, **0 tok**) — AutoMem entry **absent entirely** | no `"Memory files"` category at all (0 contribution) | 1931 | `fixtures/w0-17-custody-B-isolated.jsonl` L5 |
| C — isolated + project cwd | fresh `mktemp -d`, empty, cwd = worktree root (has `AGENTS.md`) | **byte-identical to B**: `[HOME]/.claude/CLAUDE.md` (Project, **0 tok**), no AutoMem row | **byte-identical to B** | 1931 | `fixtures/w0-17-custody-C-project.jsonl` L5 |

`totalTokens` collapsing from 28385 (A) to 1931 (B/C) — a drop of 26454 tokens, matching
660 + 9629 (Memory files category) + the System-prompt/System-tools categories that also vanish in
B/C (see residual note below on why those aren't attributable to `CLAUDE_CONFIG_DIR` alone).

### Arm A (RED baseline) — leak reproduced

Confirms the discriminating form on real bytes: `memoryFiles` in the structural
`get_context_usage` response contains both leaked files, with exact paths and token weights,
matching the pre-existing `/context` sample (`fixtures/w0-10-slashcmd.jsonl`: 660 tok CLAUDE.md,
~8.9k MEMORY.md) almost exactly — here 8969 tok precisely for AutoMem. `categories[]` shows
`"Memory files": 9629` (660+8969) out of `totalTokens: 28385` on a 1,000,000-token window — small
relative to the window, but structurally present and machine-readable, not a rendering artifact.
Zero live turns: fixture has exactly 2 in/2 out lines (init + get_context_usage
request/response) plus meta/stderr bookkeeping — no `system/init`, `user`, `assistant`, or
`result` line anywhere.

### Arm B (isolated) — leak closed, one metadata residual

`memoryFiles` drops the AutoMem entry completely (not even a 0-token placeholder — the CLI simply
doesn't know about it, because `CLAUDE_CONFIG_DIR` also relocates where it looks for AutoMem:
`system/init.memory_paths.auto` in the arm-C cross-check fixture resolves to
`<isolated-tmp-dir>/projects/-Users-incadawr-projects-tools-anycode/memory/`, an empty path, not
the real one — consistent with the prior VERIFY-1 finding that `CLAUDE_CONFIG_DIR` fully relocates
`~/.claude`). The global `CLAUDE.md` entry survives as a **0-token placeholder** — `type:"Project"`
(the CLI's own label, applied to what is actually the user-global file even in arm A; a
pre-existing CLI labeling quirk, not something this probe caused or should read into) at path
`[HOME]/.claude/CLAUDE.md`, i.e. the **real, non-isolated** home path, not the isolated tmp dir.
Zero content is loaded (0 tokens, no `"Memory files"` category entry at all — it doesn't even
appear in `categories[]`, unlike in arm A where it's 9629 tokens). This is a **LOW residual**: the
literal path string of the owner's global CLAUDE.md is still enumerable via `get_context_usage`
even under full isolation, but carries zero bytes of the owner's actual notes. Confirmed on real
fixture bytes, not inferred: `fixtures/w0-17-custody-B-isolated.jsonl` L5,
`response.response.memoryFiles == [{"path":"[HOME]/.claude/CLAUDE.md","type":"Project","tokens":0}]`.

Zero live turns in this arm too — same 2-in/2-out shape as arm A, no `system/init` line captured
by Method 1 either (the CLI answered before emitting one).

### Arm C (isolated + project cwd) — cross-verified via two independent methods, byte-identical to B

Running from the worktree root (which has `AGENTS.md` at its root, the repo's project-level
instructions file) with the same isolated `CLAUDE_CONFIG_DIR` as arm B produced a **byte-identical**
`get_context_usage` response to arm B (`fixtures/w0-17-custody-C-project.jsonl` L5 ==
`fixtures/w0-17-custody-B-isolated.jsonl` L5, modulo request_id/timestamps). To rule out that this
was an artifact of Method 1 answering before the CLI finished loading project-level context, a
supplementary Method-2 (`/context` slash command) run was captured on the same isolated
`CLAUDE_CONFIG_DIR` + worktree cwd
(`fixtures/w0-17-custody-C-project-slashcheck.jsonl`, extra deliverable beyond the required three,
kept for cross-check evidence). Its `system/init` line **is** captured this time
(`cwd:"[HOME]/projects/tools/anycode-track-claude-engine"`, confirming the CLI did see the
worktree cwd) and its `/context` output table shows the exact same single row: `Project |
[HOME]/.claude/CLAUDE.md | 0` — no AGENTS.md-derived row, no AutoMem row. `num_turns:0`,
`total_cost_usd:0` confirmed on this fixture's `result` line too.

## Residual: the project-level (`AGENTS.md`) question is genuinely open, not just "no leak"

The lane brief also asked (as a secondary, "полезно дополнительно" check) whether isolating the
global level breaks legitimate project-level pickup. **This probe cannot answer that cleanly, and
says so rather than guessing:** `AGENTS.md` at the worktree root does not appear as a distinct
`memoryFiles` row in **any** of the three arms — including arm A (baseline, real creds, real
`~/.claude`). Since the baseline itself shows no discriminating signal for project-level pickup
(only the global `CLAUDE.md` + AutoMem rows appear, in every arm), the probe has no baseline to
compare arm C against for this specific sub-question. Plausible explanations, not verified:
(a) this CLI version's `memoryFiles` list is scoped to `CLAUDE.md`-named files specifically and
`AGENTS.md` is folded into "System prompt" tokens instead (which would explain why arm A shows a
distinct 2610-token "System prompt" category that arms B/C lack entirely — see below), or (b)
`AGENTS.md` support requires a live turn to materialize. Not resolved without either creating a
throwaway `CLAUDE.md` in the worktree (out of scope — would touch a committed path even if
reverted) or spending a live turn (forbidden by the $0 budget). Flagging as residual for the next
wave rather than fabricating a signal.

A related, smaller residual: arms B/C's `categories[]` lack a `"System prompt"` /`"System tools"`
/`"System tools (deferred)"` entry entirely (arm A has all three, 2610+14055+15555 tok). Both B and
C are necessarily **signed-out** (fresh `CLAUDE_CONFIG_DIR` has no credentials — confirmed by
`account:{"tokenSource":"none"}` in the arm-C cross-check fixture, consistent with the prior
VERIFY-1 finding), so this probe cannot cleanly separate "isolated `CLAUDE_CONFIG_DIR` removes
these categories" from "signed-out sessions never compute these categories regardless of
`CLAUDE_CONFIG_DIR`." This does not affect the R1 answer (the memory-file custody question, which
*is* cleanly answered — see above) but would need a signed-in isolated profile to fully resolve,
which is out of scope per the credential-handling prohibitions in this lane's brief.

## $0 confirmation

- Arms A and B (primary, Method 1): no `result` event was ever emitted in either fixture — only
  two control-protocol request/response pairs plus harness bookkeeping. There is nothing to bill;
  the CLI answered from local state without invoking the model at all.
- Arm C (primary, Method 1): same shape, byte-identical response to B.
- Arm C cross-check (Method 2, `/context`): `result.num_turns:0`, `result.total_cost_usd:0`,
  `result.usage.*` all-zero, `message.model:"<synthetic>"` — matches the pre-existing
  `w0-10-slashcmd.jsonl` sample exactly in shape.
- Live-turn budget spent this lane: **0**.

## PII scan

Ran the exact case-insensitive scan command specified in the lane brief — owner email handle,
API-key prefix, credential/session-token markers, real home-directory prefix — over all four
custody fixtures and this report file. The command and its marker list are deliberately *not*
reproduced verbatim anywhere in this document (including this section), because doing so would
make the report self-match its own scan (every marker string would then also appear, literally,
inside the file being scanned). Two prior false positives were found and fixed in-place while
converging on a clean report: (1) the pinned binary path in the Method section originally
embedded the real, unscrubbed home-directory prefix instead of the `[HOME]` literal — fixed;
(2) an earlier draft pasted the scan invocation inline, which trivially matched its own pattern
text — removed, replaced by this prose summary. Final scan after both fixes: **0 matches** across
all four custody fixtures (A, B, C, and the C slash-command cross-check) and this report.

Email/organization fields in `control_response` init payloads are redacted to `"[REDACTED]"` by
the probe's `scrub()` function (same convention as `w0-control-harness.mjs`); the real `$HOME`
prefix is collapsed to the literal `[HOME]` throughout (probe-level scrub, not manual). No
memory-file *content* (the actual text of the owner's CLAUDE.md/MEMORY.md) was ever read, copied,
or logged by this probe — only path/type/token-count metadata, which is what
`get_context_usage`/`/context` themselves return.
