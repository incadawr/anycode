# Configuration files

AnyCode reads two unrelated kinds of configuration, stored in two different
places. Mixing them up is the single most common setup mistake, so this page
puts them side by side.

Requires AnyCode 0.0.35 or newer.

## The two worlds at a glance

| | App settings | Shared config |
|---|---|---|
| File(s) | `~/.anycode/settings.json` | `<project>/.anycode/config.json` and `~/.anycode/config.json` |
| Scope | The whole application | Per project (project file) and per machine (user file) |
| Owns | Provider connections, permissions, tools, network/proxy, appearance, preview | MCP servers, disabled skills, telemetry, repo-map, web-search backend |
| Written by | The Settings UI (and by hand) | By hand, or by the Skills/MCP panes for their own subtrees |
| Precedence | One file, no merge | Project file wins over the user file |
| Secrets | API keys go to `~/.anycode/secrets.json` (mode 0600), never inline | `${env:VAR}` references, never literal tokens |

`~/.anycode/settings.json` is human-editable and diffable (mode 0644). Secrets
of every kind — provider API keys, OAuth tokens, proxy passwords — live in
`~/.anycode/secrets.json` (mode 0600, owner-only) and are referenced from
settings, never inlined.

**Precedence contract:** a project-local `.anycode/` beats the user
`~/.anycode/` for everything that has both scopes — shared config keys, skills,
and subagent profiles alike. Within the shared config, the project file wins
over the user file.

## App settings — `~/.anycode/settings.json`

One file for the whole app. The Settings window is the owner surface for it;
hand edits are fine while the app is not running.

```json
{
  "provider": {
    "activeConnectionId": "zai-main",
    "connections": [
      { "id": "zai-main", "providerId": "z-ai", "model": "glm-5.3" }
    ]
  },
  "tools": { "concurrency": 4 },
  "permissions": {
    "alwaysAllow": [{ "toolName": "Bash", "pattern": "git status*" }]
  }
}
```

- **Provider/connections** — Settings → Provider. One or more named
  connections (provider, model, base URL, per-connection proxy); the active
  connection is the default for new sessions. Details and the engine-vs-
  provider distinction: [engines.md](engines.md).
- **Permissions** — Settings → Permissions. `permissions.alwaysAllow` rules of
  shape `{ "toolName": ..., "pattern": ... }`. Details: [permissions.md](permissions.md).
- **Tools** — Settings → Tools. `tools.concurrency`, `tools.stallTimeoutMs`,
  `tools.maxTurns`, subagent budgets, `tools.grepBackend` (`"rg"` or `"tgrep"`).
- **Network** — Settings → Network. `network.proxyProfiles` and
  `network.proxyRef`. Details: [proxy.md](proxy.md).

**How to verify it applied:** reopen Settings — every pane renders from the
same file. Connection and permission changes reach *new* sessions; restart the
app when in doubt.

## Shared config — `.anycode/config.json`

The project file `<project>/.anycode/config.json` and the user file
`~/.anycode/config.json` share one schema. When both define the same key, the
project file wins.

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
  "telemetry": { "enabled": true },
  "repoMap": { "enabled": true },
  "webSearch": { "backend": "brave", "apiKeyEnv": "BRAVE_API_KEY" }
}
```

- **MCP servers** — `mcpServers`, stdio or HTTP form, `${env:VAR}`
  substitution everywhere a secret would go. Full walkthrough:
  [mcp.md](mcp.md).
- **Skills** — only the `skills.disabled` name list lives here (the Skills pane
  toggles it for you). Details: [skills.md](skills.md).
- **Subagent profiles** — not in this file at all: they are standalone
  `.anycode/agents/*.md` files. Details: [subagents.md](subagents.md).
- **Telemetry / repo-map** — per-workspace opt-ins. Status shows in
  Settings → Environment.
- **Web search backend** — `webSearch` selects `"brave"` (key by env-var name)
  or `"searxng"` (self-hosted endpoint).

**How to verify it applied:** config is read at session boot — start a new
session, then check the matching pane (Settings → MCP for servers,
Settings → Environment for telemetry/repo-map).

## Which file do I edit?

| I want to… | Edit |
|---|---|
| Add a provider connection or switch models | Settings → Provider (`~/.anycode/settings.json`) |
| Add or remove an MCP server | `<project>/.anycode/config.json` (or `~/.anycode/config.json`) |
| Silence a skill | `skills.disabled` in the shared config, or Settings → Skills |
| Add a subagent profile | `<project>/.anycode/agents/<name>.md` — never a JSON file |
| Stop being asked for `git status` | `permissions.alwaysAllow` in Settings → Permissions |
| Route traffic through a proxy | Settings → Network |
| Change tool concurrency / turn limits | `tools` in Settings → Tools |
| Enable telemetry or repo-map | `telemetry`/`repoMap` in the shared config |

## Related pages

- [engines.md](engines.md) — the three engines and how they differ from providers.
- [mcp.md](mcp.md) — the full MCP walkthrough.
- [skills.md](skills.md) and [subagents.md](subagents.md) — extensibility surfaces.
- [permissions.md](permissions.md) — the approval model.
- [troubleshooting.md](troubleshooting.md) — when a change does not seem to apply.
