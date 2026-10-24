# Permissions

Every tool call passes a two-stage gate: a **permission mode** (the ladder the
session runs under) and **always-allow rules** (named exceptions you grant).
An interactive "ask" becomes the approval modal; when nobody is at the screen,
an ask is denied — fail-closed.

Requires AnyCode 0.0.35 or newer.

## The mode ladder

`plan → build → edit → auto → yolo` — each mode widens what runs without
asking.

| Mode | Runs free | Asks | Denied |
|---|---|---|---|
| `plan` | read-only tools | — | every write/side-effecting tool (no bypass) |
| `build` | read-only tools | every write/side-effecting tool | — |
| `edit` | read-only tools; Write/Edit/MultiEdit with a target **inside the session workspace** | writes outside the workspace; other side effects | — |
| `auto` | everything except high-risk tools | high-risk tools | — |
| `yolo` | everything | nothing | — |

`plan` mode is the research state: it cannot write at all. `edit` mode is the
everyday coding state: in-workspace file edits flow, everything else asks.
`auto` and `yolo` are convenience rungs with real teeth:

> **Honest warning.** In `auto` mode a tool marked high-risk still asks — but
> everything else, including destructive shell commands the risk classifier
> does not rate high, runs unprompted. In `yolo` mode **nothing asks, ever**:
> a wrong command, a `rm -rf`, a force-push — all execute. Use `yolo` only in
> disposable environments (throwaway worktrees, containers, VMs), never in a
> checkout you cannot afford to lose.

## Always-allow rules

A rule has the shape `{ "toolName": ..., "pattern": ... }` (pattern optional)
and lives in `permissions.alwaysAllow` in `~/.anycode/settings.json` — edited
through **Settings → Permissions**, or written by the approval modal's
"Always allow" button.

A matching rule downgrades only an *ask* — a *deny* (for example a write in
plan mode) is never overridden.

The pattern is matched against a per-tool subject:

| Tool | Subject | Pattern matches |
|---|---|---|
| `Bash` | each command segment (split on `&&`, `;`, `|`) | every segment must match |
| `Read`/`Write`/`Edit`/`MultiEdit` | `file_path` | the file path |
| `Glob`/`Grep` | `path` | the searched path |
| `WebFetch` | `url` | the URL |

### Three worked examples

1. **Bare `{ "toolName": "Bash" }`** — allows every shell command in every
   project. *Discouraged*: the pattern exists precisely to narrow this.
2. **`{ "toolName": "Bash", "pattern": "git status*" }`** — allows
   `git status` (and anything starting with it as one command), including
   chained as `git status && git diff` because both segments match their own
   rules. `git push --force` does not match and still asks.
3. **`{ "toolName": "Write" }`** — allows Write **only for targets inside the
   session workspace** (see the confinement rule below). A write to a path
   outside the workspace still asks.

### The workspace confinement rule

Always-allow rules for `Write`/`Edit`/`MultiEdit` cover **only targets inside
the session workspace** (symlink-resolved). An outside write still asks even
with a blanket rule — so a child session working in a `.anycode/worktrees/`
worktree cannot ride a blanket Edit rule to modify the main checkout by
absolute path. `Bash` is not path-analysable, so a blanket Bash rule remains a
full bypass by your explicit grant.

**Recommendation:** prefer narrow, patterned rules (`git status*`,
`/workspace/docs/**`) over bare toolName entries; add bare rules only for
tools whose every use you would approve anyway.

## Trusted binaries

The first spawn of an engine CLI (or any binary the app runs for you) asks for
trust, showing the **path** and the binary's **fingerprint**. Consents are
per path, listed in Settings → Permissions; a fingerprint change (the CLI
updated itself) asks again. Details: [engines.md](engines.md).

## The approval modal

When a call asks, the modal names the tool, its target (command, path, URL),
and the session's mode. Your choices:

- **Allow once** — this call runs; the next identical call asks again.
- **Always allow** — writes one of the rules above (the button shows the rule
  it will write) and the call runs.
- **Deny** — the call is refused and the model sees the refusal.

## How to verify it applied

Rules are seeded into every **new** session at boot: after adding one, start a
new session (or re-open the tab) and check Settings → Permissions — the rule
list renders from the same file. Then trigger the exact command/path that used
to ask: it should run with no modal.

## Modes and rules at a glance

- Mode decides the *default* ruling per tool; rules only ever *narrow* the
  asks that survive it.
- Deny always wins: no rule lifts a plan-mode write, and an unattended ask
  (nobody at the screen) is denied, not auto-approved.
- Related pages: [configuration.md](configuration.md) for where rules are
  stored, [engines.md](engines.md) for trusted-binary consents,
  [troubleshooting.md](troubleshooting.md) when a rule seems ignored.
