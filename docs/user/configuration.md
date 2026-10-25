# Configuration files

AnyCode reads two unrelated kinds of configuration, stored in different
places. Mixing them up is the most common setup mistake, so this page puts them
side by side.

## The two worlds at a glance

| | App settings | Shared config |
|---|---|---|
| File | `~/.anycode/settings.json` | `<project>/.anycode/config.json` and `~/.anycode/config.json` |
| Scope | The whole application | Per project (project file) and per machine (user file) |
| Owns | Provider connections, permissions, tools, Vision, network and proxies, engine binary paths, session limits, appearance | MCP servers, disabled skills, telemetry, repo map, web search |
| Written by | The Settings window (or by hand while the app is closed) | By hand, or by the MCP and Skills panes for their own entries |
| Precedence | One file, no merge | The project file wins over the user file, key by key |
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
  - `tools.subagentStallTimeoutMs`: silence limit for a running subagent.
  - `sessionLimits`: open tabs (default 20), child sessions per parent (3) and app-wide (8). The pane accepts 4–40, 1–8 and 1–24.
- **Vision** (Settings → Vision): `recognizer` `{ connectionId, modelId }`. When the
  main model cannot see images, this connection and model answer `InspectImage`
  calls. Unset means the fallback is off.
- **Network** (Settings → Network): `network.proxyProfiles` and `network.proxyRef`.
  See [proxy.md](proxy.md).
- **Codex / Claude** (Settings → Codex, Settings → Claude): `codex` and `claude`
  hold the chosen binary path, the last doctor check, and the engine's proxy.
  Edit these through the panes.

**Environment variables win over settings.** A matching variable in the app's
launch environment overrides the settings value. The variables that do this are
`ANYCODE_TOOL_CONCURRENCY`, `ANYCODE_STALL_TIMEOUT_MS`, `ANYCODE_MAX_RETRIES`,
`ANYCODE_NETWORK_RETRY_BUDGET_MS`, `ANYCODE_GREP_BACKEND` and `ANYCODE_ARCHMAP`.
If a setting seems to have no effect, check for one of these. The Provider pane
shows an "Environment override" notice when a provider variable is set.

**Verify it applied:** settings changes take effect in sessions you start
afterwards. If a running tab still behaves the old way, start a new session.

## Shared config: `.anycode/config.json`

The project file `<project>/.anycode/config.json` and the user file
`~/.anycode/config.json` share one schema. A project key wins over the same
user key. Web search is the exception: `webSearch` is one object, so the project
file replaces the user object wholesale.

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
- **Skills**: `skills.disabled` lists skill names to hide. The Skills pane
  toggles it for filesystem skills. See [skills.md](skills.md).
- **Language servers**: `lspServers`, an array of server entries. The
  Language servers pane writes it from its catalog; entries start with new
  sessions. See [lsp.md](lsp.md).
- **Subagent profiles** are not in this file. They are standalone
  `.anycode/agents/*.md` files. See [subagents.md](subagents.md).
- **Telemetry**: `telemetry.enabled: true` turns on a local JSONL sink, and
  optional `dir` (an absolute path) changes where it writes. The variable
  `ANYCODE_TELEMETRY=0` turns it off; no environment variable turns it on.
- **Repo map**: `repoMap.enabled` and optional `maxTokens`.
- **Web search**: `webSearch.backend` is `"brave"` (the key comes from the
  environment variable named in `apiKeyEnv`) or `"searxng"` (set `endpoint` to
  your instance).

**Verify it applied:** shared config is read when a session starts. Start a new
session, then check Settings → MCP for servers and Settings → Environment for
telemetry and repo map.

## Environment of tools

Tools that a session starts (Bash, hooks, the terminal, and the Claude and Codex
engine processes) see two variables that identify the session:

- `ANYCODE_SESSION_ID` is the same id that the Sessions API reports as
  `sessionId` (see [Communicating with live sessions](../development/agent-communication.md)).
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
