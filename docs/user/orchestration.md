# Orchestration

Orchestration means one session, the **supervisor**, hands work to child
sessions, checks what comes back, and accepts or returns it. AnyCode offers it
two ways:

- **Orchestrate mode**: a tab-level switch in Native and Codex tabs. The parent
  stays read-only and delegates to built-in roles routed in Settings → Roles.
- **The manual pattern**: any tab dispatches to your own subagent profiles
  (see [subagents.md](subagents.md)) with the delegation tool of its engine
  (see [engines.md](engines.md)).

## Orchestrate mode

Turn it on from the Orchestrate row in the permission-mode menu, the
Orchestrate toggle in a Codex composer, or `/orchestrate <task>`. The tab plans
read-only and hands work to background child sessions; their reports arrive as
new turns. Children run in the permission mode you had before Orchestrate
(never plan mode). Leaving plan mode, including approving a plan, turns
Orchestrate off; in a Codex tab, turning it off restores the previous Codex
permissions. Codex Orchestrate is available when the runtime policy can be
verified.

Settings → Roles exposes five roles: `orchestrator` for the parent tab's
own turns, plus `planner`, `executor`, `reviewer` and `explore` for child
sessions. `planner`, `executor` and `reviewer` have role-specific turn budgets;
`explore` uses the default subagent turn limit. A same-named profile in
`.anycode/agents/` replaces `planner`, `executor` or `reviewer`;
`explore` and `general-purpose` are reserved. Settings → Roles (`/roles`) sets
an ordered fallback chain of engine, connection, model and effort for child roles:
when an entry fails on quota, auth, an unreachable endpoint or an unknown model,
it cools down and the next one is used. `planner`, `reviewer` and `explore` must
run on the Native engine, so they can stay read-only. In Native tabs only,
the `orchestrator` route is checked at turn start and can switch only model
and effort, keeping the parent's engine and connection. In Codex Orchestrate,
choose the parent model and effort on the tab; this role provides no automatic
parent fallback. The first Orchestrate run
without configured roles offers presets built from your ready engines and
connections.

## Manual delegation

### The roles

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
   name: code-review
   description: Reviews a change on the Codex engine and reports defects with file:line.
   engine: codex
   effort: high
   ---
   Verify each finding against the sources before you report it.
   ```

3. Start a new session in the supervisor tab. Dispatch to `lead` or `code-review` by
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
“child session limit reached” message, counting running children and pending admissions, so a burst of delegations never stalls the parent turn. A spawn
asked to wait synchronously stays queued and starts when a slot frees.

The application-wide limit across all parents is the session setting
`sessionLimits.childSessionsGlobalMax` (1–24, default 8). A background spawn
over this limit is refused with the
“application-wide child session limit reached” message; a synchronous spawn
waits for a slot.

For a longer worked example, the source repository has `docs/orchestration.md`.
It is not shipped inside the app.

## Claude Code tabs and recovery

Ordinary child delegation works in every engine tab. Orchestrate mode for
Claude Code tabs is [not available yet](https://github.com/incadawr/anycode/issues/35): enabling its
development flag does not qualify a native CLI version. The tab explains an
unavailable capability and keeps ordinary conversation available.

The Claude overlay closes the parent's browser tools completely, as well as
shell, writes and external MCP tools. Delegate browser research to a child.
When the overlay is off, the parent's native configuration is restored.
Each actual ON/OFF change restarts the Claude CLI, which adds startup latency;
requesting the already applied state does not restart it. The logical session
and native reference are retained without an extra model turn.

Detached child reports wait while a mode change is being confirmed. After a
successful restart they can start a new parent turn. Error and cancelled child
results retain their status; the parent receiving a report does not turn the
child result into success. Reports already admitted are not automatically
resent when acceptance is uncertain. After an interrupted transition, reopen
the session to restore a verified OFF configuration before continuing. If
verification or saving recovery state fails, admission remains closed and the
tab shows that recovery is required.
