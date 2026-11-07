# Getting started

## Connect and open a project

1. Choose how to reach a model on the welcome screen. Native uses an API key,
   coding subscription key or local endpoint. Codex uses the Codex CLI account;
   Claude uses the Claude Code account. These choices can coexist.
2. For Native, choose a provider or subscription shortcut, enter the key and
   press **Connect**. Later, manage connections in Settings → Provider.
   See [providers](providers.md). For a CLI engine, use Settings → Codex or
   Settings → Claude to locate the binary, check it and sign in.
3. Choose a project folder. Review the workspace-trust question before allowing
   project configuration to start programs.
4. Start a tab. Native starts in `build`: ordinary reads run; writes ask.
   Network tools can also ask. Codex and Claude have their own approval presets.
5. Use the model pill to pick the tab's model and an accepted effort level.
   See [models and effort](providers.md#models-and-effort) and
   [permission modes](permissions.md#the-mode-ladder).
6. Send a small request and check its result before expanding the task.

## Workspace trust

Trust concerns executable project configuration, separately from permission to
edit a file. Only trust folders whose project configuration you accept.

In an untrusted folder, project MCP servers (including `.mcp.json`), language
servers and hooks are skipped. Project telemetry and repo-map sections are also
ignored; user configuration can still apply. Plugin trust has its own
[consent rules](plugins.md). Engine tabs also apply workspace skill policy.
Trust does not turn off tool approval or make a worktree a sandbox.

The trust store is `~/.anycode/workspace-trust.json`. Changes to executable
project configuration can require a new trust decision. In the terminal client,
`ANYCODE_TRUST_WORKSPACE=1` trusts the folder for that run. Prefer the interactive
trust question for normal use; see [CLI](cli.md).

## Session controls

The header's **Extensions** menu shows MCP servers, skills, plugins and language
servers. Native sessions also show hooks. Details and problem messages help you
check what loaded; switches are available for supported extension types.

The **Environment** menu shows the folder, branch and worktree information,
Sessions API sharing, native access and browser access. It also offers diagnostics
export. Branch switching/creation has a keyboard shortcut; see [CLI](cli.md).

Native tool results can include a TodoWrite task panel. Background shell tasks
have separate output and stop controls (`BashOutput`, `BashKill`); at most eight
run at once. These tasks are separate from delegated child sessions.

## Checkpoints and rewind

Native sessions capture a checkpoint lazily before the first file-writing tool
of a turn. Checkpoints use a separate shadow git store, normally
`~/.anycode/checkpoints/`, beside the session database. They do not add commits to
your project's git history. Up to 50 checkpoints are kept per session.

In the desktop transcript minimap, choose **Rewind to before this message** to
restore files and conversation. The terminal client offers `/rewind`, including
`files` and `conversation` scopes; see [CLI](cli.md#slash-commands).

A rewind must save a safety checkpoint first. Files outside the shadow snapshot,
including ignored files and files created after the safety snapshot, are not
cleaned up. Review the resulting diff. Checkpoints are not a backup of every
shell side effect. The CLI flag `--no-checkpoints` disables capture.

## Compaction

Native sessions budget context against an effective window after output reserve
and model limits. Automatic compaction starts at the lower of 92% of that
window and the window minus 13,000 tokens. Older messages become a summary;
the most recent ten messages are kept, with the boundary adjusted to a user turn.

From 60%, microcompaction can trim older tool outputs while preserving the five
most recent results. After three consecutive compaction failures, automatic
compaction is disabled for the session. Reduce context or start a new session.
Use **Compact** in the desktop composer or `/compact` in the CLI for a manual
request, and `/context` in the CLI to inspect usage. CLI engines manage their own
context; the desktop Compact entry is unavailable in Codex tabs.

## Get help and extend the session

Use [skills](skills.md), [MCP servers](mcp.md), [hooks](hooks.md),
[workflows](workflows.md) or [language servers](lsp.md) to add capabilities.
Use [subagents](subagents.md) and [roles](roles.md) for delegation.

Ask “use the anycode-setup skill to diagnose …” in a tab. Claude exposes it as
`anycode-app:anycode-setup`, Codex as `anycode-app-setup`. It starts from this
[guide's map](README.md), identifies relevant non-secret configuration and
proposes a minimal fix. See [troubleshooting](troubleshooting.md) for checklists.
