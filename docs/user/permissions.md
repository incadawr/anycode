# Permissions

Native tool calls pass schema validation, `PreToolUse` hooks, the session's
**permission mode**, read-only command checks and **always-allow rules**. Hooks
can tighten a decision and can rewrite input, which is validated again. An
optional ask classifier can approve eligible commands still awaiting a decision;
otherwise an approval prompt appears. A prompt that nobody answers is denied.
See [hooks](hooks.md) for command hooks and the failure rules.

## The mode ladder

`plan` → `build` → `edit` → `auto` → `yolo`. Each step runs more without asking.
Pick the mode from the mode chip in the composer. A new tab starts in `build`.

| Mode | Runs without asking | Asks | Denied |
|---|---|---|---|
| `plan` | ordinary read-only tools; shell pipelines proven read-only using trusted executables | read-only tools needing approval, including WebFetch/WebSearch | writes and unproven shell commands |
| `build` | read-only tools; shell commands AnyCode's classifier proves read-only | writes, other side effects and read-only tools needing approval | nothing |
| `edit` | read-only tools; Write and Edit inside the session workspace; the read-only shell commands above | writes outside the workspace, other side effects and read-only tools needing approval | nothing |
| `auto` | everything except high-risk tools | high-risk tools, including Bash unless proven read-only or covered by a rule | nothing |
| `yolo` | everything except tools with mandatory approval | BrowserEval on every call, including with Full browser access | nothing |

The composer names the modes: "Read-only planning", "Ask before edits", "Edit
files in this project without asking", "Ask only for risky actions", and "Never
ask".

In plan mode, read-only shell proof accepts trusted executables and `|`
pipelines only. Git shell commands are excluded because repository config can
execute programs; use the Git tool. Chains and redirections are refused. This
proof is unavailable on Windows. A matching allow rule cannot bypass a denial.

Approving a plan through `ExitPlanMode` moves Native to `build`. During
**Orchestrate**, the parent is in plan mode but side-effecting tools ask instead
of being denied; saved rules can allow those asks. `ExitPlanMode` is unavailable
while Orchestrate is on. See [orchestration](orchestration.md).

> **Warning.** Bash is high-risk and asks in `auto` unless another layer allows
> it. In `yolo`, commands including destructive ones run without asking.
> BrowserEval retains mandatory approval. Use broad autonomy only where you
> accept the consequences, such as a disposable worktree or container.

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
| `Bash`, `CodexExec` | each command segment | every segment must match its own tool rule |
| `Read`, `Write`, `Edit`, `MultiEdit` | `file_path` | the file path |
| `Glob`, `Grep` | `path` | the searched path |
| `WebFetch` | `url` | the URL |

A `Bash` or `CodexExec` command line is split on shell separators (`&&`, `||`, `;`, `|`, `&`
and newlines). Each segment must match the pattern on its own.

Patterns use `*` as a wildcard, and `*` does not match `/`. So `git status*`
matches `git status` but not `git status src/x`. To approve a command that takes
a path argument, write the exact command as the pattern.

### Examples

1. `{ "toolName": "Bash" }` allows every shell command in every project. This is
   a broad shell grant, except where a mode denies the call.
2. `{ "toolName": "Bash", "pattern": "pnpm test*" }` allows `pnpm test` and
   `pnpm test --run`. It does not allow `pnpm test packages/core/x.ts`.
3. `{ "toolName": "Write" }` allows writes only to targets inside the session
   workspace. A write outside the workspace still asks.

### Workspace confinement

Bare or relative `Write`, `Edit` and `MultiEdit` rules cover only targets inside
the session workspace, after symlinks are resolved. A scoped absolute mask can
permit a resolved target outside it. New write patterns in the UI must be
scoped absolute masks:

- Absolute POSIX path, without `~`, `\`, parentheses, braces or brackets.
- No `.` or `..` path segments. At least two literal directories before a
  wildcard or final filename; three under `/Users`, `/home` or `/private/tmp`.
- The literal prefix cannot be your home folder itself. Wildcards begin in
  the final segment, or with a `**` segment.

Prefer a narrow folder mask. A blanket Bash rule has no equivalent workspace
confinement: shell commands can reach other folders.

### Project runner rules

The prompt can propose a `scoped-runner:` rule for a recognized
`cd <workspace> && <runner> <verb> ...` command. This is a structured rule for
one exact workspace and supported runner/verb, not an ordinary glob. Invalid
serialized rules match nothing. Keep the proposed scope rather than replacing
it with a broad shell wildcard. Patterns containing parentheses do not match.

`ANYCODE_RUN_ALLOW_BASH` is a separate, per-launch comma-separated list of
command prefixes. It can allow eligible Bash asks for that process only,
requires every segment to match, rejects redirection and substitution, and
never overrides a denial. It is not saved in settings.

## Ask classifier

Off by default, `permissions.classifier` supports a local command or a model
route. It can turn an eligible shell ask into allow; errors and timeouts leave
the ask in place. Native supports both kinds. Command kind also covers Claude
Bash and Codex command approvals; model kind is Native-only in 0.0.90.

Command form: `{ "kind": "command", "command": "...", "timeoutMs": 5000 }`.
Model form selects `connectionId` and `model`. The classifier does not approve
privilege escalation (`sudo`, `su`, `doas`, `pkexec`), force-push, piping into a
shell or script runtime, or commands over 2,000 characters. It cannot bypass
a hook's ask/deny and is not used for Native Orchestrate calls.

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
  which you can edit, and then runs the call. A few asks offer no checkbox —
  a plan review and `BrowserEval` — because they ask on every call.

Ordinary asks time out after 120 seconds; a plan review has 15 minutes. After
an unanswered ask times out, subsequent asks are denied immediately until a
deliberate user action (answering a prompt or sending a message) clears the
unattended state. Existing allow rules still apply.

## Engine presets

Claude tabs offer `read-only`, `ask` and `workspace` (accept edits). Codex offers
`ask`, `approve-for-me` (automatic review) and `full-access`. CLI sandbox and
approval policy govern these tabs; Native's mode ladder is not their preset list.

Session children map the parent's captured mode to their engine posture:
Claude plan → read-only, build → ask, edit/auto/yolo → workspace; Codex plan →
read-only, build → child-ask, edit/auto/yolo → ask. Codex children in the latter
three modes can auto-accept workspace patches. One-shot inline engine children
use Claude acceptEdits or Codex workspace-write without AnyCode prompts.

## How to verify it applied

Rules are read when a session starts, and rules you save from the prompt apply
immediately. Open **Settings → Permissions** to see the saved list. Then retry the
exact command or path: it should run without a prompt.

If a rule seems ignored, check the mode first. In `plan`, writes and shell
commands without the trusted read-only proof remain denied. For more causes, see
[troubleshooting.md](troubleshooting.md).

## Browser control

In Native tabs browser actions follow the mode table. Remote `BrowserOpen`
is high-risk even with Full browser access on. Remote `BrowserNavigate` and
`BrowserClick` / `BrowserType` marked `remote: true` are high-risk when Full
browser access is off; the switch removes that escalation, but does not bypass
the mode's ordinary rules for side effects. Thus `auto` asks for high-risk
calls, while `yolo` allows them. In `plan`, side-effecting browser calls are
denied. Engine tabs ask directly for calls marked as needing approval.

`BrowserEval` requires a fresh approval whenever it is allowed to run, including
in `auto` and `yolo`; saved always-allow rules and Full browser access cannot
exempt it. In Native `plan` it is denied. See [browser.md](browser.md) for
the complete browser policy and [Full browser access](browser.md#full-browser-access-per-session).
