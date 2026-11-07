# Roles and routing

Roles are named routes for a parent and its children. They complement markdown
[subagent profiles](subagents.md); they do not change the engine of an existing tab.
Use [Orchestrate mode](orchestration.md#orchestrate-mode) to make a parent plan
and dispatch work through these roles.

## Configure roles

Open **Settings → Roles**, or `/roles` in the desktop composer. There are five:

| Role | Runs where | Default turn budget |
|---|---|---|
| `orchestrator` | Parent Native tab's own turns | Parent session budget |
| `planner` | Read-only Native child | 30 |
| `executor` | Child that implements work | 80 |
| `reviewer` | Read-only Native child | 40 |
| `explore` | Read-only Native child | Default subagent budget, normally 150 |

Set a primary route and, optionally, ordered fallbacks for each child role.
A route selects an engine, an exact connection or a provider (one of these),
plus a model and effort. Provider ids refer to configured API connections;
Codex and Claude engines use their own CLI accounts. See [providers](providers.md).

In Native tabs, `orchestrator` is checked at turn start and can change model
and effort while keeping the parent's engine and connection. In Codex
Orchestrate, choose the parent model and effort on the tab; the orchestrator
route provides no automatic parent fallback there.

The first Orchestrate request without configured roles offers presets based
on ready engines and connections. Review the selected routes before starting.

## Named role profiles

Save different named sets for different projects in the Roles pane. A project
can use the global set or be bound to one named set. These live in app settings
under `roles` and `roleProfiles`; they are distinct from `.anycode/agents/*.md`.
[Export setup](providers.md#export-and-import) includes named role profiles,
but does not export project assignments or credentials.

Same-named markdown profiles can replace `planner`, `executor` and `reviewer`.
Their explicit route, including an `engine:` line, takes priority over Settings.
`explore` and `general-purpose` are reserved builtin names. Check both the pane
and profile files when a role follows an unexpected route.

## Fallbacks and read-only roles

A route that fails for quota, authentication, an unreachable endpoint or an
unknown model cools down for five minutes. Consecutive failures double the
cooldown, up to 60 minutes. Later healthy entries are tried in order. If every
entry is unhealthy, the parent's model is the last resort and a notice explains
why the route degraded.

`planner`, `reviewer` and `explore` require Native routes to enforce read-only
restrictions. A Codex or Claude route for these roles is refused; change the
route or the overriding profile. Native session children enforce the profile's
tool allowlist and permission restrictions too, with a plan gate for read-only
personas. Read-only shell commands still need the plan-mode proof described in
[permissions](permissions.md).

## Parallel children

Per parent, `sessionLimits.childSessionsPerParentMax` accepts 1–8, default 3.
A role profile's `maxParallelChildren` accepts 1–16 and can only lower that limit.
The application-wide `sessionLimits.childSessionsGlobalMax` accepts 1–24,
default 8. Configure session limits in Settings → Tools.

A detached spawn over a limit is refused immediately, counting running
children and pending admissions. A synchronous spawn queues until a slot frees.
Wait for a child's report or inspect the relevant limit when you see “child
session limit reached”.

## Turn budgets and reminders

The default child budget is 150; a configured budget can be any positive integer.
Built-in planner, executor and reviewer defaults are 100, 300 and 150 turns.
For built-in and Settings
roles, `tools.subagentMaxTurns` takes priority over the role's default budget.
A markdown profile's explicit `maxTurns` takes priority over that setting.
An explicit internal run request can override the budget; `Agent` itself has
no `maxTurns` field. Adaptive budgets apply only when no explicit budget exists
and range from 60 to 400 turns.

A supervisor waiting on children without activity receives an idle reminder
after 15 minutes and then every ten minutes. `ANYCODE_SUPERVISOR_IDLE_MS` changes
the first delay. This is separate from the running child's stall timeout.

See [orchestration](orchestration.md), [subagents](subagents.md) and
[troubleshooting](troubleshooting.md) for dispatch and recovery.
