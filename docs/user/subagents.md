# Subagents

A subagent is a child agent that a session starts through the `Agent` tool. There
are two kinds: the two built-in personas, and your own markdown profiles in
`.anycode/agents/`.

## Built-in personas

| Persona | What it does |
|---|---|
| `general-purpose` | Full toolset under the parent's permission gate. The default for delegated build work. |
| `explore` | Read-only reconnaissance. It sweeps many files and returns the conclusion. Set `ANYCODE_EXPLORE_MODEL` to run it on a cheaper model. |

These names are reserved: a profile cannot use them.

## Profile files

A profile is one markdown file:

- `<project>/.anycode/agents/<name>.md`, project scope;
- `~/.anycode/agents/<name>.md`, user scope, available in every project.

When the workspace is a linked git worktree, the main checkout's
`.anycode/agents/` also counts as project scope. Plugins can contribute read-only
roots below the user scope.

Precedence: project, then the main checkout (for worktrees), then user, then
plugins. A name is claimed by the highest source that defines it, and a lower
file with the same name is ignored. Plugin-contributed profiles are managed in
[plugins.md](plugins.md).

The file is YAML frontmatter followed by the child's system prompt. Write the
frontmatter as flat `key: value` lines. Lists go inline (`tools: [Read, Write]`
or `tools: Read, Write`). A block list (`tools:` followed by `- Read` lines) or
any nested line makes the whole file invalid, and the profile is not loaded.

### Frontmatter reference

| Key | Required | Meaning |
|---|---|---|
| `name` | no | Defaults to the file name. Must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Reserved names are refused. |
| `description` | **yes** | One line the parent model uses to pick the profile. |
| `model` | no | Model id for this profile's children. |
| `engine` | no | `codex` or `claude`: children run as a one-shot invocation of that CLI in the session's workspace. `claude` runs with `acceptEdits`; `codex` runs in a workspace-write sandbox. |
| `tools` | no | Tool allowlist. In-process children only. |
| `effort` | no | Reasoning tier: `off`, `low`, `medium`, `high`, `xhigh` or `max`. `model_reasoning_effort` is accepted as an alias. |
| `maxTurns` | no | Turn budget for each run, 1 to 200. Default 40. |
| `connection` | no | Exact connection id to run on. Ids are in `provider.connections[].id` in `~/.anycode/settings.json`. |
| `provider` | no | Provider id (for example `z-ai` or `deepseek`) resolved to a configured connection. |

Unknown keys are ignored.

**Hard rules.** A profile that breaks one of these is rejected and does not
appear in the list:

1. `description` is required.
2. `tools:` and `engine:` cannot be combined. An engine child's toolset belongs
   to that CLI.
3. `connection:` and `provider:` cannot be combined, and neither can be combined
   with `engine:`.

A malformed `model`, `engine`, `effort` or `maxTurns` value is rejected too. It
is never silently replaced with a default.

### Connection routing

- `connection:` is an exact connection id. If it does not exist, the spawn fails
  with an error. It never falls back to another connection.
- `provider:` picks the active connection for that provider, or the first
  configured one.
- With neither key, the child uses the parent session's connection.

## Complete examples

An in-process builder with an explicit toolset:

```markdown
---
name: docs-writer
description: Writes and updates user-facing documentation pages.
model: glm-5.3
tools: [Read, Write, Edit, Grep]
maxTurns: 40
---
You write user documentation. Read the surrounding pages first, match their
tone, and keep every claim verifiable against the code.
```

A Codex-engine child. It has no `tools:` line, because the CLI owns its toolset:

```markdown
---
name: codex-reviewer
description: Runs a review pass on the Codex engine and reports defects with file:line.
engine: codex
effort: high
---
Review the change you are given. Verify each finding against the sources before
reporting it, and cite file:line for every defect.
```

A child routed to a provider. It has no `model:` line, so it uses that
connection's default model:

```markdown
---
name: flash-runner
description: Fast runner for fully resolved one-shot tasks on the DeepSeek provider.
provider: deepseek
maxTurns: 10
---
Execute the single task you are given. Do not expand scope. Report the result
and nothing else.
```

## Pickup

- **Native tabs** see a new or changed profile on the next turn.
- **Codex and Claude tabs**: after you add or rename a profile, start a new
  session in that tab so its delegation list is current.

## How to verify it applied

Open **Settings → Subagents**. The scope dropdown at the top switches between
**User · This computer** and a recent folder. The scope dropdown at the top picks **User · This computer** (your user files) or a recent folder. The folder list is built from your recent sessions and open tabs; a folder with no open tab can still be edited, and its changes apply when a session starts there. A folder that no longer exists is shown as "folder not found" and cannot be selected. The chip next to the dropdown shows how many entries the pane lists. Every profile that
loaded is listed. A profile
that failed to load is missing from the list, and the pane shows a strip such as
"1 profile(s) failed to load". Expand it for the reason. Then check the pickup
rule above for the tab you use.
