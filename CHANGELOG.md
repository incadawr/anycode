# Changelog

All notable AnyCode changes are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [0.0.2] — 2026-07-15

### Added

- Isolated worktree sessions. A task can move itself into its own Git worktree
  and branch (`EnterWorktree`) and come back to the project checkout
  (`ExitWorktree`), so tasks running in parallel no longer share one working
  tree. The relocation is recorded and survives a restart, and the built-in
  `using-worktrees` skill explains when to reach for it.
- Cleanup of the worktrees AnyCode itself created: on startup it removes the
  checkouts left behind by an interrupted session, and deletes their branches
  only when they are already merged. Worktrees and branches it did not create
  are never touched.

## [0.0.1] — 2026-07-12

### Alpha

The first versioned AnyCode baseline.

Manual verification has so far covered only the Z.AI (GLM) provider. Supported
Anthropic and custom Anthropic-compatible endpoints need separate practical
validation before they are considered release-ready.

### Added

- A desktop application for multi-tab agent coding sessions with persistent
  history.
- LLM provider configuration, including Z.AI (GLM), Anthropic, and custom
  Anthropic-compatible endpoints.
- An agent loop with tool calls, permission modes, file actions, terminal
  commands, and transcript rendering.
- A context meter showing session usage and the most recent provider cache hit
  when the provider supplies those values.
- Settings, MCP servers, skills, subagents, Git review, and development
  automation smoke tooling.
- A public developer workflow and an enforced dev/release boundary for
  automation smoke.

[0.0.2]: https://github.com/incadawr/anycode/releases/tag/v0.0.2
[0.0.1]: https://github.com/incadawr/anycode/releases/tag/v0.0.1
