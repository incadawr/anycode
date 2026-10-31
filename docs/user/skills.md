# Skills

A **skill** is a named instruction file the model loads on demand. Skills teach
reusable procedures, such as how to review code here or how to write a commit
message, without spending prompt budget until they are needed.

## Directory shape and frontmatter

A skill is a directory containing one `SKILL.md`:

```
<root>/<skill-name>/SKILL.md
```

```markdown
---
name: commit-style
description: How this repo writes commit messages. Read before committing.
---
Write commits as `type(scope): summary`.
```

- `name` is optional and defaults to the directory name. It must match
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `description` is required. The model sees this one line in its skill list, so
  make it an accurate trigger.
- The body after the closing `---` is the instruction text. It is cut at 64 KiB
  when loaded, not hidden.

A file with invalid frontmatter, a bad name or no description is skipped. Its
reason appears in the Skills pane (see troubleshooting).

## Roots and precedence

Skills are discovered from these roots, highest precedence first. A skill with
the same name in a higher root replaces the one below it, silently:

1. `<project>/.anycode/skills/`
2. `<project>/.agents/skills/`
3. `~/.anycode/skills/`
4. `~/.agents/skills/`
5. plugin skill roots
6. built-in skills shipped with the app

Plugin skill roots come from installed plugins — see [plugins.md](plugins.md)
for the tiers, install flow, and consent rules.

### Precedence example

You create `<project>/.anycode/skills/creating-subagents/SKILL.md`. That name
belongs to a built-in skill. From the next session on, your file wins, the
built-in body is never loaded, and nothing announces the shadowing. Delete your
file and the built-in returns.

## Using a skill

- **In the composer**: type `/` at the start of a line and pick a skill from the
  list. This inserts `$skill-name`. The list offers enabled filesystem skills in
  Native tabs.
- **The model's side**: the model sees every loaded skill's name and
  description, and calls the `Skill` tool with `name` to read a body. The Skill
  tool accepts only names from that list; an unknown name returns the available
  names.

Skills apply to Native tabs only. Codex and Claude tabs do not receive them.

## Disabling a skill

- For a filesystem skill, switch it off in **Settings → Skills**. This writes
  its name to `skills.disabled`.
- Or add the name to `skills.disabled` in `.anycode/config.json` (project or user
  file):

```json
{ "skills": { "disabled": ["commit-style"] } }
```

Built-in skills do not appear in the Skills pane, so disable them with
`skills.disabled` as well.

Disabled names do not count toward the cap. A session loads at most **64 skills**
after deduplication; overflow drops from the lowest precedence first. The list of
skills in the system prompt is capped at about **8,000 characters**. Lines that do
not fit are dropped, and the prompt says how many.

## Built-in skills

The app ships these skills. They are in-memory, need no file, and are shadowed by
any same-name filesystem skill.

| Skill | Available when | Purpose |
|---|---|---|
| `using-git-worktrees` | the worktree tools are registered | When and how to use EnterWorktree and ExitWorktree. |
| `using-browser-preview` | the browser-preview tools are registered | Previewing local HTML and Markdown files and localhost dev servers. |
| `control-browser` | the browser-preview tools are registered | Operating a page in the preview: navigate, snapshot, click, type and wait. See [browser.md](browser.md). |
| `using-subagents` | always | Delegating through the Agent tool: choosing the inline or session tier, detach, models, parallel limits, reading outcomes and writing the child prompt. |
| `creating-subagents` | always | Writing `.anycode/agents/*.md` profiles. |
| `anycode-setup` | always | Read-only help with configuring AnyCode. It reads your files and explains the fix; any edit needs your approval. It never prints secrets. |

## How to verify it applied

The Skills pane has a scope dropdown at the top. The scope dropdown at the top picks **User · This computer** (your user files) or a recent folder. The folder list is built from your recent sessions and open tabs; a folder with no open tab can still be edited, and its changes apply when a session starts there. A folder that no longer exists is shown as "folder not found" and cannot be selected. The chip next to the dropdown shows how many entries the pane lists. Skills are discovered when a session starts. Start a **new
session** after adding or editing a skill. Then open **Settings → Skills**: filesystem skills are listed
with their source, and a strip shows any skill that failed to load. If the skill
is missing, see [troubleshooting.md](troubleshooting.md).
