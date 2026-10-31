# Permissions

Every tool call passes two checks: the session's **permission mode**, and your
**always-allow rules**. A call that the mode asks about becomes an approval
prompt. A prompt that nobody answers is denied.

## The mode ladder

`plan` → `build` → `edit` → `auto` → `yolo`. Each step runs more without asking.
Pick the mode from the mode chip in the composer. A new tab starts in `build`.

| Mode | Runs without asking | Asks | Denied |
|---|---|---|---|
| `plan` | read-only tools | nothing | every other tool, including every shell command |
| `build` | read-only tools; shell commands AnyCode's classifier proves read-only | writes and other side effects | nothing |
| `edit` | read-only tools; Write and Edit inside the session workspace; the read-only shell commands above | writes outside the workspace; other side effects | nothing |
| `auto` | everything except high-risk tools | high-risk tools | nothing |
| `yolo` | everything | nothing | nothing |

The composer names the modes: "Read-only planning", "Ask before edits", "Edit
files in this project without asking", "Ask only for risky actions", and "Never
ask".

> **Warning.** In `auto`, a tool the classifier marks high-risk still asks, but
> other shell commands run unprompted, including destructive ones. In `yolo`
> nothing asks. A wrong command or a force-push executes. Use `yolo` only in
> disposable environments, such as a throwaway worktree, a container or a VM.

## Always-allow rules

A rule has the shape `{ "toolName": ..., "pattern": ... }`. The pattern is
optional. Rules live in `permissions.alwaysAllow` in `~/.anycode/settings.json`.
You create one in two ways:

- In the approval prompt, tick **Always allow** and check the pattern it
  proposes. The rule applies now and in future sessions.
- In **Settings → Permissions**, add or remove rules.

A rule only downgrades an *ask*. A *deny*, for example a write in plan mode, is
never overridden.

The pattern is matched against one subject per tool:

| Tool | Subject | Pattern matches |
|---|---|---|
| `Bash` | each command segment | every segment must match |
| `Read`, `Write`, `Edit` | `file_path` | the file path |
| `Glob`, `Grep` | `path` | the searched path |
| `WebFetch` | `url` | the URL |

A `Bash` command line is split on shell separators (`&&`, `||`, `;`, `|`, `&`
and newlines). Each segment must match the pattern on its own.

Patterns use `*` as a wildcard, and `*` does not match `/`. So `git status*`
matches `git status` but not `git status src/x`. To approve a command that takes
a path argument, write the exact command as the pattern.

### Examples

1. `{ "toolName": "Bash" }` allows every shell command in every project. This is
   a full bypass, so avoid it.
2. `{ "toolName": "Bash", "pattern": "pnpm test*" }` allows `pnpm test` and
   `pnpm test --run`. It does not allow `pnpm test packages/core/x.ts`.
3. `{ "toolName": "Write" }` allows writes only to targets inside the session
   workspace. A write outside the workspace still asks.

### Workspace confinement

Always-allow rules for `Write` and `Edit` only cover targets inside the
session workspace, after symlinks are resolved. A child session working in a
worktree therefore cannot use a blanket Edit rule to change the main checkout by
absolute path. `Bash` cannot be checked this way, so a blanket Bash rule is a
full bypass by your explicit grant.

Prefer narrow, patterned rules. Add bare tool rules only for tools whose every
use you would approve.

## Profile rules

A subagent profile can carry its own `permissions.allow` and `permissions.deny`
lists in its frontmatter. They narrow that profile's children only, on top of
the rules above: a denied call is refused without a prompt, an allowed call
runs without a prompt where this gate would have asked, and everything else is
unchanged. See [subagents.md](subagents.md#profile-permissions).

## Trusted binaries

The Codex and Claude CLIs are trusted automatically unless their file could be
replaced by someone else. In that case the engine pane asks you to trust the
path, and the consent is listed in **Settings → Permissions → Trusted binaries**.
Details are in [engines.md](engines.md).

## The approval prompt

When a call asks, the prompt names the tool, its target (command, path or URL)
and the session's mode. You can:

- **Allow**: this call runs.
- **Deny**: the call is refused, and the model sees the refusal. Closing the
  prompt or pressing Esc also denies.
- **Always allow** (a checkbox next to Allow): saves a rule with the pattern shown,
  which you can edit, and then runs the call.

## How to verify it applied

Rules are read when a session starts, and rules you save from the prompt apply
immediately. Open **Settings → Permissions** to see the saved list. Then retry the
exact command or path: it should run without a prompt.

If a rule seems ignored, check the mode first. In `plan` mode nothing that
writes or runs a shell command runs, whatever the rules say. For more causes, see
[troubleshooting.md](troubleshooting.md).

## Browser control

`BrowserNavigate`, `BrowserClick` and `BrowserType` ask for approval when they
reach a non-localhost origin (a remote url, or a click or type the agent marks
`remote: true`). `BrowserEval` always asks. Snapshot, wait and console calls,
and anything on a localhost page or a local file, do not prompt. See
[browser.md](browser.md).

A session's **Full browser access** switch (off by default) removes these
prompts for that session only, while it is on. Folders you have not trusted
never get it. See [browser.md](browser.md#full-browser-access-per-session).
