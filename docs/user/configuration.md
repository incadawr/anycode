# Configuration files

AnyCode reads two unrelated kinds of configuration, stored in different
places. Mixing them up is the most common setup mistake, so this page puts them
side by side.

## The two worlds at a glance

| | App settings | Shared config |
|---|---|---|
| File | `~/.anycode/settings.json` | `<project>/.anycode/config.json` and `~/.anycode/config.json` |
| Scope | The whole application | Per project (project file) and per machine (user file) |
| Owns | Provider connections, permissions, tools, Vision, network and proxies, engine binary paths, session limits, appearance | MCP servers, LSP servers, hooks, disabled skills, telemetry, repo map, web search |
| Written by | The Settings window (or by hand while the app is closed) | By hand, or by the MCP and Skills panes for their own entries |
| Precedence | One file, no merge | Section-specific merge; see below |
| Secrets | API keys in `~/.anycode/secrets.json` (mode 0600), never inline | `${env:NAME}` references, never literal tokens |

`settings.json` is mode 0644 and human-editable. Secrets live in
`~/.anycode/secrets.json` (mode 0600) and are referenced from settings, never
inlined.

## App settings: `~/.anycode/settings.json`

The file carries `"version": 2` and the provider block alongside the sections
below; the snippet shows only the sections discussed here.

```json
{
  "permissions": {
    "alwaysAllow": [{ "toolName": "Bash", "pattern": "pnpm test*" }]
  },
  "tools": { "concurrency": 4, "maxRetries": 8 }
}
```

- **Provider** (Settings → Provider): `provider.connections`, one entry per
  named connection (provider, model, base URL, transport, proxy, image input).
  `provider.activeConnectionId` is the default for new sessions. Connection ids
  are generated (`conn-…`) and the UI does not show them; read them from
  `provider.connections[].id` when a profile or file needs one.
  - **Image input** (in the connection drawer): Auto, On or Off, set per model.
    On or Off overrides the catalog's own answer for the model it was set for.
  - **Quota**: an HTTP provider that reports its subscription quota in response
    headers shows the remaining quota on the connection card. AnyCode keeps the
    last value for each connection.
- **Permissions** (Settings → Permissions): `permissions.alwaysAllow`. See
  [permissions.md](permissions.md).
- **Tools** (Settings → Tools):
  - `tools.concurrency`: parallel read-only tool calls (default 4).
  - `tools.stallTimeoutMs`: per-attempt provider stream watchdog (default 90000 ms).
  - `tools.maxTurns`: turn limit for the main agent (default 100).
  - `tools.subagentMaxTurns`: turn limit for subagents (default 40).
  - `tools.maxRetries`: provider retry attempts (the pane's "Retry attempts"; default 8).
  - `tools.networkRetryBudgetMs`: wall-clock budget for riding out a network outage (the pane's "Network retry budget (ms)"; default 300000 ms, 5 minutes).
  - `tools.grepBackend`: `"rg"` (default) or `"tgrep"`.
  - `tools.archMap`: `true` opts into the read-only import-graph tool.
  - `tools.subagentStallTimeoutMs`: silence limit for a running subagent (default 600000 ms).
  - `tools.networkWaitMaxMs`: maximum network wait (default 1800000 ms, 30 minutes).
  - `tools.adaptiveTurnBudget`: opt into learned budgets when no explicit budget applies.
- **Session limits** (Settings → Tools, top-level `sessionLimits`): open tabs (default 20), child sessions per parent (3) and app-wide (8). The pane accepts 4–40, 1–8 and 1–24.
- **Vision** (Settings → Vision): `recognizer` `{ connectionId, modelId }`. When the
  main model cannot see images, this connection and model answer `InspectImage`
  calls. Unset means the fallback is off.
- **Network** (Settings → Network): `network.proxyProfiles` and `network.proxyRef`.
  See [proxy.md](proxy.md).
- **Codex / Claude** (Settings → Codex, Settings → Claude): `codex` and `claude`
  hold the chosen binary path, the last doctor check, and the engine's proxy.
  Codex also holds account `profiles`, `activeProfileId` and `riskAcceptedVersions`.
  Claude holds `modelCatalog` and `contextWindowTokens` (100k–1M).
  Edit these through the panes.

### Other app settings

| Key | Owner and use |
|---|---|
| `roles`, `roleProfiles` | Settings → Roles; [routing and project assignments](roles.md) |
| `provider.custom[]` | Custom endpoint records; use Settings → Provider |
| Connection `promptCache`, `maxOutputTokens`, `contextWindowTokens`, `pricing`, `modelOverrides` | Connection drawer; [providers](providers.md) |
| `permissions.classifier` | Optional automatic command review; [permissions](permissions.md#ask-classifier) |
| `security.trustedBinaries` | Settings → Permissions → Trusted binaries |
| `security.allowWeakSecretStorage` | Consent to plaintext storage if OS secure storage is unavailable |
| `browser.fullAccessDefault` | Permissions; `off` by default for new sessions |
| `codexContinueOnAnotherAccount` | Codex account continuation, on unless set to `"off"` |
| `communication` | Sessions API pane |
| `plugins` | Plugin updates, consents and account sources |
| `preview.autoOpen`, `preview.displayMode`, `preview.liveReload` | Preview controls; panel/window display |
| `ui.theme` | Appearance: `system`, `light`, `dark` |
| `keybindings.overrides` | Keyboard shortcuts; [default keys](cli.md#keyboard-shortcuts-desktop) |

A missing settings file uses defaults. Corrupt JSON or a schema-invalid file is
set aside as `settings.json.corrupt-<timestamp>` when possible; defaults are
used. A settings file from a newer schema version opens read-only. Unknown
top-level keys survive ordinary saves. Prefer Settings over manual edits.

### Environment overrides

Variables already present in the app's launch environment win over settings:

| Setting | Variable |
|---|---|
| `tools.concurrency` | `ANYCODE_TOOL_CONCURRENCY` |
| `tools.stallTimeoutMs` | `ANYCODE_STALL_TIMEOUT_MS` |
| `tools.maxTurns` | `ANYCODE_MAX_TURNS` |
| `tools.subagentMaxTurns` | `ANYCODE_SUBAGENT_MAX_TURNS` |
| `tools.subagentStallTimeoutMs` | `ANYCODE_SUBAGENT_STALL_MS` |
| `tools.maxRetries` | `ANYCODE_MAX_RETRIES` |
| `tools.networkRetryBudgetMs` | `ANYCODE_NETWORK_RETRY_BUDGET_MS` |
| `tools.networkWaitMaxMs` | `ANYCODE_NETWORK_WAIT_MAX_MS` |
| `tools.adaptiveTurnBudget` | `ANYCODE_ADAPTIVE_TURN_BUDGET` |
| `tools.grepBackend` | `ANYCODE_GREP_BACKEND` |
| `tools.archMap` | `ANYCODE_ARCHMAP` |

Other launch controls:

- `ANYCODE_EFFORT_LEVELS`, `ANYCODE_IMAGE_INPUT`, `ANYCODE_PRESERVE_REASONING`,
  `ANYCODE_REASONING_HISTORY`, `ANYCODE_REASONING_COMPACTOR_MODEL`: see
  [providers](providers.md). Effort accepts `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`; the current model may accept only a subset.
- `ANYCODE_TELEMETRY=0` disables telemetry; `ANYCODE_TELEMETRY_DIR` overrides its folder.
- `ANYCODE_REPO_MAP=0|1` forces the repository map off/on.
- `ANYCODE_TODO_REMINDER_EVERY` changes the TodoWrite reminder cadence.
- `ANYCODE_EXPLORE_MODEL` chooses the builtin explore model.
- `ANYCODE_SUBAGENT_MAX_TURNS`, `ANYCODE_SUPERVISOR_IDLE_MS`: see [roles](roles.md).
- `ANYCODE_CODEX_BIN`, `ANYCODE_CLAUDE_BIN`: see [engines](engines.md).
- `ANYCODE_DB_PATH`: see [files and paths](files-and-paths.md).
- `ANYCODE_COMMUNICATION_CONFIG`: file-based Sessions API control.
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`: see [proxy](proxy.md).

The Provider pane shows an **Environment override** notice for provider variables.
A desktop app launched from the Dock or Start menu may not see your shell profile.
Check the launch environment when a setting appears to do nothing; refer to
variable names without printing secret values.

**Verify it applied:** settings changes take effect in sessions you start
afterwards. If a running tab still behaves the old way, start a new session.

## Shared config: `.anycode/config.json`

The project file `<project>/.anycode/config.json` and the user file
`~/.anycode/config.json` share one schema. A project key wins over the same
user key according to the section:

- `mcpServers`: project names win over user names, then `.mcp.json` fills gaps.
- `lspServers`: project entries win over user entries by server name.
- `skills.disabled`: a name disabled in either file stays disabled.
- `webSearch`, `telemetry`, `repoMap`: a project section replaces the user section
  as a whole. They do not merge individual fields.
- `hooks`: both files contribute, user hooks first.

Folder trust gates project executable config and project telemetry/repo-map
sections. See [workspace trust](getting-started.md#workspace-trust).

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@context7/mcp-server"],
      "env": { "API_TOKEN": "${env:MY_TOKEN}" }
    }
  },
  "skills": { "disabled": ["example-skill"] },
  "lspServers": [
    {
      "name": "typescript",
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    }
  ],
  "telemetry": { "enabled": true },
  "repoMap": { "enabled": true },
  "webSearch": { "backend": "brave", "apiKeyEnv": "BRAVE_API_KEY" }
}
```

- **MCP servers**: `mcpServers`, as a stdio or HTTP entry. See [mcp.md](mcp.md).
- **Hooks**: commands at tool, prompt and stop events. See [hooks](hooks.md).
- **Skills**: `skills.disabled` lists skill names to hide. The Skills pane
  toggles it for filesystem skills. See [skills.md](skills.md).
- **Language servers**: `lspServers`, an array of server entries. The
  Language servers pane writes it from its catalog; entries start with new
  sessions. See [lsp.md](lsp.md).
- **Subagent profiles** are not in this file. They are standalone
  `.anycode/agents/*.md` files. See [subagents.md](subagents.md).
- **Telemetry**: `telemetry.enabled: true` turns on a local JSONL sink, and
  optional `dir` (an absolute path) changes where it writes. The variable
  `ANYCODE_TELEMETRY=0` turns it off; no environment variable turns it on. Retention defaults to
  180 days, 20,000 files and 64 MiB; set `telemetry.retention` to change it.
- **Repo map**: `repoMap.enabled` and optional `maxTokens` (clamped to 500–8,000;
  default 2% of context window). The map is frozen at session boot.
- **Web search**: `webSearch.backend` is `"brave"` (the key comes from the
  environment variable named in `apiKeyEnv`) or `"searxng"` (set `endpoint` to
  your instance). `maxResults` is 1–10, default 5.

**Verify it applied:** shared config is read when a session starts. Start a new
session, then check Settings → MCP for servers and Settings → Environment for
telemetry and repo map.

## Environment of tools

Tools that a session starts (Bash, hooks, the terminal, and the Claude and Codex
engine processes) see two variables that identify the session:

- `ANYCODE_SESSION_ID` is the same id that the Sessions API reports as
  `sessionId` (see [Communicating with live sessions](https://github.com/incadawr/anycode/blob/master/docs/development/agent-communication.md)).
- `ANYCODE_SESSION_WORKSPACE` is the session's workspace folder.

Both are set on every spawn, including a restart of the session's process. The
engine variables are best-effort: they reach the engine process, and an engine's
own shell tools see them only if the engine passes its environment through. A
Codex user config that sets its own shell environment policy can change that.
MCP stdio servers and language servers do not receive them.

`ANYCODE_WORKSPACE` is a different variable. It is the launch directive that
opens a workspace when AnyCode starts, so a nested `anycode` started from a
tool's Bash opens that workspace. Use `ANYCODE_SESSION_WORKSPACE` to find the
current workspace.

## Which file do I edit?

| I want to | Edit |
|---|---|
| Add a provider connection or switch models | Settings → Provider |
| Add or remove an MCP server | Settings → MCP, or `mcpServers` in the shared config |
| Add or remove a language server | Settings → Language servers, or `lspServers` in the shared config |
| Hide a skill | Settings → Skills, or `skills.disabled` in the shared config |
| Add a subagent profile | `<project>/.anycode/agents/<name>.md`, not a JSON file |
| Stop being asked about a command | Settings → Permissions (always-allow rule) |
| Route traffic through a proxy | Settings → Network |
| Let an external agent message a live session | Settings → Sessions API (the `communication` block) |
| Start new sessions with full browser access | Settings → Permissions (`browser.fullAccessDefault`, default off) |
| Change tool concurrency or turn limits | Settings → Tools |
| Turn on telemetry or the repo map | `telemetry` or `repoMap` in the shared config |

## Related pages

- [engines.md](engines.md): the three engines and how they differ from providers.
- [mcp.md](mcp.md): the MCP walkthrough.
- [sessions-api.md](sessions-api.md): the `communication` block in
  `settings.json` is owned by Settings → Sessions API.
- [lsp.md](lsp.md): the language-server walkthrough.
- [skills.md](skills.md) and [subagents.md](subagents.md): extensibility surfaces.
- [permissions.md](permissions.md): the approval model.
- [troubleshooting.md](troubleshooting.md): when a change does not seem to apply.

- [providers](providers.md): model capabilities, reasoning history and setup export/import.
