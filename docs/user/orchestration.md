# Orchestration

Orchestration is a pattern, not a separate mode. One session, the **supervisor**,
hands work to subagent profiles, checks what comes back, and accepts or returns
it. AnyCode provides the pieces: profiles (see [subagents.md](subagents.md)),
the delegation tool in each engine, and the engine tabs (see
[engines.md](engines.md)). This version has no Orchestration settings pane.

## The roles

| Role | Typical setup | Does |
|---|---|---|
| Supervisor | Any tab: Native, Codex or Claude | Plans, dispatches, checks the results, accepts or sends back. |
| Lead | A profile with `provider:` or `connection:` | Plans and implements a larger task. |
| Builder | A profile with a `tools:` list, or an `engine:` profile | Carries out one bounded task. |

A Native session-tier `Agent` call runs in the background by default: the tool
returns as soon as the child session starts, and the child's report arrives
later as a new message that wakes the supervisor. End the turn after
dispatching and do not poll. Pass `detach: false` only for a short lookup whose
result the next step needs.

A call that waits synchronously is handed over to the background after 120
seconds of running instead of holding the turn: the result says the child is
still running and its report will arrive as a message. Cancelling the turn
after that handoff does not stop the child. Workflow steps are not affected —
a workflow waits for each step's real result.

Delegation tools: a Native supervisor uses the `Agent` tool with `agent_type`.
A Codex tab uses `anycode_agent`, and a Claude tab uses `mcp__anycode__agent`.
Both engine tools appear only when at least one profile exists.

## A minimal setup

1. Write the profiles in `<project>/.anycode/agents/`. A lead routed to a
   provider:

   ```markdown
   ---
   name: lead
   description: Plans and implements a multi-file change on the DeepSeek provider.
   provider: deepseek
   maxTurns: 60
   ---
   Plan the change first, then implement it in small steps and review your own diff.
   ```

2. Add a reviewer that runs on the Codex engine:

   ```markdown
   ---
   name: reviewer
   description: Reviews a change on the Codex engine and reports defects with file:line.
   engine: codex
   effort: high
   ---
   Verify each finding against the sources before you report it.
   ```

3. Start a new session in the supervisor tab. Dispatch to `lead` or `reviewer` by
   name. Start a new session after you add profiles, so a Codex or Claude
   supervisor sees them.
4. Each child run appears as a card in the parent session, with its progress and
   its result.

## Parallel children

Every parent session has a limit on how many child sessions run at once. The
limit is the session setting `sessionLimits.childSessionsPerParentMax` (1–8,
default 3). A role profile's `maxParallelChildren` (1–16) can lower that limit
for that project's parent session and never raise it — the lower of the two
applies. Leave the field blank to use the session limit.

A background (detached) spawn above the limit is refused immediately with the
limit message, so a burst of delegations never stalls the parent turn. A spawn
asked to wait synchronously stays queued and starts when a slot frees.

For a longer worked example, the source repository has `docs/orchestration.md`.
It is not shipped inside the app.
