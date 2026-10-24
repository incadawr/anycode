# AnyCode user documentation

This tree is the source of truth for configuring and using AnyCode as a user.
It ships with every release. For developer-facing material (building,
automation, release policy) see [../development/README.md](../development/README.md).

Requires AnyCode 0.0.35 or newer unless a page says otherwise.

## Topics

- [Configuration files](configuration.md) — the two config worlds: the app
  settings in `~/.anycode/settings.json` versus the shared
  `.anycode/config.json` (project and user), which file every need maps to,
  and how to verify a change applied.
- [Engines](engines.md) — Native, Codex CLI, and Claude Code: binary
  discovery, sign-in, the trust/consent prompt, per-engine proxy, and the
  engine-vs-provider distinction.
- [Subagents](subagents.md) — the built-in personas and your own
  `.anycode/agents/*.md` profiles: full frontmatter reference, the three hard
  rules, connection routing semantics, and complete examples per engine kind.
- [Skills](skills.md) — what a skill is, where skills live (roots and
  precedence), the frontmatter contract, the built-in skills the app ships,
  and how a same-name skill replaces one.
- [MCP servers](mcp.md) — declaring stdio and HTTP servers in
  `mcpServers`, the `${env:VAR}` secret pattern, failure behavior, and
  verifying servers came up.
- [Permissions](permissions.md) — the mode ladder (`plan/build/edit/auto/yolo`),
  always-allow rules with patterns, workspace confinement, trusted binaries,
  and the approval modal.
- [Orchestration](orchestration.md) — the multi-model supervisor/lead/builder
  pattern and where its full setup lives.
- [Proxy and network](proxy.md) — named proxy profiles, the app default,
  system proxy, no-proxy lists, and per-connection/per-engine routing.
- [Troubleshooting](troubleshooting.md) — checklists for the three classic
  failures ("MCP server missing", "configure roles", "skill not visible") and
  where the logs live.

## The precedence contract, in one line

A project `.anycode/` beats the user `~/.anycode/` — for config keys, skills,
and subagent profiles alike.

## Secrets

Secrets (`~/.anycode/secrets.json`, mode 0600, owner-only) never sit in
`settings.json` (mode 0644, human-editable) or in a project config: API keys
are referenced from settings, and tokens reach MCP servers through
`${env:VAR}` substitution.

## Where the Settings panes map in this tree

| Settings pane | Page |
|---|---|
| Provider | [configuration.md](configuration.md), [engines.md](engines.md) |
| Codex / Claude | [engines.md](engines.md) |
| Permissions | [permissions.md](permissions.md) |
| Tools | [configuration.md](configuration.md) |
| Vision | [configuration.md](configuration.md) (connections) |
| Network | [proxy.md](proxy.md) |
| MCP | [mcp.md](mcp.md) |
| Skills | [skills.md](skills.md) |
| Subagents | [subagents.md](subagents.md) |
| Environment | [troubleshooting.md](troubleshooting.md) (logs), [configuration.md](configuration.md) |
| Appearance / Shortcuts / About | App-only panes — no configuration file; About shows the app version used for docs links. |
