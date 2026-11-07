# Command line and slash commands

## The `anycode` CLI

A terminal client on the same core as the desktop app (`apps/cli`). It is built from the
source repository (Node 22 or newer) and is not published as a package.

```
anycode [options]
```

| Option | Meaning |
|---|---|
| `--mode <plan\|build\|edit\|auto\|yolo>` | Permission mode (default `build`) |
| `--yolo` | Same as `--mode yolo` |
| `--model <id>` | Model id |
| `--resume [id]`, `--continue` / `-c` | Resume a session / the last one |
| `--print [prompt]` / `-p [prompt]` | One-shot, non-interactive. Reads stdin when no prompt is given; place `-p` last |
| `--output-format text\|json\|stream-json` | Output format for `--print` |
| `--image <path>` | Attach an image (repeatable) |
| `--tui` | Ink composer with slash autocomplete |
| `--no-checkpoints`, `--no-reasoning`, `--no-color` | Turn those off |
| `--help`, `--version` | |

**Environment.** Supply `ANYCODE_API_KEY` and a model through `ANYCODE_MODEL`
or `--model`. The CLI uses launch environment configuration rather than desktop
provider connections. Optional:
`ANYCODE_BASE_URL`, `ANYCODE_DB_PATH`, `ANYCODE_MAX_TURNS`,
`ANYCODE_MAX_OUTPUT_TOKENS`, `ANYCODE_REASONING_EFFORT`, `ANYCODE_CONTEXT_WINDOW`,
`ANYCODE_MAX_RETRIES`, `ANYCODE_TOOL_CONCURRENCY`, `ANYCODE_STALL_TIMEOUT_MS`,
`ANYCODE_EXPLORE_MODEL`, `ANYCODE_EFFORT_LEVELS`, `ANYCODE_TRUST_WORKSPACE=1` (trust the
folder for this run). The CLI reads the same `.anycode/config.json`, profiles,
skills, hooks and workflows as the desktop app. Folder trust is stored in
`~/.anycode/workspace-trust.json`, and an interactive run asks for it.

## Slash commands

 `/compact`, `/context`, `/allow [Tool [glob]]`,
`/mode`, `/model`, `/effort`, `/reasoning`, `/mcp`, `/skills`, `/workflows`,
`/hooks`, `/lsp`, `/sessions [all]`, `/rewind [#|id [files|conversation]]`,
`/status`, `/diff [path]`, `/commit <msg>`, `/tasks [kill <id>]`,
`/image <path>|clear`, `/telemetry`, `/repo-map`, `/help`, `/quit` (or `/exit`).
The CLI has no `/orchestrate` and no `/roles`. `/reasoning` without an argument
toggles display; `/effort` without an argument shows effort. With an argument,
both accept `off`, `low`, `medium`, `high`, `xhigh`, `max`.

`/commit` stages every change and asks for confirmation. Review `/status` and
`/diff` first. In non-interactive runs, requests needing approval are denied;
choose an appropriate permission mode or narrow allow rule for automation.

## Desktop composer

Type `/` at the start of the composer:

| Entry | Does |
|---|---|
| Plan mode, Mode | Change the permission mode (Native) |
| Orchestrate (`/orchestrate <task>`) | Start Orchestrate with a task |
| Model | Change the model |
| Compact | Compact the conversation now (not in Codex tabs) |
| New task, Tasks | Open a tab / the task list |
| Git changes, Terminal | Open those panels |
| MCP, Skills, Roles, Plugins, Settings | Open the pane |
| a skill name | Inserts `$skill-name` into the message |

A draft that is exactly `/<command>` runs the command instead of being sent.

## Rewind and context

See [checkpoints and rewind](getting-started.md#checkpoints-and-rewind) and
[compaction](getting-started.md#compaction) for Native session behavior.

## Keyboard shortcuts (desktop)

Mod is ⌘ on macOS and Ctrl elsewhere.

| Keys | Action |
|---|---|
| Mod+K | Command palette |
| Mod+P / Mod+G | Switch task |
| Mod+N | New task |
| Mod+J | Terminal |
| Mod+, | Settings |
| ⇧Mod+B | Switch or create a branch |
| Mod+B | Sidebar |
| Mod+F | Search the sidebar |
| ⇧Mod+M | Mode selector |
| Mod+\ | Toggle side panels |
| Mod+1…9 | Go to tab |
| Esc | Interrupt the turn |

Rebind in Settings → Keyboard shortcuts (saved as `keybindings.overrides` in
`settings.json`). Mod+1…9 and Esc cannot be rebound.

## Updates

Packaged builds check for updates shortly after launch and then every few hours.
Download and install from Settings → About. On macOS, updates are manual: the app
opens the GitHub Releases page.
