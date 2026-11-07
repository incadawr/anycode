# AnyCode user documentation

## Start here

AnyCode runs coding sessions in tabs, each with its own host process.
A tab uses Native (the built-in loop), Codex CLI or Claude Code as its engine.
Native uses provider connections; Codex and Claude use their CLI accounts.
App settings live in `~/.anycode/settings.json`; enter credentials through Settings.
Secrets live separately in `~/.anycode/secrets.json`; never read or share that file.
Shared config lives in `<project>/.anycode/config.json` and `~/.anycode/config.json`.
A project `.anycode/` beats the user `~/.anycode/` by name for profiles and skills;
config sections have their own [merge rules](configuration.md#shared-config-anycodeconfigjson).
Skills, profiles, plugins and workflows have separate directories.
Most changes need a new session; start with the page for your question below.

## I want to… / Symptom

| I want to… / Symptom | Page |
|---|---|
| Set up my first connection and project | [Getting started](getting-started.md#connect-and-open-a-project) |
| Add an API key, subscription or local endpoint | [Providers](providers.md#add-a-connection) |
| Find available models and change effort | [Models and effort](providers.md#models-and-effort) |
| Send images or configure Vision fallback | [Image-input](providers.md#image-input) |
| Check remaining quota | [Quotas and usage](providers.md#quotas-and-usage) |
| Export a setup without credentials | [Export and import](providers.md#export-and-import) |
| Use Codex or Claude Code | [Engines](engines.md) |
| Locate or trust an engine binary | [Binary trust](engines.md#trust-for-the-engine-binaries) |
| Understand which config file to edit | [Configuration](configuration.md#which-file-do-i-edit) |
| A setting has no effect | [Environment overrides](configuration.md#environment-overrides) |
| Understand workspace trust | [Workspace trust](getting-started.md#workspace-trust) |
| Choose a permission mode | [Mode ladder](permissions.md#the-mode-ladder) |
| Stop repeated approval prompts | [Always-allow rules](permissions.md#always-allow-rules) |
| Configure automatic command review | [Ask classifier](permissions.md#ask-classifier) |
| Delegate work to another session | [Subagents](subagents.md) |
| Define a named subagent profile | [Profile files](subagents.md#profile-files) |
| Run a parent that plans and delegates | [Orchestrate](orchestration.md#orchestrate-mode) |
| Choose planner, executor and reviewer routes | [Roles](roles.md#configure-roles) |
| A role is refused or falls back | [Role routing](roles.md#fallbacks-and-read-only-roles) |
| A child session limit is reached | [Parallel children](roles.md#parallel-children) |
| Use separate git checkouts | [Worktrees](worktrees.md) |
| Recover changes from a child worktree | [Recovery](worktrees.md#recover-changes) |
| Add or import a skill | [Skills](skills.md) |
| Configure AnyCode from another tool | [External setup help](skills.md#setup-help-outside-anycode) |
| A skill or profile is missing | [Troubleshooting](troubleshooting.md#skill-or-profile-missing) |
| Add or import an MCP server | [MCP](mcp.md) |
| An MCP server does not start | [MCP troubleshooting](troubleshooting.md#mcp-server-missing) |
| Install a plugin | [Plugins](plugins.md) |
| Run commands at tool or prompt events | [Hooks](hooks.md) |
| Run a fixed sequence of subagent steps | [Workflows](workflows.md) |
| Enable language diagnostics after edits | [Language servers](lsp.md) |
| Open or operate a page | [Browser](browser.md) |
| Configure a proxy | [Proxy and network](proxy.md) |
| Share sessions with another client | [Sessions API](sessions-api.md) |
| Control shared sessions from Telegram | [Remote control](remote-control.md) |
| Use terminal flags, slash commands or shortcuts | [CLI and commands](cli.md) |
| Undo file edits and conversation | [Checkpoints](getting-started.md#checkpoints-and-rewind) |
| Reduce context or understand compaction | [Compaction](getting-started.md#compaction) |
| Find data files, logs or crash dumps | [Files and paths](files-and-paths.md) |
| Diagnose provider errors and timeouts | [Provider errors](troubleshooting.md#provider-errors) |

## Find a Settings pane

Provider → [providers](providers.md); Codex / Claude → [engines](engines.md);
Roles → [roles](roles.md); Permissions → [permissions](permissions.md);
Tools / Vision / Environment → [configuration](configuration.md);
Network → [proxy](proxy.md); Sessions API → [sessions-api](sessions-api.md).
MCP, Skills, Subagents, Plugins and Language servers each have their own page.
The session **Extensions** menu opens these surfaces; Native sessions also show Hooks.
Profile shows usage statistics. Appearance and Keyboard shortcuts save to
`ui.theme` and `keybindings.overrides` in app settings. About contains update controls.

This guide ships with the app and is read by the `anycode-setup` skill.
For other tools, copy the [setup snippet](AGENTS-SNIPPET.md) into your project's
`AGENTS.md` or `CLAUDE.md`.
Developer documentation is available on
[GitHub](https://github.com/incadawr/anycode/blob/master/docs/development/README.md).
