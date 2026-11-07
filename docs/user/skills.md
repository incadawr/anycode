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

In Native tabs, skills are discovered from these roots, highest precedence first. A skill with
the same name in a higher root replaces the one below it, silently:

1. `<project>/.anycode/skills/`
2. `<project>/.agents/skills/`
3. `~/.anycode/skills/`
4. `~/.agents/skills/`
5. plugin skill roots
6. built-in skills shipped with the app

Plugin skill roots come from installed plugins — see [plugins.md](plugins.md)
for the tiers, install flow, and consent rules. Non-official plugin roots
that claim a builtin name are dropped with a problem; they cannot shadow it.

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

Filesystem skills apply to Native tabs only. Claude and Codex root tabs can also receive
three app builtins through their CLI skill mechanisms; see below. Independently
installed CLI skills follow that CLI's rules and are not controlled by this pane.

## Import from other tools

Settings → Skills can scan `~/.claude/skills`, `~/.codex/skills`,
`~/.zcode/skills`, project `.claude/skills` and installed Claude Code plugins.
Review compatibility and the destination before importing. This copies a skill
into an AnyCode root; it does not forward the source tool's whole environment.
Start a new Native session to load the result.

## Disabling a skill

- For a filesystem skill, switch it off in **Settings → Skills**. This writes
  its name to `skills.disabled`.
- Or add the name to `skills.disabled` in `.anycode/config.json` (project or user
  file):

```json
{ "skills": { "disabled": ["commit-style"] } }
```

The three app builtins below appear in **Built into AnyCode**. Their switch
edits the selected personal or workspace config using the original builtin ID.
Each switch affects both Claude and Codex at their next process launch, including resume.
Either config can disable a builtin: enabling it in the workspace does not undo
a personal disable. These IDs are shared with Native: disabling one also disables
the same-name Native builtin. Other Native builtins can be disabled through config.

In Native tabs, disabled names do not count toward the cap. A session loads at most **64 skills**
after deduplication; overflow drops from the lowest precedence first. The list of
skills in the system prompt is capped at about **8,000 characters**. Lines that do
not fit are dropped, and the prompt says how many.

## Built-in skills

Native ships the following in-memory skills. In Native, a same-name filesystem
skill replaces the builtin. The separate app catalog in external tabs is unaffected
by such files.

| Skill | Available when | Purpose |
|---|---|---|
| `using-git-worktrees` | the worktree tools are registered | When and how to use EnterWorktree and ExitWorktree. |
| `using-browser-preview` | the browser-preview tools are registered | Previewing local HTML and Markdown files and localhost dev servers. |
| `control-browser` | the browser-preview tools are registered | Operating a page in the preview: navigate, snapshot, click, type and wait. See [browser.md](browser.md). |
| `using-subagents` | always | Delegating through the Agent tool: choosing the inline or session tier, detach, models, parallel limits, reading outcomes and writing the child prompt. |
| `creating-subagents` | always | Writing `.anycode/agents/*.md` profiles. |
| `anycode-setup` | always | Read-only help with configuring AnyCode. It reads your files and explains the fix; any edit needs your approval. It never prints secrets. |

## Built into AnyCode in Claude and Codex tabs

Three app-owned definitions are prepared for each new root Claude or Codex process,
including a process started to resume a session:

| Builtin ID in `skills.disabled` | Claude alias | Codex alias |
|---|---|---|
| `anycode-setup` | `anycode-app:anycode-setup` | `anycode-app-setup` |
| `using-browser-preview` | `anycode-app:using-browser-preview` | `anycode-app-browser-preview` |
| `control-browser` | `anycode-app:control-browser` | `anycode-app-control-browser` |

The setup policy is shared with Native, with engine-specific location and tool
wording. Browser engine bodies are shorter texts using registered bridge names.
This is a separate app catalog and namespace. A same-name project, personal or
plugin file never replaces it. Those file sources are not exported to Claude or
Codex, even if their switches are on. The other three Native builtins are not
exported either. Browser definitions require the corresponding tools.

Settings → Skills previews configuration for the next launch, not the state of
a running process. A new process reads policy again; toggles do not hot reload
or revoke a running snapshot. For this app catalog, an untrusted workspace
config is ignored; personal disabled settings still apply. Invalid/unreadable policy,
unsupported CLI or preparation failure can leave the adapter unavailable while
ordinary chat continues. Windows forwarding is unavailable in this MVP.

Claude sessions report when skill files are prepared and when Claude lists them,
and show a warning if preparation fails. These notices contain no internal identifiers.
The pane does not report a process generation or preparation/catalog success.
A **prepared** snapshot means only that files were made; **CLI-reported**
metadata means recognition, not proof that the model read or followed the
body. Model-use acceptance is a separate check in a fresh profile.

Codex uses process-local extra skill roots, including orchestration replacements.
A native CLI skill with the same Codex alias suppresses that app copy. Catalog
errors leave ordinary Codex available: changed roots must be removed and verified,
or the process is restarted once without app roots. Claude uses a session plugin
and retries an unknown startup failure once without it; sign-in, verification
and cancellation failures retain their original error.
Codex discovery has been checked with a synthetic catalog on CLI 0.166.0;
real-template/model use and packaged compatibility still require acceptance.

Snapshots are sealed and isolated per process. Normal cleanup waits for proof
that the owned process group has exited. A crash or uncertain ownership retains
the snapshot conservatively; restarting does not sweep those slots. Retained
slots can eventually exhaust the fixed quota, disabling forwarding for later
launches while ordinary chat remains available.

## How to verify it applied

The scope dropdown at the top of the Skills pane picks **User · This computer** (your user files) or a recent folder. The folder list is built from your recent sessions and open tabs; a folder with no open tab can still be edited, and its changes apply when a session starts there. A folder that no longer exists is shown as "folder not found" and cannot be selected. The chip next to the dropdown shows how many entries the pane lists. Skills are discovered when a session starts. Start a **new
session** after adding or editing a skill. Then open **Settings → Skills**: filesystem skills are listed
with their source, and a strip shows any skill that failed to load. If the skill
is missing, see [troubleshooting.md](troubleshooting.md).
