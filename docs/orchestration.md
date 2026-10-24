# Orchestration: GLM lead, optional Flash, GPT/Codex supervisor

Portable example setup for running a multi-model workflow inside AnyCode:
**GLM-5.3 plans, implements and self-reviews**; an **optional inline GLM-5.3
Flash** handles narrow, fully-resolved execution; a **GPT (Codex CLI)
supervisor** independently verifies, returns defects, and accepts.

Requires **AnyCode 0.0.30 or newer**.

## The three roles

| Role | Runs on | Spawned as | Does |
|---|---|---|---|
| Supervisor | Codex CLI (GPT), a normal AnyCode session | top-level session you drive | dispatches, awaits, verifies, accepts |
| `glm-lead` | Native engine, `glm-5.3` | session-tier child via `anycode_agent` | plans, implements, self-reviews |
| `flash-builder` (optional) | Native engine, `glm-5.3-flash` | inline child spawned by `glm-lead` | one bounded, fully-resolved task |

A second layout splits the lead in two (`examples/orchestration/supervisor-plan-execute.md`):
`glm-planner` (`glm-5.3`, `effort: high`, read-only) returns one executable
plan, and an executor — `glm-executor` (`glm-5.3`, `effort: low`) or
`flash-executor` (`glm-5.3-flash`, `effort: low`) — carries it out from a fresh
context. Both are session children the supervisor dispatches in turn.

Inline vs session is a real difference, not a naming one:

- An **inline** child (`flash-builder`) runs inside `glm-lead`'s process as a
  nested agent loop, shares the parent's workspace ports, is bounded by a
  turn budget, and cannot be opened or steered separately.
- A **session** child (`glm-lead`, spawned by the supervisor's session) boots
  its own host and appears as a real child session the user can open, watch
  and steer; it is the only tier the Codex bridge can reach.

## Setup

### 1. Codex account (the supervisor)

Any session on the Codex CLI needs the binary and a signed-in account. In
**Settings → Codex**: install or locate the `codex` binary, then sign in
(browser or device code) under the account profile you will actually use — if
you configured a `personal` profile earlier, pick that one before starting;
the session is frozen to its profile for its lifetime. **Use current
account** links an existing `~/.codex/auth.json`. Details:
[Codex onboarding](development/codex-onboarding.md).

### 2. Z.AI connection (GLM models)

In **Settings → Connections**, add a connection for the built-in **Z.AI (GLM)**
provider (`https://api.z.ai/api/anthropic`) with your Z.AI API key and select
`glm-5.3` as its model. Only an **unrouted** profile inherits the parent
session's active connection, so if every profile you dispatch declares its own
`connection:`/`provider:` (below) the parent's active connection no longer has
to be the Z.AI one.

#### Per-profile connection routing

A profile may select the connection its child runs on, so one supervisor
session can drive, say, `glm-planner` on a GLM connection and `ds-executor` on
a DeepSeek one:

- `connection: <connection-id>` — an **exact** connection id as shown in
  Settings → Connections. Use this to pin a specific account.
- `provider: <catalog-provider-id>` — a provider id such as `z-ai` or
  `deepseek`. The host picks a configured connection for that provider: the
  active connection if its provider matches, otherwise the first matching
  configured connection. Use `connection:` when you need one exact account.

The two keys are **mutually exclusive**, and neither may be combined with
`engine:` (an engine child runs on its own CLI account). Violating either is
reported as a profile problem at load and the profile is ignored — it never
silently runs unrouted.

A routed child **pins its own connection** and validates its `model:` id
against that connection's own model catalog (the parent's active connection is
no longer relevant to it); an unrouted profile still resolves its model on the
parent's active connection. Because the model id is validated against the
**selected** connection, use the exact model id that connection is configured
with — there is no universal DeepSeek id to rely on: check the connection you
point at and copy the id it offers. Two complete examples (replace **every**
placeholder — both the connection ids and the model ids — with the ids your
setup actually offers; they are ids, not labels to be inferred):

```markdown
---
name: glm-planner
description: Read-only planner on GLM.
model: glm-5.3
effort: high
connection: <your-GLM-connection-id>
---
```

```markdown
---
name: ds-executor
description: Executor on DeepSeek Flash.
model: <the-model-id-your-DeepSeek-connection-offers>
effort: low
connection: <your-DeepSeek-connection-id>
---
```

Error semantics: an unknown, deleted or unavailable target is **refused at
spawn time naming that connection** — the child never falls back to the
parent's connection. Both-keys and engine-combination profiles are ignored at
load with a problem line. The `provider:` resolution policy above
(`resolveProviderConnection`) is unchanged.

The catalog lists `glm-5.3` and `glm-5.3-flash` (1M context advertised, 128K
max output, reasoning-capable). AnyCode budgets GLM-5.x sessions at 300k
tokens: past that the answers degrade, so auto-compaction and the context meter
use 300k instead of 1M (`ANYCODE_CONTEXT_WINDOW` still overrides it).

Reasoning effort (`low`/`high`/`max`) is a connection setting chosen in the
model/effort picker, not a separate model id. A profile can pin its own tier
with `effort:` frontmatter (`off`, `low`, `medium`, `high` or `max`) — for
example a planner on `high` and an executor on `low`. The tier is resolved
against the child model's own levels; a continued child keeps the tier it was
started on. Any other unknown frontmatter key is reported as a profile
problem rather than silently ignored.

### 3. Copy the profiles into your project

The example profiles live in a checked-out AnyCode repository. Set `ANYCODE`
to that path, `PROJECT` to the project receiving them, then copy (existing
files in the target are preserved — `cp -n` never overwrites):

```bash
ANYCODE=/path/to/checked-out-anycode
PROJECT=/path/to/your-project
mkdir -p "$PROJECT/.anycode/agents"
cp -n "$ANYCODE/examples/orchestration/glm-lead.md" \
      "$ANYCODE/examples/orchestration/flash-builder.md" \
      "$ANYCODE/examples/orchestration/glm-planner.md" \
      "$ANYCODE/examples/orchestration/glm-executor.md" \
      "$ANYCODE/examples/orchestration/flash-executor.md" \
      "$PROJECT/.anycode/agents/"
```

Then:

- **Adding profile names** requires a **new Codex or Claude session** — the
  tool declaration (and its `agent_type` list) is fixed for the session on
  both engines.
- **Editing an existing profile's body** applies from the **next spawn** —
  both bridges re-read profile files before each call, without a new session.

On the Native side both are live: profiles dropped into `.anycode/agents/`
during a session become callable at the next turn.

### 4. How the supervisor reaches GLM

Inside a Codex session, AnyCode injects an `anycode_agent` tool whose
arguments are `agent_type`, `description`, `prompt`, an optional `model`
override, an optional `detach` and an optional `continue_session`. The tool declares exactly the profiles found in the project's
`.anycode/agents/`; an unknown `agent_type` is refused with the available
list. Calling it with `agent_type: "glm-lead"` boots a child session running
the lead's profile body plus your prompt — its transcript, progress and
result card appear in the parent session.

With `detach: true` the call returns at once with the child session id and the
supervisor ends its turn. When the child finishes, AnyCode delivers its report
to the supervisor session as a new message, which starts the supervisor's next
turn; a child that stays silent too long produces a stall notice the same way.
The supervisor therefore never holds a turn open or polls while GLM works.
Without `detach` the call blocks the supervisor's turn until the child ends,
and ending that turn early cancels the child.

Because the supervisor never polls, the HOST also watches for the one state
the loop itself cannot escape: the supervisor's turn has ended, there are no
live detached children, and its final message carries no terminal marker
(`READY`, `BLOCKED`, `DONE` or `ACCEPT`) — a chain that is neither working
nor closed would otherwise sit silent forever. After **15 idle minutes**
(overridable with `ANYCODE_SUPERVISOR_IDLE_MS`), the desktop host's
supervisor idle watchdog delivers a system reminder through the same channel
as child reports, telling the supervisor to either dispatch the next task or
close with a terminal marker. The reminder repeats every **10 minutes**, and
after **two ignored reminders** the text escalates to an
`OWNER ATTENTION REQUIRED` variant addressed to whoever reads the
transcript; that escalated reminder is the last one until the supervisor
dispatches a child or closes. The watchdog only arms in a session that has
actually had a live detached child since its last marker, so an ordinary
chat is never reminded. It only ever delivers text — it never kills sessions
or cancels children — and a marker anywhere in the supervisor's final
assistant message disarms it and ends supervision until the next dispatch. Its first reminder waits
deliberately longer than one child-stall cycle (10 minutes), so a slow
child's stall notice, not the watchdog, is what wakes the supervisor first.

The `model:` frontmatter is a default, not a guarantee: the tool call's
`model` argument outranks it.

Connection routing is honored on every **creating** spawn: a profile that
declares `connection:`/`provider:` boots its child on that connection (the tool
description marks the routed entries `[connection: …]` / `[provider: …]`). A
`continue_session` call keeps the child's original connection — routing is read
only when the child is first created. On a routed profile an explicit
`Agent(provider: …)` argument is **refused**: the profile's declaration is
authoritative, so an argument can never redirect a routed child.

Without `continue_session` each call is a fresh child. With
`continue_session` set to the session id of a finished child of the same
supervisor session, AnyCode resumes that child with its full history and
delivers `prompt` as its next message. Use this to return defects to the same
lead. The continued child keeps its original connection and model. Only
AnyCode (Native) children can be continued, and only during the app run that
spawned them; after a restart, AnyCode refuses the call and you start a fresh
child. Profile files must not combine
`tools:` with an `engine:` line (these examples carry no `engine:` line —
both run on the Native engine).

### 5. First run

1. Start a new **Codex** session on the project (its Agent = Codex, its
   account profile chosen in step 1).
2. Paste the supervisor prompt from
   [`examples/orchestration/supervisor-prompt.md`](../examples/orchestration/supervisor-prompt.md)
   — fill its `[TASK BRIEF]` / `[ALLOWED PATHS]` / `[VALIDATION]` slots.
3. Have it run the **first tiny validation task** at the bottom of that
   prompt, through an actual `anycode_agent` call, before real work.

## Limitations (honest)

- Live validation confirmed a Codex supervisor calling `glm-lead` from these
  profiles, independently checking its result, and accepting the tiny example.
  A separate run confirmed GLM delegation to inline Flash and successful return
  to Codex. Direct GLM cancellation, restart, restored cancellation status and
  opening the saved child target were checked on a fresh app.
- A live loop run (`ANYCODE_ORCH_LIVE_SMOKE=1 node
  apps/desktop/scripts/orchestration-loop-live-smoke.mjs`) confirmed a Codex
  supervisor dispatching a detached `glm-lead`, ending its turn without polling,
  waking on the report, returning a defect with `continue_session` to the same
  child and accepting the fixed result. It needs a signed-in Codex account and a
  Z.AI key. When run from a process that is itself sandboxed (for example a
  coding agent's shell), add `--no-chromium-sandbox`: Chromium cannot apply its
  own sandbox there and the GPU process exits.
- Cancellation while an inline Flash Bash command is still running has not
  completed live acceptance. The successful completion run does not prove that
  cancellation case.
- No efficiency or perfect-reliability claims are made for this setup.
- GLM-5.3 and GLM-5.3-Flash availability depends on your Z.AI plan's model
  access.
