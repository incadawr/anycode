# Changelog

All notable AnyCode changes are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [0.0.11] — 2026-08-15

### Added

- A subagent now runs as a session of its own instead of disappearing inside
  its parent's transcript. Its card in the parent opens a split pane where the
  child's own conversation is visible while it works; a message can be sent
  into a running child, and its permission prompts are answered in its own
  pane. Children handed to the Codex and Claude engines boot in child mode
  with their own permission broker and their own model — they no longer
  inherit the parent's silently — and a child whose engine record is missing
  refuses honestly instead of starting on an empty transcript. The card
  survives a reload: reopening a session redraws the children it spawned,
  along with what they did.
- Sessions can be deleted. Until now the list only ever grew: a session that
  was a typo, a smoke run, or a dead experiment stayed there forever. Rows
  now carry a delete action, and there is a bulk flow for clearing everything
  older than a chosen age which counts the affected sessions first and states
  that count before anything is removed. Deleting a session also deletes the
  children it spawned, so a subagent tree never outlives its parent as an
  orphan.
- A child that stopped for a permission prompt is now visible from the
  parent — the parent's own row reports it instead of appearing merely busy —
  and the badge is a button: clicking it opens that child's pane with the
  Allow/Deny prompt already on screen, so answering no longer means hunting
  for the right session first.

### Fixed

- The Z.AI model catalog was stale and its errors were misread. The list now
  matches the published line-up, newest first, so a new connection prefills a
  current model. And a rejected key is no longer reported as a broken
  endpoint: Z.AI answers an auth failure with HTTP 200 carrying an error body,
  which used to read as a successful fetch that simply found no models — that
  case is now named as the key problem it is, and a genuinely empty catalog is
  reported as its own distinct outcome.

## [0.0.10] — 2026-08-08

### Added

- A tool's full output is no longer lost when it is too large for the
  conversation. The part over the budget used to be cut off, recoverable only
  by re-running the tool; now the complete output is written to a file under
  AnyCode's own data directory and the model receives the beginning together
  with the file's path, so it can read or search the rest on demand. The files
  live per session and are swept on startup.
- The Welcome screen names the version that is running. It is the one surface
  a fresh or broken install has, and its banner already suggests upgrading —
  now it is possible to tell whether an upgrade is actually needed.

### Fixed

- A subscription provider that reports an exhausted usage limit as HTTP 403 —
  kimi.com does — was shown as a generic "forbidden" error, which reads like a
  broken key. It is now recognized as the quota condition it is.
- A connection created from the catalog could be saved with an empty model and
  then fail on first use with a message blaming the API key. The connection
  drawer now prefills the curated default model and refuses to save a catalog
  connection whose model is still blank.

### Security

- An always-allow rule for terminal commands now vouches for every command in
  the line, not for the line's first word. `git *` used to auto-approve
  `git --version; curl … | sh` because the line started with `git`; now each
  segment of a compound command must match a rule on its own, and anything the
  parser cannot see through — command substitution, unterminated quotes —
  asks again instead of passing. The permission dialog also no longer offers a
  pre-filled binary pattern for a compound command, which is exactly how an
  overly broad rule used to get created.

## [0.0.9] — 2026-08-03

### Added

- Previews for the files an agent produces. A local HTML or Markdown file can
  now be opened inside AnyCode itself: click it in the transcript and it shows
  up either in a resizable panel next to the conversation or in a window of its
  own, whichever you choose in Settings, and it can be moved from one to the
  other while it stays open. Before this the only thing to do with such a file
  was to reveal it in Finder and open it in some other application. A preview
  is sandboxed and fetches nothing from the network by itself, so an HTML file
  that pulls a script or a font from a CDN renders without it rather than
  reaching out; a remote address loads only after you allow it.
- Markdown is drawn by AnyCode directly instead of being converted into a web
  page first. The renderer is the one chat messages already use, so a
  document's relative images resolve against the folder it lives in, and a link
  to another Markdown file beside it replaces the current view in place. The
  header carries the document's name, a Rendered/Source switch, reload, and
  reveal in folder. Nothing is written to disk to produce a preview, and page
  scripts never come into it, because there is no page.
- A preview opens on its own at the end of a turn in which the model wrote or
  edited an HTML or Markdown file, and refreshes when one is already open for
  that file. This is on by default and can be switched off in Settings.
- The model can use previews as an instrument: it can open a local artifact or
  a development server on localhost, read back the rendered text and the tail
  of the console, and take a screenshot — so it can look at what it built
  instead of only reasoning about the source it wrote. Everything a page says
  reaches the model marked as untrusted, and a remote address needs your
  approval before it loads.
- What an open preview writes to its console, page errors included, now appears
  in the session transcript, rate-limited with an honest count of what was
  dropped.
- A file that resolves outside the locations a session may read can now be
  previewed once you allow it. The permission covers that one file in that one
  tab, is forgotten when the tab closes, and widens nothing else about what may
  be previewed. On macOS `/tmp` also counts as an allowed location now: models
  write there constantly, and it is not the directory macOS reports as the
  system temporary one.
- The list of subagent profiles offered to the model now states the engine and
  the model each profile runs on. Without that, a profile pinned to Codex or to
  a particular model looked like every other one, and the model had no reason
  to prefer it for the work it was written for.
- A builtin skill for writing subagent profiles, so the model can create one in
  `.anycode/agents` and use it on the next turn.

### Changed

- The Claude Code engine is now told that it runs inside a desktop application
  and not a terminal: that its answer is rendered as markdown, that control
  codes do nothing, that you cannot see raw tool output, and that its own CLI's
  subagents, skills and slash commands are not AnyCode's. It used to write "see
  the output above" about output nobody could see.
- A subagent profile that names an engine and also lists tools is now refused
  when it is read, and says why. The toolset of a child running on another CLI
  belongs to that CLI, so the two lines together never had a meaning.

### Fixed

- The turn count of a subagent running on Codex was not the number it looked
  like. Codex reports one start per run rather than one per model round, so the
  count stayed at one however much work the child did, while the same label
  next to a Claude child meant model rounds. Codex children now show no turn
  count instead of one that reads like the other engine's and is not.

## [0.0.8] — 2026-07-31

### Added

- Subagents can run on a different agent than the session itself. A profile in
  `.anycode/agents/*.md` may declare `engine: codex` or `engine: claude`, and
  its children then run as real Codex or Claude Code CLI processes instead of
  inside AnyCode's own loop. A model override alone could never do this: it
  reused the parent's transport and key, so the executor was always the
  parent's provider. Permissions for such a child are enforced by that CLI
  rather than by AnyCode — a one-shot run has no channel to ask you anything —
  so the narrowest non-interactive mode that still allows work in the project
  is used, not a full bypass. A profile naming an engine that is unavailable
  fails loudly instead of quietly falling back to the parent's model.
- A subagent profile can pin the model its children run on, through `model:`
  in the frontmatter; an absent or empty line inherits the session's model.
  The override changes the model id only, so it stays within the parent's
  provider.
- The subagent editor now offers engine and model as lists. The model was
  free text with nothing to pick from, and a typo travelled all the way to the
  host as a model id that does not exist.
- A profile created while a session is running can be used without restarting
  it. The set of available agent types used to be fixed when the session
  started, so a newly written profile answered "Unknown agent_type" until a
  restart.
- The composer of the start screen now carries reasoning effort and image
  attachments, which previously could only be set after the first message had
  been sent.
- Plan mode can be left from the desktop app. The model proposes the plan, you
  approve it in a dialog, and the session switches to build. The machinery
  existed but only the CLI used it; in the app the only way out was changing
  the mode by hand.

### Changed

- Actions on a file the model produced are now judged one by one instead of by
  a single rule. Reveal in Finder is no longer restricted; Open outside the
  workspace, `~/.anycode` and the system temp directory asks for confirmation
  first; reading a file's bytes into the window stays strictly confined, as
  before. Models routinely write to `/tmp`, which on macOS is not the system
  temp directory, so the old blanket refusal made those buttons look broken.

### Fixed

- Editing a subagent through Settings → Subagents silently erased its `model:`
  line. The profile then ran on the session's model without saying so.
- A subagent running on another engine could work in the wrong directory: the
  only thing it knew about its working directory was whatever path the parent
  happened to mention in the text of the task. The real directory is now
  stated to it explicitly and outranks the task text.
- Reveal in folder explains a refusal instead of doing nothing at all.
- Onboarding no longer locks you into the connection you created first. The
  provider of an existing connection cannot be changed by design, so a single
  unlucky first choice left no way forward from inside the app; the welcome
  screen now lets you add another connection and switch between them.
- A provider whose API has no model listing is no longer reported as a broken
  connection. Moonshot's Anthropic-compatible endpoint answers 404 to
  `GET /v1/models` while messages work fine, and that case is now named for
  what it is.

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
