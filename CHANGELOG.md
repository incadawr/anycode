# Changelog

All notable AnyCode changes are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [0.0.7] — 2026-07-26

### Fixed

- A tool could send an unlimited amount of text to the model. Reading a large
  file or running a command with megabytes of output put the whole payload into
  the request, which burned through the context window in a single step and, on
  providers that enforce a hard context limit, ended the session with an
  authentication error instead of an answer. Every tool result now passes a
  size budget on its way to the model — including results from custom
  formatters, from MCP servers, and from failures, none of which were covered
  before. Tools that declare no budget of their own get a safe default, so a
  tool added tomorrow cannot reopen the hole.
- `Read` no longer pulls an entire file into the context. A file over the
  per-read limit comes back as a partial view with the exact offset and limit
  needed to continue, and a request for an explicit range that does not fit
  fails loudly instead of quietly returning less than was asked for.
- Command output is now kept from the end rather than the beginning: the tail
  of a build log is where the error is.
- The Codex and Claude Code engines now start when AnyCode itself was launched
  from Finder or the Dock. An application opened that way inherits the system's
  default `PATH` rather than the one from your shell, so the `codex` and
  `claude` launchers — scripts that resolve `node` through the environment —
  failed with exit code 127, while the very same setup worked when AnyCode was
  started from a terminal. The usual install locations are now appended to the
  inherited `PATH`; a `PATH` you set yourself still takes precedence.

## [0.0.6] — 2026-07-25

### Added

- Image attachments for the Claude Code engine. A session running on the Claude
  Code CLI can attach images and ask about them. Two separate gates had kept
  this closed: the engine declared no image support, and the Claude session was
  never given the seam the composer reads to offer the attach button, so
  attachments were dropped before the engine ever saw them.

### Fixed

- The context meter now works for Claude Code sessions. The reading is taken
  after the turn's terminal result — the point at which the CLI's own accounting
  of the window is final — but the renderer discarded any event arriving after
  the turn closed, so the meter had never displayed a value for this engine. The
  reading is a session-level status, not turn content, and is no longer tied to
  the turn that happened to precede it.

### Changed

- A failed or unusable context reading is logged instead of being swallowed
  silently. Previously both failure paths returned no value without a trace,
  which is what let the meter stay blank unnoticed.

## [0.0.5] — 2026-07-19

### Added

- Reasoning effort for the Claude Code engine. A session running on the Claude
  Code CLI can pick a reasoning effort level next to its model.
- Codex plan in the progress panel. Codex keeps its own todo list while it
  works; every revision of that plan now appears in the progress panel and as a
  todo card in the transcript, the same way the built-in and Claude Code
  engines already did. Previously the plan never reached the UI at all.

### Changed

- Codex permission presets now mirror Codex's own permission menu:
  **Ask for approval**, **Approve for me**, and **Full access** replace the
  previous Read-only/Ask/Workspace set. "Approve for me" keeps the workspace
  boundary and routes eligible approvals to automatic review. **"Full access"
  removes the sandbox and approval prompts entirely** — the agent can read and
  write wherever you can and reach the network without asking, so pick it
  deliberately. Sessions created on the old Read-only preset keep their
  original posture when resumed; that preset is simply no longer offered for
  new sessions.

### Fixed

- "New task in this project" now opens the same New Task draft as every other
  entry point, with the project preselected, so the harness can be chosen
  before the session starts. It previously created the tab immediately and
  silently used the default engine.

## [0.0.4] — 2026-07-19

### Alpha

The Claude Code engine ships in TEST MODE: it works end-to-end but is still
being polished — expect rough edges, and treat it as a preview.

### Added

- Claude Code engine (test mode). A session can run on the official Claude
  Code CLI installed on your machine: AnyCode spawns the CLI as-is and signs
  in with your own Claude Code login — the app never reads or stores your
  tokens. Includes an onboarding pane with an environment doctor, an in-app
  "Use my Claude subscription" sign-in, streamed reasoning and tool activity,
  approval prompts, and session resume. The pane carries an honest note about
  subscription quota sharing and terms-of-service gray areas.
- Codex account profiles. Multiple Codex accounts side by side: add one with
  the native login flow, pick a profile per tab, and see the active profile as
  a chip next to the Agent selector.
- Codex context meter and subscription quotas. Live context usage and the
  provider-reported rate-limit/quota state are shown for Codex sessions.
- Codex session import. An existing Codex CLI session (rollout) can be
  imported and continued as an AnyCode session.
- Managed codex binary. A version manifest with download/update from npm, so
  the app can provision a known-good codex binary instead of relying on
  whatever is on PATH.
- Custom model providers. Add a provider by base URL with an optional API
  key, fetch its model list, and choose which models to expose.
- Image attachments. Images can be attached to a prompt and are delivered to
  models that support vision; the attach control is capability-gated per
  model.
- Artifact previews in chat. Image files produced by the agent show up as
  preview chips with open and reveal-in-Finder actions, contained to the
  session's allowed roots.

### Fixed

- Codex readiness checks are cached and primed at boot, so tab creation no
  longer stalls on a cold doctor probe.
- A failed session resume now shows copy that matches the session's actual
  engine instead of a generic message.

## [0.0.3] — 2026-07-17

### Alpha

Manual verification still focuses on the Z.AI (GLM) path. The provider and
transport surface below is broad; not every provider/transport combination has
been validated in live use yet.

### Added

- Multiple named provider connections. Settings now shows a grid of connection
  tiles with an add/edit drawer: create, edit, activate, and delete
  connections, each with its own credential, model, transport, and base URL. A
  first-run Welcome flow sets up the first one.
- OpenAI-compatible and local endpoints. A connection can use an OpenAI-family
  transport (chat completions or responses) alongside Anthropic Messages, so
  OpenAI-compatible and self-hosted servers work. Keyless local servers
  (LM Studio, ollama, llama.cpp, open proxies) are supported through a
  "no API key" option that stops the connection from asking for a credential.
- Per-session connection pinning. A session remembers the connection it runs
  on — shown in the model pill — so different tabs can use different providers.
- Connection health. Each connection shows a status you can check, and it
  repaints from live request outcomes.
- Observable retry. A transient request failure is classified and surfaced with
  a one-shot "Try again" instead of failing silently, and provider errors are
  redacted to a safe message before they reach the screen.

### Fixed

- Deleting the active connection now promotes another one instead of leaving no
  connection active.
- Activating a connection that can't run tasks (no credential, no model, or an
  unsupported transport) now keeps the normal shell with Settings reachable and
  shows a readiness notice, instead of dropping a configured user into
  onboarding.

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
