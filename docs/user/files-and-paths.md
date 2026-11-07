# Files and paths

`~` means your home directory. Expand it before using an absolute-path tool.
App settings and shared config have different owners and merge rules:
[configuration](configuration.md). Never inspect secret or authentication files
when diagnosing a setup.

## User data in `~/.anycode/`

| Path | Purpose and owner |
|---|---|
| `settings.json` (0644) | Version 2 app settings; prefer Settings, or edit while the app is closed |
| `secrets.json` (0600) | Credentials, encrypted with OS secure storage when available; enter only through Settings |
| `config.json` | User MCP, LSP, hooks, skill disabling, telemetry, repo map and web search |
| `agents/<name>.md` | User subagent profiles |
| `skills/<name>/SKILL.md` | User skills |
| `workflows/<name>.json` | User workflows |
| `plugins/` | User plugins; manage through Settings → Plugins |
| `workspace-trust.json` | Saved folder-trust decisions; use the trust UI |
| `anycode.sqlite` | Session database; do not edit by hand |
| `checkpoints/` | Shadow git checkpoint stores |
| `artifacts/` | Spilled tool results and artifacts; age-based cleanup after seven days |
| `telemetry/` | Opt-in local telemetry; default retention 180 days, 20,000 files, 64 MiB |
| `codex/bin/<version>/` | Managed Codex binaries |
| `codex/profile-<id>/` | Codex account homes; manage in Settings → Codex |
| `tmp/` | Private temporary child-session data |

`ANYCODE_DB_PATH` overrides the database location. Artifact and checkpoint roots
normally move beside that database. `ANYCODE_TELEMETRY_DIR` can change telemetry
location; `telemetry.retention` in the user file `~/.anycode/config.json` controls
its retention. Project retention settings are ignored. `~/.agents/skills/` is an
additional user skill root.

If OS secure storage is unavailable, plaintext secret storage requires consent
(`security.allowWeakSecretStorage`). It does not make the file safe to share.

## Project files

| Path | Purpose |
|---|---|
| `.anycode/config.json` | Shared project configuration; see section-specific merge and trust rules |
| `.anycode/agents/<name>.md` | Project profiles; main-checkout profiles can also be discovered in a linked worktree |
| `.anycode/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` | Project skills |
| `.anycode/workflows/<name>.json` | Project workflows |
| `.anycode/plugins/` | Project plugins with their own trust policy |
| `.anycode/worktrees/` | Managed git checkouts, on branches prefixed `anycode-wt/` |
| `.mcp.json` | Additional project MCP configuration, gated by folder trust |

A project profile or skill wins over a same-named user entry. Project config is
not a single wholesale replacement of user config. See
[workspace trust](getting-started.md#workspace-trust) before enabling project programs.

## Desktop app data

`<userData>` is `~/Library/Application Support/AnyCode` on macOS,
`%APPDATA%\AnyCode` on Windows, and normally `~/.config/AnyCode` on Linux
(or under `$XDG_CONFIG_HOME`).

| Path under `<userData>` | Purpose |
|---|---|
| `logs/anycode.log`, `logs/anycode.log.1` | Diagnostic log and rotation, 1 MiB each, with redaction |
| `crash-dumps/` | Local native crash dumps; no automatic upload |
| `communication.json` | Sessions API discovery and token; do not share its contents |
| `agent-communication/stdio.mjs` | Sessions API stdio adapter |
| `communication-sessions.json`, `communication-handles.json`, `communication-agent-titles.json` | API sharing and handles |
| `browser-access.json` | Per-session browser-access state |
| `child-worktrees/` | Managed child-worktree lifecycle records |
| `diagnostics/` | Diagnostic records used for export |

Use **Export diagnostics** in the session Environment menu for a previewable
bundle. Review paths and prompts before sharing. It can include retained
telemetry records even when new telemetry collection is off. See [troubleshooting](troubleshooting.md#logs-and-crash-dumps).

## Packaged documentation and tool environment

The app ships this guide under `<Resources>/docs/user/`. The setup skill uses
that copy, a development checkout, or versioned GitHub pages as a fallback.

Bash, hooks, terminal and engine processes receive `ANYCODE_SESSION_ID` and
`ANYCODE_SESSION_WORKSPACE`. An engine decides what reaches its own shell tools.
`ANYCODE_WORKSPACE` instead selects a workspace when launching AnyCode.
