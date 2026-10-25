# AnyCode user documentation

This tree describes how to configure and use AnyCode as a user. It is
packaged with the app and read by the built-in `anycode-setup` skill. For
developer-facing material (building, automation, release policy) see
[../development/README.md](../development/README.md).

## Topics

- [Configuration files](configuration.md): the two config worlds, the app
  settings in `~/.anycode/settings.json` and the shared `.anycode/config.json`
  (project and user), which file each need maps to, and how to verify a change.
- [Engines](engines.md): the Native, Codex and Claude engines, binary discovery
  and trust, sign-in, per-engine proxy, and the engine-versus-provider split.
- [Subagents](subagents.md): the built-in personas and your own
  `.anycode/agents/*.md` profiles, with the frontmatter reference and examples.
- [Skills](skills.md): skill folders, roots and precedence, the `Skill` tool,
  disabling, and the built-in skills the app ships.
- [MCP servers](mcp.md): declaring stdio and HTTP servers, the `${env:NAME}`
  secret pattern, failure behaviour, and how to verify a server came up.
- [Language servers](lsp.md): the `lspServers` entries that give the agent
  go-to-definition and diagnostics, the Settings pane's catalog and PATH
  detection, and when changes apply.
- [Browser control](browser.md): operating a page in the built-in preview
  (navigate, snapshot, click, type, wait), the ref workflow, limits and approval.
- [Permissions](permissions.md): the mode ladder (`plan`, `build`, `edit`,
  `auto`, `yolo`), always-allow rules and patterns, workspace confinement,
  trusted binaries, and the approval prompt.
- [Orchestration](orchestration.md): a supervisor session that dispatches work
  to subagent profiles, built from the pieces above.
- [Proxy and network](proxy.md): proxy profiles, the application default,
  per-connection and per-engine proxies, and no-proxy lists.
- [Sessions API](sessions-api.md): enabling the local MCP endpoint from
  Settings → Sessions API, sharing a session, connecting Claude Code or Codex,
  and the token and folder rules.
- [Plugins](plugins.md): what plugins are, where they live, the trust tiers,
  two-phase install, MCP-server consent, updates, rollback and pinning.
- [Troubleshooting](troubleshooting.md): checklists for a missing MCP server,
  orchestration roles, and a missing skill, and where problems are shown.

## The precedence contract, in one line

A project `.anycode/` beats the user `~/.anycode/` for config keys, skills, and
subagent profiles alike.

## Secrets

Secrets, including provider API keys, OAuth tokens and proxy passwords, live in
`~/.anycode/secrets.json` (mode 0600, owner-only). They never sit in
`~/.anycode/settings.json` (mode 0644, human-editable) or in a project config.
Tokens reach MCP servers through `${env:NAME}` references.

## Where the Settings panes map in this tree

| Settings pane | Page |
|---|---|
| Profile | Usage statistics from local telemetry; no configuration file. |
| Provider | [configuration.md](configuration.md), [engines.md](engines.md) |
| Codex, Claude | [engines.md](engines.md) |
| Permissions | [permissions.md](permissions.md) |
| Tools | [configuration.md](configuration.md) |
| Vision | [configuration.md](configuration.md) |
| Network | [proxy.md](proxy.md) |
| MCP | [mcp.md](mcp.md) |
| Language servers | [lsp.md](lsp.md) |
| Sessions API | [sessions-api.md](sessions-api.md) |
| Skills | [skills.md](skills.md) |
| Subagents | [subagents.md](subagents.md) |
| Plugins | [plugins.md](plugins.md) |
| Environment | [configuration.md](configuration.md) (telemetry, repo map) |
| Appearance, Keyboard shortcuts, About | App-only; no configuration file. |
