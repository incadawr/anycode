# Subagents

A subagent is a child agent your session spawns through the `Agent` tool.
Subagents come in two flavors: the two built-in personas, and your own
markdown profiles in `.anycode/agents/`.

Requires AnyCode 0.0.35 or newer.

## Built-in personas

| Persona | What it does |
|---|---|
| `general-purpose` | Full child toolset — the default for delegated build work. |
| `explore` | Read-only recon: sweeps several files and returns just the conclusion. |

These names are reserved: a profile cannot override them.

## Markdown profiles

A profile is one file:

- `<project>/.anycode/agents/<name>.md` — project scope, beats user scope;
- `~/.anycode/agents/<name>.md` — user scope, available in every project.

YAML frontmatter declares the routing; everything after the closing `---` is
the child's system prompt.

### Frontmatter reference

| Key | Required | Meaning |
|---|---|---|
| `name` | optional | Defaults to the filename; must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; reserved names are refused. |
| `description` | **yes** | The one line the parent model picks the profile by. |
| `model` | optional | Model id for children of this profile. |
| `engine` | optional | `codex` or `claude`: children run as a one-shot invocation of that real CLI in the session workspace (`claude` runs with accept-edits; `codex` in a workspace-write sandbox). |
| `tools` | optional | Tool allowlist — in-process children only. |
| `effort` | optional | Reasoning tier: `off/low/medium/high/xhigh/max`. |
| `maxTurns` | optional | Per-run turn budget for children. |
| `connection` | optional | Exact AnyCode connection id children run on. |
| `provider` | optional | Catalog provider id (`z-ai`, `deepseek`, …) resolved to a configured connection. |

**Three hard rules (enforced at parse time — a violated profile is rejected
outright and never appears in the list):**

1. `description` is required.
2. `tools:` + `engine:` are mutually exclusive — an engine child's toolset
   belongs to that CLI, not to an allowlist.
3. `connection:` / `provider:` are mutually exclusive, and neither may be
   combined with `engine:`.

### Connection routing semantics

- `connection:` is an **exact** connection id (as shown in Settings →
  Provider). If that id does not exist, the spawn is **refused naming that
  connection** — it never silently falls back to another.
- `provider:` picks the *active* connection for that provider, or the first
  configured one — convenient, at the cost of following whatever is active.
- Neither key set: the child inherits the parent session's connection.

## Complete examples

An in-process builder:

```markdown
---
name: docs-writer
description: Writes and updates user-facing documentation pages.
model: glm-5.3
tools:
  - Read
  - Write
  - Edit
  - Grep
maxTurns: 40
---
You write user documentation. Read the surrounding pages first, match their
tone, and keep every claim verifiable against the code.
```

A Codex-engine child (no `tools:` — the CLI owns its toolset):

```markdown
---
name: codex-reviewer
description: Runs a review pass on the Codex engine and reports defects with file:line.
engine: codex
effort: high
---
Review the change you are given. Verify each finding against the sources
before reporting it; cite file:line for every defect.
```

A native child pinned to an exact connection:

```markdown
---
name: flash-runner
description: Cheap fast runner for fully-resolved one-shot tasks on the DeepSeek connection.
connection: deepseek-main
model: deepseek-chat
maxTurns: 10
---
Execute the single task you are given. Do not expand scope; report the result
and nothing else.
```

## Where profiles come from and when they apply

Project `.anycode/agents/` beats `~/.anycode/agents/`; plugins contribute
read-only roots below both. Native pickup is **hot** — a new profile is
callable on the very next turn. Codex and Claude tabs declare their profile
list at session boot: **adding or renaming** a profile there needs a new
session, while editing an existing profile's body applies from the next
spawn.

## How to verify it applied

Open **Settings → Subagents**: every discovered profile is listed there, and a
profile rejected for a frontmatter problem is simply absent (parse problems go
to the logs, not the chat — see [troubleshooting.md](troubleshooting.md)).
For engine tabs, remember the new-session rule above.
