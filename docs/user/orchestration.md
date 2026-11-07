# Orchestration

Orchestration means one session, the **supervisor**, hands work to child
sessions, checks what comes back, and accepts or returns it. AnyCode offers it
two ways:

- **Orchestrate mode**: a tab-level switch in Native and Codex tabs. The parent
  plans and delegates to built-in roles routed in Settings → Roles.
- **The manual pattern**: any tab dispatches to your own subagent profiles
  (see [subagents.md](subagents.md)) with the delegation tool of its engine
  (see [engines.md](engines.md)).

## Orchestrate mode

Turn it on from the Orchestrate row in the permission-mode menu, the
Orchestrate toggle in a Codex composer, or `/orchestrate <task>`. The tab enters plan mode and hands work to background child sessions.
Non-read-only tools and tools needing approval ask; always-allow rules can
resolve those asks. The parent is not strictly read-only. Child reports arrive as
new turns. Children run in the permission mode you had before Orchestrate
(never plan mode). `ExitPlanMode` is hidden and denied while Orchestrate is on. Leaving plan
by changing the mode turns Orchestrate off; in a Codex tab, turning it off restores the previous Codex
permissions. Codex Orchestrate is available when the runtime policy can be
verified.

Configure the five roles, their routes, named project sets and fallback chains
in [Roles](roles.md). Children cannot delegate further: Native child-session
hosts remove both `Agent` and `Workflow` from their tool registry.

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
The engine tools appear when a profile or configured role is available.

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

A longer [manual setup example](https://github.com/incadawr/anycode/blob/master/docs/orchestration.md)
is available in the source repository.

## Claude Code tabs and recovery

Ordinary child delegation works in Claude tabs. **Claude Orchestrate is disabled
in 0.0.90.** No Claude CLI version has the live capability proof required by
the production qualification list, which is empty. A development flag alone
does not qualify a version. Use ordinary delegation or an available Native /
Codex Orchestrate tab.

The tab keeps ordinary conversation available when orchestration capability
is unavailable. If a mode transition reports recovery required, reopen the
session to restore a verified ordinary configuration before continuing.

## Coordinate with peer sessions

Behind the experimental native sessions flag (off by default, development builds
only), a Core root can use `SessionSend` and `SessionOpen` to coordinate with
independent root tabs. These are separate from `Agent` children: opening a peer
does not give the caller child lifecycle control. See
[native session peers](sessions-api.md#native-session-peers-experimental).

Orchestrate permits peer send/open with a separate human ask for **each**
operation through Core's permission gate. It does not grant access to another
project: both folders still need trust, native access and an explicit pair grant;
opening across folders also needs the destination's allow-open switch. The
receiver runs under its own permissions. HTTP sharing and External approvals do
not supply these grants.

Plan without Orchestrate, children and restricted callers cannot send/open.
Claude/Codex roots currently remain closed for peer mutations, even if tools are
declared. A resumed Orchestrate tab is closed until its host re-reports authority.
Use an explicit reply or opt into one `on_turn_end` result to wake the sender in
a new turn; receiving a reply does not turn an error or cancellation into success.

## Messages and follow-ups

For Native Core children, `Agent` with `continue_session` sends a follow-up to
a finished child; `send_to` delivers `prompt` to a running child. These are
session-tier operations. `send_to` cannot combine with provider routing,
`detach: true` or `continue_session`; engine-profile children do not support
these follow-ups. A continued child keeps its original connection.

`AgentStatus` lists children in pages of 20 or reads one by id, retaining up
to 64 recent children per tier. Codex calls it `anycode_agent_status`, Claude
`mcp__anycode__agent_status`. A foreground-blocked parent cannot inspect its
child until the call returns or is handed off.

Codex and Claude roots can select an API connection through `provider` for a
new, unpinned Core child. Discover selectors with the connection-listing tool;
fixed profile and role routes cannot be overridden. The engine bridge exposes
`continue_session` for finished Core children, but does not expose `send_to`.
