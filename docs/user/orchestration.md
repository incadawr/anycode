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
“child session limit reached” message, counting running children and pending admissions, so a burst of delegations never stalls the parent turn. A spawn
asked to wait synchronously stays queued and starts when a slot frees.

The application-wide limit across all parents is the session setting
`sessionLimits.childSessionsGlobalMax` (1–24, default 8). A background spawn
over this limit is refused with the
“application-wide child session limit reached” message; a synchronous spawn
waits for a slot.

For a longer worked example, the source repository has `docs/orchestration.md`.
It is not shipped inside the app.

## Orchestrate mode and recovery

Ordinary child delegation works independently of Orchestrate mode. Claude
Orchestrate is disabled by default and currently unavailable: enabling its
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
