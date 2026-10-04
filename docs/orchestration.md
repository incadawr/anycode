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
provider (`https://api.z.ai/api/anthropic`) with your Z.AI API key, select
`glm-5.3` as its model — and **set it as the active/default connection**
before spawning children: a Native child resolves its model on the parent
session's active connection, so Z.AI must be the active one for the profiles'
`glm-5.3` / `glm-5.3-flash` ids to resolve. A wrong or unavailable id is
refused, never silently substituted. Flash is optional.

The catalog lists `glm-5.3` and `glm-5.3-flash` (1M context, 128K max output,
reasoning-capable). Reasoning effort (`low`/`high`/`max`) is a **connection
setting** chosen in the model/effort picker — not a separate model id, and
there is no effort frontmatter in a profile.

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
      "$PROJECT/.anycode/agents/"
```

Then:

- **Adding profile names** requires a **new Codex session** for the supervisor
  to be able to call them.
- **Editing an existing profile's body** applies from the **next spawn** — the
  bridge re-reads profile files before each call, without a new session.

On the Native side both are live: profiles dropped into `.anycode/agents/`
during a session become callable at the next turn.

### 4. How the supervisor reaches GLM

Inside a Codex session, AnyCode injects an `anycode_agent` tool whose
arguments are `agent_type`, `description`, `prompt`, and an optional `model`
override. The tool declares exactly the profiles found in the project's
`.anycode/agents/`; an unknown `agent_type` is refused with the available
list. Calling it with `agent_type: "glm-lead"` boots a child session running
the lead's profile body plus your prompt — its transcript, progress and
result card appear in the parent session.

The `model:` frontmatter is a default, not a guarantee: the tool call's
`model` argument outranks it. Each call is a fresh child — the schema has no
resume or session-reference parameter. Profile files must not combine
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
- Cancellation while an inline Flash Bash command is still running has not
  completed live acceptance. The successful completion run does not prove that
  cancellation case.
- No efficiency or perfect-reliability claims are made for this setup.
- GLM-5.3 and GLM-5.3-Flash availability depends on your Z.AI plan's model
  access.
