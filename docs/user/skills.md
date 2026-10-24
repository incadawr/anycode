# Skills

A **skill** is a named instruction file the model loads on demand. Skills
teach reusable procedures — "how we review code here", "how to write a commit
message" — without spending prompt budget until needed.

Requires AnyCode 0.0.35 or newer.

## Directory shape and frontmatter

A skill is a directory containing one `SKILL.md`:

```
<root>/<skill-name>/SKILL.md
```

```markdown
---
name: commit-style
description: How this repo writes commit messages — read before committing.
---
Write commits as `type(scope): summary` …
```

- `name` — optional; defaults to the directory name. Must match
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `description` — **required**; this is the one line the model sees in the
  skill list, so make it an accurate trigger.
- The body after the closing `---` is the instruction text, capped at 64 KiB
  (larger bodies are truncated when loaded, not hidden).

## Roots and precedence

Skills are discovered in this order — a same-name skill from a higher root
**replaces** one from a lower root, silently:

1. `<project>/.anycode/skills/`
2. `<project>/.agents/skills/`
3. `~/.anycode/skills/` and `~/.anycode/agents/skills/`
4. plugin roots
5. built-in skills shipped with the app

### Precedence worked example

You create `<project>/.anycode/skills/creating-subagents/SKILL.md`. The app
ships a built-in skill with that same name. From the next session on, **your
file wins** — the built-in body is never loaded, and nothing announces the
shadowing. Delete your file and the built-in returns. Same rule one level up:
a same-name skill in the project root beats one in `~/.anycode/skills/`.

## Using a skill

Two ways, both visible to the model:

- **Chat reference** — mentioning `$commit-style` in a message points the
  model at that skill.
- **The `Skill` tool** — `Skill("commit-style")` loads the body into the
  conversation. Only names from the session's skill list resolve; an unknown
  name is an honest error listing what exists.

## Disabling a skill

Either toggle it off in **Settings → Skills**, or add its name to
`skills.disabled` in the shared config (`.anycode/config.json`, project or
user scope):

```json
{ "skills": { "disabled": ["commit-style"] } }
```

Disabling frees a cap slot: at most **64 skills** per session after dedupe,
lowest precedence dropped first.

## Built-in skills

The app ships these built-ins, listed with source `builtin` in the session's
skill list:

| Skill | Purpose |
|---|---|
| `using-git-worktrees` | When and how to use the EnterWorktree/ExitWorktree tools. |
| `using-browser-preview` | Previewing local HTML/Markdown artifacts and localhost dev servers. |
| `creating-subagents` | Authoring `.anycode/agents/*.md` profiles. |
| `anycode-setup` | Read-only help configuring AnyCode itself (settings, MCP, permissions, …). |

A same-name skill in any filesystem root replaces a built-in exactly as it
would another filesystem skill (see the worked example above).

## How to verify it applied

Skills are discovered at session boot: start a **new session**, then check
Settings → Skills (lists every discovered skill with its source) or ask the
model to list its skills. A skill that does not appear was skipped silently —
see [troubleshooting.md](troubleshooting.md) for the checklist.
