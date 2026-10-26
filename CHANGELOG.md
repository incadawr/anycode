# Changelog

All notable AnyCode changes are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- OpenAI-compatible servers that don't report prompt caching (e.g. LM Studio) no longer show "Latest cache hit: 0%" — the popover now says "not reported by provider", while providers that do send `cached_tokens` (including a real 0) keep showing actual numbers (GitHub #11).

## [0.0.43] — 2026-10-26

### Fixed

- The markdown preview renders documents the way GitHub does: a line break inside a paragraph is a soft wrap, not a hard break, and paragraphs, lists and headings get vertical spacing instead of running together. The same spacing fix applies to assistant messages in the chat.

## [0.0.42] — 2026-10-25

### Fixed

- `pnpm test` no longer depends on the developer's own `~/.anycode/config.json`: the core CLI e2e suite now runs every `runCli` drive against an isolated home, so user-scope LSP servers (or any other user config) can't leak into the results (Taskana 4850).
- With language servers configured, the system prompt now says so in one line — which extensions are covered and that their diagnostics arrive attached to Edit/Write results (with a note that intermediate diagnostics during a multi-file change are expected), so the model no longer answers "no LSP tools" and proposes manual `tsc` runs.
- LSP status panel: a configured server whose binary is missing shows "Not installed" with the catalog's install command instead of a misleading "Not started"/"Crashed" (detection is the Settings pane's existence-only check; nothing is spawned).
- A markdown preview in the right-side dock fills the panel again; it had collapsed to a thin strip (most visible in Source mode).

## [0.0.41] — 2026-10-25

### Added

- Sessions API: `create_session` — an external agent can open a new tab in a project where the sidebar ⋯ switch "Allow agents to open tasks here" is on (off by default, trusted folders only, at most 5 per minute and 8 alive). New tabs are shared immediately and marked "agent". `send_message` schema errors now name the expected fields; `get_session_status` and `get_session_result` now agree on `state`.
- Sessions API: `cancel_turn`, `list_pending_approvals`, `answer_approval` and a per-session External approvals switch (off by default).
- Telegram example: `/stop` and inline Allow/Deny buttons for approvals (needs the session's External approvals switch).
- Claude and Codex tabs get the browser tools (BrowserOpen/Read/Screenshot/Navigate/Snapshot/Click/Type/WaitFor/Console/Eval) through AnyCode's tool bridge, with the same approvals, domain policy and Full browser access switch.

### Changed

- Settings: the side menu is grouped into five sections (General, Models & providers, Agent, Tools & integrations, System); pane ids, deep links (`openSettings(pane)`), search and keyboard navigation are unchanged.
- A transient network outage no longer fails the turn at once: the turn waits in "Waiting for network… · Retry now" (probing the provider every 5 s, backing off to 60 s, and re-probing at once when the OS reports the network back or after sleep) for up to 30 minutes (Settings → Wait for network, `ANYCODE_NETWORK_WAIT_MAX_MS`), and then resumes the same step; Stop still cancels at once. Retry delays show as `0.8 s` instead of `791.1655ms`, and an unreachable-network error (`ENETUNREACH`) counts as transient.
- Settings → Language servers: each catalog server has one Turn on / Turn off button that follows the scope dropdown (User = all projects, a folder = that project) instead of separate "this project" and "all projects" buttons.
- The release self-check now opens every Settings pane in the packaged app and fails if one blanks the window, shows its error fallback or leaves a modal over the window.
- Settings → MCP, Language servers, Skills and Subagents: one scope dropdown (`User · This computer` or a recent folder, with a count chip) replaces the Global/Project switcher. Folders come from your recent sessions and open tabs; folders without an open tab can be edited, and a folder that no longer exists is shown disabled.
- The empty Timeline side panel is gone: the conversation now has a slim
  tick rail on the left edge — one tick per message (from two messages on),
  the current position highlighted — with a hover preview of the query,
  click-to-scroll to that message, and a "Rewind to before this message"
  action wherever a checkpoint exists for that turn.

### Fixed

- A background (detached) child that needs an approval now notifies its parent with the tool and path (commands shown with credentials redacted, and the notice states the answer deadline and is withdrawn once the request settles); an expired approval tells the child not to redo the action through another tool such as a Bash redirect.
- Detached subagents: the parent now gets a notice when a child is about to hit its effective turn budget — the request's own `maxTurns`, else the limit the child host resolved for it (core children only; codex enforces no turn cap and never warns) — with the child's session id, so it can be told to wrap up via `send_to`/`continue_session`. Claude children count model rounds (assistant messages), not host turns, so a long in-turn tool loop still approaches the warning. A turn-limited child's report leads with an explicit "stopped at its TURN LIMIT after N turns" cause (N is the CLI's own model-round count) instead of a bare `failed`. The 10-minute stall notice no longer fires on children that are streaming a long reply or dispatching/running one long tool call — those now count as activity (a running tool call re-reports every 60 s); only a genuinely quiet child still trips it.
- Browser tools in engine tabs: results are clamped to the same byte budget as native tabs (BrowserRead on a big page no longer sends ~200 KB to the model), a resumed Codex session gets the browser tools back instead of silently losing them, the tool schemas declare the same one-of/required constraints the host enforces (no wasted round-trip on e.g. `browser_wait_for{gone:true}`), and in a Codex tab with a text-only model `BrowserScreenshot` is refused like in native tabs instead of attaching an unusable image.
- Sessions API `create_session`: refused attempts no longer consume the 5-per-minute budget (only successful creations count), concurrent calls at the 8-alive cap are serialised so they cannot both open a tab, and a `firstMessage` whose new tab ends up outside the folders list is refused with `not_allowed` (naming the tab ids) instead of silently omitting `messageId`.
- Browser preview: a click or type on a preview that is not painting now fails within seconds with "the preview is not visible; open it in the pane or window and retry" instead of hanging in Running. The pane re-applies its bounds once a page has loaded. The popped-out preview window is titled with the page title (or host) and has "Return to AnyCode" (right-click menu, Cmd/Ctrl+Shift+D, menu bar on Windows/Linux) that puts the preview back into the pane.
- A background subagent you stop from the UI is reported to the parent as stopped by the user (`<cancelled-by>user</cancelled-by>`), so the parent no longer relaunches it as a failure. The report card reads "stopped by you" and the Agent card shows "Cancelled" instead of "Done".
- A new session can be started in Orchestrate mode from the start screen: the mode menu lists an Orchestrate row for AnyCode, and `/orchestrate <task>` in the first-message box starts one (the first-run role picker opens when no roles are set yet).
- Telegram example: stopping the bridge waits for a state write already in flight, so a shutdown no longer makes the process exit with an error, and concurrent state saves queue instead of colliding on the temp file.
- Network wait follow-ups: the connectivity probe now goes through the configured proxy (a proxied connection no longer reports "online" while the model endpoint is unreachable), the first probe fires at once instead of after the 5 s tick, a recovered wait resumes immediately and reads "network back after N s" instead of showing the wait as a pending retry delay, the "Waiting for network…" banner no longer disappears while a second parked stream (e.g. an inline subagent) is still waiting or lingers over "Host process exited" after the host dies.

## [0.0.40] — 2026-10-25

### Fixed

- Settings → Roles no longer locks the whole window: the role editor sits in the page instead of opening as a modal that could not be closed.
- The transcript minimap (the dot rail on the right of the chat) shows the hover preview of each message again; it was clipped by the rail itself.

## [0.0.39] — 2026-10-25

### Added

- Native agents can read the browser console and run JavaScript in the built-in preview (always asks).
- A per-session "Full browser access" switch lets the agent use any website in the preview without asking; off by default, with a default setting in Settings → Permissions.
- Plugins can declare background services (`services` in the manifest): AnyCode
  runs them after you consent to their exact command, supervises restarts, shows
  their state and a plain-text log in Settings → Plugins, and stops them when the
  plugin is disabled or the app quits. Project-folder services wait for the
  folder to be trusted. See the *Services* section of `docs/user/plugins.md`.
- Plugin services can read secrets from Settings → MCP → Secrets with
  `${secret:NAME}` in their `env`. A service whose secret is not set does not
  start and shows the missing name.
- Telegram remote-control example plugin (`examples/telegram-remote`): reach your
  shared sessions from a private Telegram chat. Only an allowlisted user reaches
  a session; tokens are never sent or logged. See `docs/user/remote-control.md`.
- Settings → Sessions API: enable the local MCP for external agents without
  environment variables, choose allowed folders, share sessions one tab at a
  time, copy the Claude Code / Codex config, and regenerate the token. The
  setup skill can walk through it. See `docs/user/sessions-api.md`.
- Tools started by a session (Bash, hooks, the terminal, and the Claude and
  Codex engines) now see `ANYCODE_SESSION_ID`, the same id the Sessions API
  reports, and `ANYCODE_SESSION_WORKSPACE`. Connected MCP servers' `instructions`
  are added to the system prompt, labelled and capped, and only for trusted
  folders. MCP `env` and `headers` accept `${secret:NAME}`, backed by write-only
  secrets in Settings → MCP → Secrets, so a Dock-launched app needs no shell setup.

- Native agents can now operate the built-in preview: navigate, read an accessibility snapshot, click, type and wait; remote origins ask first.
- Sessions API: give a shared session a handle (for example `build-bot`) in the
  session's environment menu. Handles are unique among open sessions, persist
  across restarts, and appear in `list_sessions`.
- Sessions API: `wait_for_result` long-polls until the turn that took a message
  finishes, and returns its answer, `pending`, `rejected` or `unknown`.
- `examples/channel-echo`: a dependency-free example plugin service that turns
  files in an inbox folder into messages for a handle and writes the answers to an
  outbox folder. The author guide is `docs/development/channel-plugins.md`.

### Changed

- Settings → Sessions API is laid out as one short flow: an on/off switch with its status, three steps to connect an agent, and the folder, port, default-sharing and token controls under Advanced.

### Fixed

- Opening Settings → Language servers no longer blanks the whole window; a pane that fails to render now shows an inline error instead of taking down the app.

## [0.0.38] — 2026-10-25

### Added

- Settings → Language servers: a catalog of known language servers with
  Found / Not installed detection (existence check only — nothing is
  installed or executed), a copyable install hint, one-click enable per
  project or for all projects, custom server entries, and the active tab's
  live server status. The Environment menu's "Set up" now opens this pane.
  Changes apply to new sessions; project entries start only after you trust
  the folder. See `docs/user/lsp.md`.

- Settings → Permissions now lists remembered trusted/denied project folders
  with a "Forget" button — forgetting a folder asks again the next time a tab
  opens it. Symlinked and real paths of a folder now share one trust entry,
  and older entries are migrated automatically.

- Orchestrate UI: the permission-mode menu has an Orchestrate row (a tab-level
  toggle, not a sixth mode), and `/orchestrate <task>` submits a task under
  orchestrate. The first run without configured roles opens a role picker with
  presets built from your ready engines and connections ("Claude leads, Codex
  builds", "All Claude", "This connection"); you can edit them or skip. The same
  editor lives in Settings → Roles (`/roles`), with the parallel-children cap.
- Plugin store and Settings → Plugins (`/plugins`): install plugins from the
  signed official channel, an https URL, a file or a folder. Each install shows
  a preview listing the MCP servers the plugin would start, then asks you to
  confirm. Plugins can be enabled, pinned, rolled back or removed, and get
  update checks. Official index signatures, archive hashes and safe extraction
  are verified before anything lands. Until the production signing key exists,
  the official channel shows "not configured". See `docs/user/plugins.md`.
- Plugin manifest v1 groundwork (Taskana 4732, stage 1 core): plugins can
  declare `displayName`, `publisher`, `author`, `homepage`, `license`, an
  `engines.anycode` compatibility range (a plugin needing a newer AnyCode
  stays installed but inactive, with the reason visible), and a `workflows`
  contribution — plugin workflow presets now sit between your own workflows
  and the bundled ones. A managed plugin store (`state.json` under
  `~/.anycode/plugins`) is discovered alongside hand-dropped plugin folders
  with a tier order (project > official > third-party > local > legacy), and
  plugin-declared MCP servers start only after you approve them, keyed by a
  hash of the servers so any command change needs fresh approval. Existing
  hand-dropped plugins and older manifests keep working unchanged; a boot
  with no plugins is byte-identical.
- Publishing a release now announces it in the Telegram channel — version,
  release notes, and link — when the repo secrets `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID` are configured; otherwise the announcement step is
  skipped without failing the release.
- The permission classifier (default off) can now use a model from your
  connections (`permissions.classifier` with `kind:"model"`), extends to
  inline subagents (which classify against your recent messages, never the
  agent's own prompts), and covers Codex/Claude session approval prompts.

### Changed

- Connection drawer: Provider, Label, credentials and Model stay on top; Transport, Max output tokens, Context window, Image input and Proxy move under a collapsed "Advanced" section that opens by itself when a value is set; catalog values show as placeholders, Max output is one Default/8K/16K/32K/Custom control, and long helper text moved into "?" tooltips.

### Fixed

- The app window no longer starts blank: a startup module the window depends
  on failed to load in the v0.0.37 build, which was never published.

- Switching conversation tabs no longer flashes the previous tab's side-panel
  tabs (previews/subagents/git) in the dock for one frame — the dock's tab
  set is now owned by the active conversation tab and re-derived on switch.
- The "provider reported" model note on a subagent card now appears as soon as
  the first response arrives, not only after the run ends, so a mismatched
  model is visible during a long run.
- Workflow steps that use an engine role (claude/codex) now follow the role's
  fallback chain like Agent calls do: a cooling primary hands the step to the
  next healthy entry, or to the parent's model, with a visible notice. Engine
  roles in orchestrate mode also run in the background by default.
- Settings → Language servers no longer reports a server as found when it exists only in the project's node_modules (it would not start), and editing a custom server keeps its hand-written initializationOptions.

### Security

- Plugins: an MCP server a plugin brings stays off until you allow it (also
  when settings are missing), and a changed server asks again; a URL install
  installs exactly the bytes that were checked; plugin skills and agents can no
  longer take the names of built-in ones; plugin index rollback is refused
  across restarts.

- The permission classifier's human context is now strictly human: a child
  session's inputs (the parent agent's spawn prompt and its follow-ups) are
  never treated as your instructions when classifying an ask — an engine child
  classifies with no human context and stays fail-closed, and download-and-run
  pipes (`curl … | node`, `| python`, `| perl`, `| ruby`, `| env`, `| deno`,
  `| bun`) are never auto-decided. Codex command approvals now reach the
  classifier (normalized to the same Bash-shaped check; approvals for input to
  an already-running command are never classified), the classifier stays off
  when an unattended run would fast-deny anyway, and a classifier record that
  pins a connection the session is not running on turns the classifier off
  with a visible notice instead of silently using the session's own
  connection.
- A project folder's own process declarations no longer start on open: project
  MCP servers, hooks, LSP servers and project-plugin MCP servers wait until you
  trust the folder. The desktop app shows a dialog listing the commands (Trust,
  Trust once, Don't trust); the CLI asks at startup. Non-interactive runs skip
  them with a warning; `ANYCODE_TRUST_WORKSPACE=1` trusts one run only. Your
  user-level config is unaffected. This is a behaviour change for existing
  projects: each one asks once, and asks again if its commands change.
- Untrusted folders also keep Claude Code's own project settings and project
  web-search/telemetry settings off: the Claude engine boots with user-only
  setting sources (its `.claude/settings.json`/`.claude/settings.local.json`
  hooks and MCP servers are neither loaded nor able to start), the project
  `webSearch`/`telemetry`/`repoMap` sections wait for trust like MCP/hooks do,
  and `.claude` hook/MCP declarations now appear in the trust dialog so a
  hooks-only folder asks instead of opening silently.

## [0.0.36] — 2026-10-25

### Added

- Built-in `planner`, `executor` and `reviewer` roles for orchestration, each
  with its own turn budget. A same-named profile in `.anycode/agents/` replaces
  the built-in role, and a role claimed by such a profile ignores the `roles`
  settings.
- Orchestrate mode (`/orchestrate <task>`): the tab plans read-only and hands
  work to background child sessions, whose reports arrive as new turns.
  Children run in the permission mode you had before orchestrate (never plan).
  Leaving plan mode, including an approved plan, turns orchestrate off.
- `roles` settings: per role, an ordered fallback chain of engine, connection,
  model and effort. Infrastructure failures (quota, auth, unreachable, unknown
  model) put an entry on cooldown and the next healthy one is used; when the
  whole chain is down, the child runs on the parent's model with a notice. A
  cap on parallel role children (`roles.maxParallelChildren`, default 4) refuses
  extra spawns instead of queueing them.
- Adaptive turn budget, off by default: turn on `tools.adaptiveTurnBudget` in
  Settings (or `ANYCODE_ADAPTIVE_TURN_BUDGET=1`). Subagents then get extra turns
  while their work makes real progress, and the base subagent budget is learned
  from finished tasks that were accepted (completed, or declared done at the
  limit). Your explicit turn limits still win, and the learned value stays within
  fixed bounds.
- Optional permission classifier, off by default (`permissions.classifier`
  in settings). It is consulted only on a Bash call that would otherwise ask
  you, and it can only turn that ask into allow. Its first form runs an
  external command that gets the command line on stdin. Any failure, timeout
  or unclear answer still asks you, and every decision is journaled.
- User documentation in `docs/user/`: configuration files, engines, subagents,
  skills, MCP servers, permissions, proxy, orchestration and troubleshooting. The
  app ships a copy, and `docs/user/README.md` indexes it.
- Built-in `anycode-setup` skill for Native tabs: the model reads your AnyCode
  settings and config, explains which one applies, and proposes the fix. It
  changes nothing without your approval and never prints secrets. It is not
  listed in Settings → Skills; to turn it off, add `anycode-setup` to
  `skills.disabled`, or let a same-name project or user skill replace it.
- While AnyCode's own engine is running a turn, a message you send is delivered
  into that turn between its steps instead of waiting for the next turn. It shows
  as a pending bubble and becomes an ordinary message in the transcript once the
  turn takes it. Messages with images, and turns on the Claude and Codex engines,
  still wait in the queue as before.
- A steer that cannot reach the running turn (you press Stop, the turn ends
  first, or the host refuses it) is moved into the prompt queue for the next turn
  instead of being lost.
- When a turn stops at its turn limit, the transcript offers a Continue button
  that resumes the same task, and a held prompt queue says why it is held (turn
  limit, cancelled, error, or refused) instead of a generic pause.
- Models fetched live from a connection (for example OpenRouter) keep the
  reasoning-effort levels the provider declares, so a reasoning model that is
  not in AnyCode's built-in catalog now gets an effort picker and the effort is
  sent with requests.
- The connection drawer lets you set, per model, whether it accepts images
  (Auto, On or Off). Live model lists from providers that declare input
  modalities fill this in automatically.
- For HTTP providers that report their subscription quota in response headers,
  the connection card shows the remaining quota (and its reset time, when the
  provider reports one), and AnyCode remembers the last value for each
  connection.

### Changed

- Side panels (Markdown and web previews, subagents, Review) share one
  right-hand dock with tabs instead of stacking separate columns, so opening a
  second panel no longer squashes the conversation. The dock has one resizable
  width, keeps the conversation at least 420px wide, and becomes an overlay
  drawer on narrow windows. On wide windows a non-active tab can be split into
  a second pane (not the active tab, and not a web preview). `⌘\` hides and
  shows the dock; `⌘W` closes the active tab. Tab buttons are keyboard
  reachable.
- Language-server and hooks status moved from the header buttons into the
  Environment menu. Each row shows its state with a Details action; a crashed
  language server also gets a Restart action that respawns it.
- Provider requests are retried harder: up to 8 attempts, network outages are
  ridden out for up to 5 minutes, and a stream cut off mid-answer is replayed
  (at most twice) instead of failing the turn. Stop cancels retries at once;
  sign-in errors and exhausted quotas are still not retried.

- The optional `tgrep` Grep backend is stricter: a tgrep answer cut off by the
  output cap is re-run through ripgrep instead of being returned trimmed, tgrep
  gets half the tool timeout so the ripgrep re-check fits in the same budget, and
  a tgrep binary whose searches keep timing out is switched off for the rest of
  the session. The `settings.tools.grepBackend` setting applies to the desktop
  app only; the CLI reads just `ANYCODE_GREP_BACKEND`.

### Fixed

- `Agent(send_to)`, added in 0.0.35, now actually reaches the running child in
  the desktop app (every call failed with "unavailable in this host"), and a
  cancelled turn stops waiting for the delivery at once.
- Switching the engine twice in a row without a message in between keeps the
  conversation: the next engine receives the full imported history, and a
  reload no longer shows an empty transcript. The switch notice now appears in
  the transcript, and a reload after a switch no longer repeats the turns from
  before it.
- A role whose primary model is an engine (Claude or Codex) and whose whole
  route is cooling down no longer runs its session on that dead engine and
  model: it runs on the parent's model, with a notice that names every skipped
  entry and its reason. When only the primary is cooling, the session takes the
  next healthy entry and says so.

### Security

- A proxy URL that contains credentials (and the internal engine proxy
  carriers) is no longer passed to the agent's shell commands, the terminal,
  language servers or `inheritEnv` MCP servers; a credential-less proxy still
  is. Behind an authenticating proxy those tools no longer connect directly:
  a small loopback relay is started on `127.0.0.1` and the children receive
  its credential-free URL instead, so npm/git/curl keep working while the
  password stays out of every child's environment, whichever side exported
  the credential. The Claude/Codex engine tabs and their doctors get the same
  relay URL. A credentialed legacy proxy URL is moved into a proxy profile
  with the password in the vault.

## [0.0.35] — 2026-10-24

### Added
- The built-in `explore` recon subagent can run on a cheaper model: set
  `ANYCODE_EXPLORE_MODEL` (exact model id) and every inline explore child
  defaults to it. An explicit `Agent(model: …)` still wins, and unset keeps
  inheriting the parent's model. If the active connection rejects the
  configured id (unknown, disallowed, or after switching the session to another
  provider), the child falls back to the parent's model and its report carries a
  one-line notice instead of every explore call failing. An explicit disallowed
  `Agent(model: …)` still errors.
- Claude tabs can delegate to AnyCode agent profiles, as Codex tabs already do:
  live subagent cards, background agents (detach) that report back as a new
  turn, and follow-ups (`continue_session`).
- Optional trigram-index backend for the Grep tool: set
  `ANYCODE_GREP_BACKEND=tgrep` (or `settings.tools.grepBackend: "tgrep"`; the
  env var wins, default `rg`) to route Grep through a `tgrep` binary found on
  PATH (`ANYCODE_TGREP_BIN` sets its location). Any failure (missing binary,
  refused daemon, error exit, timeout) silently falls back to ripgrep and then
  the JS path, never to a trimmed result. A zero-match answer is re-checked with
  a fresh ripgrep scan, so a stale index cannot hide a file the agent just wrote.
  `--no-max-filesize` lifts tgrep's 64 MiB cap. AnyCode never starts, stops or
  indexes for tgrep; running `tgrep serve` is up to the user.
- New optional ArchMap tool: scans a TypeScript/JavaScript tree and returns its
  import graph (modules with line counts, import edges with type-only and dynamic
  flags, external package counts). It is off by default; enable it with
  `ANYCODE_ARCHMAP=1` or `"tools": { "archMap": true }` in
  `~/.anycode/settings.json` (the env var wins; new sessions only).
- Permission prompts for shell commands show a command-specific risk note in
  the desktop app and the CLI, and for Codex exec approvals. Wrappers, shells
  and absolute paths always get the full note.
- The CLI has an opt-in `--tui` mode: an interactive terminal composer with
  prompt history and slash-command autocomplete. It needs a terminal and is
  ignored with `--print`.
- Per-step provider usage (input, output and cache tokens) is kept in a
  persistent audit, so it survives an app restart.
- Long conversations get a transcript minimap: a scrubber over your turns, with
  a hover preview of the question, answer and touched files for each turn.
- Images in the transcript show live thumbnails. Clicking one opens an image
  viewer in a modal dialog.
- A `deep-research` workflow example ships in `examples/workflows`.
- The desktop app has a background-task panel for the engine's background
  tasks. Output appears under each task, and the panel stays live while the
  session is idle.
- Claude tabs accept `/compact`, which compacts the conversation on demand.
  Only root tabs can use it, not subagents.
- Artifact previews can stay on top of other windows and reload when the
  previewed file changes, including after atomic saves. The live-reload setting
  is remembered.
- `Agent(send_to)` delivers a follow-up to a running child agent that the current
  session started. A child that is still starting or cancelling refuses it.
- A supervising agent whose detached children have all finished, and whose last
  message has no closing marker, gets an idle reminder from the host instead of
  waiting forever.
- The model is reminded to update a stale todo plan, and the todo panel marks a
  plan that may be out of date.
- Agent profiles can pick their own connection with `connection:` (exact id) or
  `provider:` in frontmatter; the child starts on it. A missing or unavailable
  connection is a spawn error with no silent fallback to the parent's
  connection, and combining either key with `engine:` (or with each other) is
  rejected when the profile is parsed.
- The permission modal proposes a trusted project-runner rule for
  `cd <workspace> && pnpm test|typecheck|build|lint`; only that exact compound
  form is auto-allowed, everything else still asks.
- The number of subagents running at once is configurable; the rest wait in an
  honest "Queued" state on their card and start as soon as a slot frees up.
- A connection's context window can be set per model in the connection drawer
  for models the catalog does not know; it applies only to that model.
- Codex Agent/collab calls appear as subagent cards, and image view, sleep,
  image generation, other collab actions and unrecognized Codex items get
  generic cards instead of being dropped; Codex subagent counters no longer show
  zero tool calls.

### Changed

- A Claude Code tab's agent bridge re-reads profile files before each
  `mcp__anycode__agent` call, so an edited profile body or model applies from the
  next spawn, as it already did for Codex supervisors. Profile names stay fixed
  for the session on both engines.
- A root Claude tab no longer starts Claude Code with its slash commands
  disabled, so a message that starts with `/` is handled by Claude Code itself.
  Subagent sessions keep slash commands disabled.
- A subagent's turn budget extends while it makes progress, such as successful
  Agent or workflow dispatches. A rejected round is no longer reported as
  stalled, and a refusal from the user is reported as a refusal.
- Codex sub-agents whose mode allows workspace edits (edit, auto, yolo), or
  whose edits an always-allow Edit/Write rule covers, apply file changes inside
  the session workspace without asking, as Claude and core sub-agents already
  do. Deletes, renames, and any path outside the workspace still ask.
- Kimi appears once in the provider list as one brand card, with a subscription
  or API mode selector, instead of as two cards.
- Telemetry files are pruned automatically: files older than 180 days, beyond
  20,000 files or beyond 64 MiB are removed, oldest first. Files of open
  sessions and files changed in the last 24 hours are never removed.
- A model the catalog does not know now assumes an 8,192-token context window
  (it previously inherited a 200,000-token default); set the real value in the
  connection drawer. A known model still uses its catalog window. While the
  window is assumed, the context meter shows "≈" and its popover says so.
- Agent profile `effort` aliases and `xhigh` reach Codex and Claude children and
  core subagents.
- The worktree janitor looks at a bounded window of recent sessions (200), while
  worktrees claimed by any live child stay protected.

### Fixed

- Codex that fails with exit 127 when launched from Finder gets a clear verdict
  that names the PATH folders searched, and offers alternate binaries to choose
  from.
- A host restart no longer loses pending reports from detached child agents.
  Root Claude and Codex sessions keep them across restarts.
- On Windows, a Codex sandbox that is not ready now shows a warning instead of
  refusing to start the engine.
- Claude sessions connect the in-band AnyCode MCP server again, and an MCP server
  that fails is shown in the turn.
- A compound Bash command now matches the per-run allow-list when every segment
  of it does.
- A model typed by hand is saved on its connection and shows up in every model
  picker, including when it is entered before the connection exists; fetching
  models merges instead of replacing, and edits to the settings file made
  outside the app are picked up (including ones made during startup).
- A Claude child that dies with a steer queued no longer starts a turn on a dead
  engine; the queued message is rejected and the parent gets the real reason.
- A child that ends with a malformed terminal state no longer hangs its parent.
- Codex starts the model picked on the start screen instead of its default.
- The DeepSeek model list uses the right URL and its catalog is refreshed.
- The provider-switch marker sits at the point of the switch and survives a
  restart.
- Check Connection treats an empty `HTTPS_PROXY` in the shell like the rest of
  the app does.

### Security

- A proxy URL that contains credentials is no longer passed to the agent's shell
  commands, the terminal, language servers or `inheritEnv` MCP servers; a
  credential-less proxy still is. Behind an authenticating proxy those tools reach
  the network through a small loopback relay and receive its credential-free URL,
  so npm, git and curl keep working while the password stays out of every child's
  environment. The Claude and Codex engine tabs and the model connection keep the
  full URL.
- Codex sub-agents in ask mode run untrusted, so their permission requests reach
  AnyCode's permission broker. The mode label now matches that behavior.
- Extra tools requested by a subagent are limited to an allowlist. WebSearch is
  the only one, and only for children that ask for it.
- Always-allow rules no longer authorize writes outside the session workspace.
  Codex file moves and Claude notebook edits also no longer ride a blanket write
  rule.
- Codex sub-agents no longer have `/tmp` or `$TMPDIR` among their writable
  sandbox roots. Each gets a private temp directory.

## [0.0.34] — 2026-10-10

### Added

- Tab and child-session limits are configurable in Settings (20 open tabs by
  default); the header shows the session path and the engine glyph, and the
  workspace path stays on one line.
- A message sent to a running child is shown as queued ("Queued — delivered
  after this turn") and enters the transcript when its turn starts.
- A path in chat becomes a link when it is unique inside the workspace.
- Transcript rows show when they happened: user messages, background-agent
  reports and turn ends carry a time (the date too when not today).
- A stalled subagent says so on its card ("stalled · silent 4m" or "waiting for
  approval") until it shows a sign of life or ends.
- An inline subagent card names the model and engine it inherited from its
  parent, marked "(inherited)".
- The Subagents panel names the workspace it scanned, and an empty project
  scope says where it looked.
- The MCP pane has Add server and Import text buttons, a clear empty state, and
  a search that says when nothing matched; without an open project the form
  defaults to user scope.
- An empty model menu offers an Add connection button that opens Settings →
  Provider.
- Codex command approvals are risk-classified by the Bash classifier and honor
  Bash allow rules.
- A subagent that reaches its turn limit returns a wrap-up report; a failed
  wrap-up is marked instead of passing silently.
- A refused turn-ceiling extension leaves a telemetry record with its reason,
  and the recognizer Probe button writes vision-probe telemetry when telemetry
  is on.

### Changed

- Codex patch releases and versions above the supported range are allowed with
  a visible warning instead of being refused.
- The Codex version manifest refreshes periodically and before any version
  refusal, and a cached ready verdict is re-checked when the binary changes.
- Device-code sign-in offers Open page / Copy link instead of opening the
  browser by itself, in one compact row.
- The start screen says a project is needed to send, and Enter opens the
  picker.
- The sidebar session list shows 50 sessions by default, is ordered by last
  activity and refreshes only when the set of sessions changes.
- A connection tile no longer presents an old health reading as current; a
  stale one reads Unchecked.
- A child session rides out a network outage (up to 180 s of retries) instead
  of dying after about 50 s.

### Fixed

- Upgrading AnyCode also upgrades a previously managed Codex CLI install to
  the manifest-recommended version, so account model catalogs refresh after an
  app update; explicitly chosen external Codex binaries are kept.
- Opening a Codex tab that is not ready says why (signed out, update required,
  not installed, or a refused binary path) instead of always asking to sign in.
- Requests to providers made by the app itself now honor the connection's
  proxy.
- AnyCode MCP servers are forwarded to Claude and Codex engine sessions.
- A profile's turn budget reaches engine session children.
- A turn the Claude CLI starts on its own is absorbed, and your next prompt
  waits for it instead of killing the session.
- Stop during a long Claude CLI command ends as a cancellation with an
  explanation, not a faceless error.
- The Claude engine refreshes the context meter mid-turn, so long child turns
  show it.
- Codex tool items are counted once, including completed-only and snake_case
  shapes.
- Workflow steps with an engine profile run through the session tier instead of
  failing instantly.
- A linked-worktree session also loads project agent profiles from the main
  checkout.
- Subagent end records carry the model, response model and engine on session
  and engine routes.
- A live recognizer fallback picks up key rotation and custom base URL edits.
- A keyless custom connection opens a tab, and readiness agrees with the host.
- A workflow precheck no longer writes an uncapped payload.
- A read-only child history no longer offers onboarding chips that type into
  the parent's composer.
- Continue-session hints name the child session id, and the panel shows one row
  per child.

## [0.0.33] — 2026-10-09

### Changed

- Codex CLI 0.162.x is supported and is now the version AnyCode installs.
- Deleting a task, deleting old tasks and closing a tab with a running turn ask
  for confirmation in AnyCode's own dialog (a red Delete / Close tab button,
  Cancel focused, Esc cancels) instead of the system dialog that froze the
  window.
- The update banner can be closed; it comes back for a newer version or once
  the update is downloaded.
- A subagent's output per turn is capped at 32k tokens, about what its 100 KB
  report can carry, so long reports no longer pay for text that is thrown
  away.
- Background agent rows keep their own tool-call and turn counts after you
  open them, settle on their real outcome, and turn footers show how long the
  turn took, with seconds.

### Fixed

- A subagent whose last turn was cut by the output-token limit is reported as
  truncated, never as a success, including background agents.
- A subagent that reports its work finished on its last allowed turn is no
  longer reported as out of turns.
- A background agent report longer than 16k characters says which file holds
  the full text.
- The tokens of a subagent's final wrap-up call are counted in telemetry.
- One unreadable or oversized newest telemetry file no longer blanks the
  Profile panel: older history is shown with a note about the skipped file.
- The automation API's `/wait` can wait for the `compacting` turn status.

## [0.0.32] — 2026-10-08

### Added

- A Codex supervisor can start an AnyCode subagent in the background
  (`anycode_agent` with `detach: true`): its turn ends immediately and the
  subagent's report starts the supervisor's next turn, so it no longer holds a
  turn open polling while GLM works.
- The supervisor can send defects back to the same subagent
  (`continue_session`): the finished child resumes with its own history and
  gets the follow-up as its next message, instead of a fresh child starting
  over.
- A parent tab shows a strip of its running background agents with Open and
  Stop, and a detached Agent card reads Dispatched/Running instead of looking
  finished.
- An agent profile can pin its children's reasoning effort with an `effort:`
  frontmatter key (`off`, `low`, `medium`, `high`, `max`).
- Telemetry records the provider-reported prompt-cache hits, and the profile
  statistics keep a token-weighted cache hit rate per day and overall.

### Changed

- Codex CLI 0.161.x is supported and is now the version AnyCode installs; a
  request to type into an already running command is labeled as such in the
  approval prompt.
- GLM-5.x sessions budget their context at 300k tokens instead of the
  advertised 1M; past that point quality degrades before compaction would
  start.
- A background agent's report reaches its parent in full up to 16k characters
  (was 2k), so a plan or a review is no longer cut mid-section.

### Fixed

- An unknown key in an agent profile's frontmatter is reported instead of being
  silently ignored.
- An opened background agent's pane counts its own turns and tool calls instead
  of showing zeros.
- With the sidebar collapsed and no tab open, the empty window shows a button
  to bring the sidebar back and names the current shortcut.
- Switching between tabs no longer writes a false "Provider switched" line into
  the transcript.

## [0.0.31] — 2026-10-04

### Added

- Local authenticated MCP tools let external agents inspect open GUI sessions,
  read their progress, send messages and steer a running Codex turn.

### Fixed

- Reconnecting a session restores the current transcript, active child sessions
  and pending permission requests without duplicating events.
- Pending permission requests survive brief reconnects within the five-second
  grace period; decisions apply only to the intended active request.
- Session recovery preserves tool-call history and reports interrupted work
  consistently after a host restart.

## [0.0.30] — 2026-10-04

### Added

- Codex tabs can delegate work to AnyCode agent profiles through the native
  Agent tool, including GLM leads and Flash workers.
- Portable GLM/Flash profiles and a Codex supervisor prompt document how to
  run the orchestration on another project or laptop.

### Fixed

- Stopping Codex waits briefly for late child cancellation metadata before
  closing the turn, so the live Agent card receives its final result.
- Delegated Agent cards retain their child-session target and cancellation
  result after restarting and restoring a Codex session.
- Existing agent profiles are read again for each delegated run, so updated
  instructions and model settings apply to the next child.
- Claude quota reset times show realistic intervals instead of millions of days.
- Compacting an already compacted history prefix skips the redundant model
  request and preserves previous compaction failures.
- Narrow split-pane composers keep their controls on one row; keyboard hints
  remain available through accessible text and hover tooltips.

## [0.0.29] — 2026-10-03

### Changed

- First launch now offers ChatGPT/Codex, Claude Code, and API/local-model
  setup directly. Optional API connection settings are collapsed, and the
  selected model is saved with the connection. Completed setup opens the
  project draft automatically.

### Added

- Codex 0.160.0 is supported and is the default version installed by AnyCode.
- ChatGPT sign-in now has a device-code fallback with a visible code, link and
  cancellation, also available for individual Codex accounts.
- Packaged apps support an isolated `--self-check` for first-run UI and IPC.
- Claude Code tabs can delegate to AnyCode agent profiles through an in-process
  MCP bridge; child sessions use the existing permission and cancellation flow.

### Fixed

- Restoring a session on newer Codex versions no longer duplicates command
  entries or displaces them in the conversation.
- Failed workflow steps preserve their cause in the transcript, saved cards
  and telemetry; unfinished outputs are labelled as partial results.
- Startup failures now distinguish missing credentials, missing models and
  unsupported transports. Engine failures include a safe cause and next step.
- Proxy authentication, a refused proxy socket and untrusted TLS certificates
  stop automatic retries and show how to correct the connection.
- Subagent model overrides unavailable on the selected connection are rejected
  before launch instead of silently reaching the parent's provider.
- Setup now advances when an external engine becomes ready after sign-in.
- Settings and the API-key storage consent dialog are reachable during setup.
- An empty first-run profile no longer initializes OS Keychain just to show
  settings; the storage check occurs when a key is saved.

## [0.0.28] — 2026-09-12

### Fixed

- Codex models newer than the Codex AnyCode was willing to run are no longer
  invisible. The list in the model picker is not AnyCode's own: Codex asks
  OpenAI for it and identifies itself by its version number while asking, so a
  newer Codex is offered models an older one is never told about. Measured on
  one account on 2026-09-11: `GPT-6-Astra` is offered from Codex 0.153.4
  onwards and absent in 0.152.1 and every version before it — and AnyCode
  refused to start anything from 0.152.0 up, so that list was out of reach
  unless you accepted the risk warning for each new version by hand.

  The supported range now ends at 0.155.0. That is a measurement, not a guess:
  the part of the Codex protocol AnyCode actually speaks was regenerated from
  the real 0.152.1, 0.153.4 and 0.154.0 binaries and compared against the
  pinned copy — the calls AnyCode makes and the decisions it reads back came
  out identical, and nothing it consumes was removed.

  What this does not change: AnyCode still installs Codex 0.144.3 for you, the
  one version it has been smoke-tested against end to end. To use a newer
  Codex, install it yourself and point AnyCode at it in Settings → Codex →
  Choose binary… — it now starts without a risk warning, and its model list
  arrives with it.

- A compaction no longer gets two different verdicts on screen at once. The
  toast still said "Compaction failed" while the row in the conversation said
  "Compaction not applied" — about the same event, at the same moment. The
  commonest reason a compaction does not happen is the deliberate one, there
  being nothing worth summarising yet, so neither surface calls it a failure
  now.

## [0.0.27] — 2026-09-07

### Changed

- A compaction now leaves a permanent row in the conversation instead of only
  a status toast. Until now the only sign that AnyCode had summarised the
  history and swapped it in was a notice that the next message overwrote — so
  if you looked away for a moment the whole thing had happened invisibly, and
  the conversation simply looked shorter than you remembered it.

  The row appears where the compaction actually happened and behaves like a
  tool call. It reads `Compacting conversation…` while it runs — or names the
  full context window as the reason, when AnyCode started the compaction by
  itself rather than being asked — and then turns into the result in place:
  `Conversation compacted: 10703 → 509 tokens`. A compaction that is refused or
  fails leaves the reason on screen instead of disappearing with the toast —
  and says "not applied" rather than "failed", because the commonest refusal is
  a deliberate one: there was nothing before the recent messages worth
  summarising. The toast still reports the live state; the row is the record.

  The row is a rendering of what this window saw, so reopening the session does
  not bring it back — a compaction still leaves no mark in the stored history.

## [0.0.26] — 2026-09-05

### Added

- A conversation can now be compacted on demand. AnyCode has always done this
  by itself once the context filled up, but there was no way to ask for it
  first — even when you could see the conversation had wandered away from what
  you are actually doing, or you were about to start something unrelated in the
  same session. `/compact` in the slash menu summarises the history and swaps
  it in, and the context meter drops the moment it finishes rather than waiting
  for your next message to reveal the new number.

  It behaves like a turn of its own: the session shows as busy while it runs,
  so a message you send meanwhile is queued and delivered afterwards instead of
  racing it, and it can be stopped like any other turn.

  The command appears only where it can work. The Codex and Claude engines keep
  their own history and offer nothing to call, and a child session's history
  belongs to the parent that spawned it — in both cases the entry is simply
  absent from the menu, rather than present and doing nothing when pressed.

- Development only: a recorded session can be played back inside AnyCode —
  play, pause, step, seek and speed — over the real transcript rendering rather
  than a stand-in for it. This exists so the product can be filmed without
  driving it by hand. It is reachable only through the development automation
  facade, which a packaged AnyCode never loads, so an installed build has no
  replay surface and behaves exactly as before.

## [0.0.25] — 2026-08-31

### Added

- A subagent that gets stuck repeating itself is now stopped instead of being
  paid for to the end. Models occasionally fall into a loop mid-answer and keep
  emitting the same phrase; until now the run continued until the provider's
  own output ceiling cut it off, and what came back looked like an ordinary
  finished report. In one measured case that was a phrase repeated 341 times
  over twenty-four minutes.

  AnyCode now watches the answer as it streams — the visible text and the
  model's reasoning both — and when it sees the same passage repeating solidly,
  it stops the request itself rather than waiting it out. The delegating side
  is told plainly that the result is incomplete, and a workflow step that ended
  this way no longer counts as done for the steps that depend on it.

  Your own session is left alone: when you are sitting in front of the run, the
  guard reports but never cuts, on the same principle as the turn-budget
  ceiling. What not to expect: it recognises a passage repeating verbatim, so a
  loop that drifts — a counter or a timestamp changing inside each repetition —
  still runs to the end, and very long repeating passages (more than about
  1,400 characters) are outside what it can see.

### Fixed

- AnyCode could install a Codex it then refused to launch. The supported-version
  range shown in Settings, the range the installer gated on, and the check that
  actually decides whether the engine starts were three separate answers, and
  only the last one mattered. "Use it anyway" for a version you had accepted the
  risk on never reached that check at all, so the button did nothing on the
  engine path. All of it now comes from one place — the range Settings shows is
  the range that is applied, and the refusal message names it. Previously this
  had to be patched by hand for each new Codex release; it no longer does.

- A tab stuck on "Connecting to host…" now tells you why. When AnyCode's host
  process fails to start, the reason was already written down — but it was only
  sent once you typed something, so finding out why the connection failed
  required pretending it had succeeded. The failure is now reported the moment
  the tab attaches.

## [0.0.24] — 2026-08-31

### Added

- A model that cannot see images can now look at one anyway. Point AnyCode at
  a second model that can see — Settings → Vision — and when the model you are
  talking to needs to know what is in a screenshot or an attached picture, it
  asks that one and gets the answer back in words. The recognizer runs on its
  own connection, so the model you work with and the model that looks at your
  images need not come from the same provider.

  The panel has a Probe button that sends a test image down the exact path a
  real run uses and shows you what came back, so "is my recognizer still
  working?" is one click rather than a guess. Probe stays available even when
  settings.json is read-only, because it writes nothing. It is a real request
  and is billed like any other — and it does not yet appear in the Profile
  panel's usage figures, so trying ten models with it costs ten calls you
  cannot see there.

  What not to expect: the recognizer answers one question about one image and
  remembers nothing between questions — it is a lookup, not a second
  conversation. It needs a connection that authenticates with an API key;
  OAuth connections cannot be used for it. And turning it on does not make a
  blind model see: the model is shown a numbered placeholder and has to ask.

- A workflow run is no longer a black box. The card for a Workflow call now
  holds every step of the run — all of them, from the moment the run starts,
  not just the ones that have already begun — ordered by what depends on what
  rather than by the order they happen to be declared in. Each step reports
  its own phase, and the two phases that used to look identical no longer do:
  a step waiting for a free slot reads as queued, a step that has not started
  reads as not started, and a step that will never start because the run
  already failed reads as skipped.

  Under the steps runs one activity lane for the whole run, carrying the tool
  calls of every step in the order they actually happened — one lane rather
  than one per step, because in a run with several steps going at once the
  thing worth seeing is the chronology between them. Click a step to filter
  the lane to that step alone; click it again to get everything back. When the
  lane has dropped older rows to stay bounded, it says how many rather than
  pretending it holds the whole history.

  Below the list the run's shape is drawn, open by default: a box per step, a
  line per dependency, laid out in columns by dependency depth. Colour and
  outline come from the same vocabulary as the list, so a failed step and
  everything it blocked read together at a glance; fold it away if you would
  rather just have the list. Collapsed, the card carries a strip of
  ticks instead — one per step, same order, same colours — and does not grow
  by a single pixel to do it.

  Token spend is reported per step and for the whole run, cache reads
  included, because a cache hit is the difference between a run that cost
  something and one that barely did. The whole card survives a restart: close
  the session, open it again, and the steps, their spend, their outcomes and
  the activity lane come back as they were.

  What not to expect. A step whose profile names an engine (`claude` or
  `codex`) cannot start at all — the workflow engine still calls subagents
  directly and is not wired to the tier that runs engine children — so such a
  step fails instantly, and the card will show that failure without being able
  to explain it. That is not new in this release, but the card now makes it
  visible. Relatedly, when a step fails, the reason is dropped before it ever
  reaches the card, so the failure shows as an outcome and a duration and
  nothing more; the step panel is honest about having no rows rather than
  inventing any.

### Changed

- Images in a conversation are numbered. An attachment is `#1`, `#2`, and so
  on, and the number is stable for the life of the session — it comes from a
  counter, not from recounting what is still in the history, so compaction
  dropping an old image can never make a later one reuse its number.

- A screenshot now records the size of the page in CSS pixels alongside its
  size in real pixels. The recognizer is told both and can work out the
  display scale instead of guessing at it — a Retina screenshot is no longer
  read as a page twice as wide as it really is.

- Codex builds up to and including 0.151.x are accepted without a risk
  prompt; the supported ceiling moves from below 0.151.0 to below 0.152.0.
  A real 0.151.0 binary was unpacked and its app-server schema compared
  against the pinned contract: the methods AnyCode calls and the decision
  vocabularies it answers with came back byte-identical, nothing was removed,
  and the three shapes that did change are not read anywhere in AnyCode. The
  version AnyCode installs on your behalf is unchanged — the ceiling says
  which Codex you may bring, not which one is recommended.

### Fixed

- Closing the window with a preview open no longer crashes the app with "A
  JavaScript error occurred in the main process — TypeError: Object has been
  destroyed". Teardown ran inside the window's own close handler and then sent
  a message to that window; the guard in front of the send only covered a
  window that was gone, not one that was already destroyed, which is a
  different thing and the one that actually happens.

- Switching mid-conversation to a model that cannot see images no longer fails
  with an unexplained error from the provider. The images are left out of the
  request and replaced with a note naming which one was omitted, so the model
  can still reason about what it is missing and ask about it.

- Closing a session that runs on the Claude CLI no longer hangs for eight
  seconds when that CLI is already gone — after it crashed on startup, say.
  Shutdown waited for the child process's `close` event, which is emitted
  exactly once; if it had already fired, the listener registered afterwards
  could never receive it, and each stage of the shutdown sequence waited out
  its full timeout for news that would not come. Shutdown now asks the process
  handle whether the child has already exited instead of waiting to be told.

## [0.0.22] — 2026-08-30

### Added

- Screenshots and images can now be attached on GLM-5.3 Flash. The model
  reads them; only the catalog said otherwise, and the composer believed the
  catalog. The plain GLM-5.3 row is unchanged — it is a text model, and
  guessing in that direction would repeat the same mistake backwards.

### Changed

- The Profile panel opens immediately instead of making you wait. It used to
  sit on "Loading profile…" for around sixteen seconds on every open, because
  it re-read the whole telemetry directory before drawing anything at all. It
  now paints its layout at once and fills the numbers from a durable
  aggregate, typically within a fifth of a second. The aggregate rebuilds in
  small chunks in the background, so a cold start no longer freezes the
  window.

- Every settings panel now scrolls at the edge of the window. The scrollbar
  used to be drawn against the right edge of the text column, leaving a wide
  dead strip beside it that swallowed the scroll gesture.

### Fixed

- The Profile panel could report an empty history as if it were a successful
  reading. A telemetry file being written while the panel scanned looked like
  a gap in the record, and because that file is always the newest one,
  everything older than it was dropped from the total. The numbers stay honest
  now, and a genuinely unreadable file says so instead of quietly lowering the
  count.

## [0.0.21] — 2026-08-29

### Changed

- The sidebar no longer draws a project's entire session history. Each project
  group stops after five rows and ends with a "Show N more" line that expands
  it in place; "Show less" folds it back again. A project you have worked in
  for weeks no longer pushes every other project off the screen.

  Three things about the cut are deliberate. Typing in the search box lifts it
  everywhere at once, so a session you can find is a session you can reach —
  and, because a row has to be reachable before it can be deleted, one you can
  still remove. Open tabs are never hidden: the cut moves down past the last of
  them, since those rows carry live status. And a cut that would hide a single
  row is not taken at all, because the toggle costs the same vertical space as
  the row it would hide. The expansion is not remembered between launches — the
  short list is what you get each time you open AnyCode.

## [0.0.20] — 2026-08-29

### Added

- Subagents can now run on the Codex engine. Choosing an agent profile whose
  engine is `codex` previously failed outright with a refusal: a Codex child's
  transcript could not be read at the moment its run finished, so a completed
  child would have shown "done" next to an Open that led to an empty screen.
  AnyCode now reads the child's live transcript from Codex at that moment, so
  the card opens onto what the child actually did. One thing worth knowing
  before you use it: a Codex subagent is governed by Codex's own sandbox, not
  by AnyCode's permission rules — it reads and writes inside the workspace and
  the system temporary directory without asking, and it has no network access.
- A subagent that goes quiet now says so, instead of being noticed only when
  its six-hour wall runs out. AnyCode watches for silence — the time since the
  child last showed a sign of life — rather than for how long the child has
  been running, and the countdown pauses while the child is waiting for you to
  answer a permission prompt, so a child no longer spends its whole budget
  sitting at a dialog nobody saw. The notice is only a notice: nothing is
  cancelled, killed, or interrupted. Background subagents are covered too, and
  repeated notices from one child that keeps going quiet and waking up collapse
  into a single entry instead of filling the queue.

### Changed

- A session you are watching is no longer stopped by the turn limit. That limit
  exists so an unattended session cannot run away; while you are at the screen
  it now steps aside entirely for the top-level session — no decision point, no
  shrinking grant, no stop. Subagents keep the limit in every case, and the
  six-hour wall-clock deadline is unchanged: being present lifts the turn
  count, not the clock.

### Fixed

- A subagent profile's `model:` line was silently ignored for subagents running
  on the Claude or Codex engines — the child booted on the engine's own default
  model instead, with nothing said. The profile's model is now honoured, and a
  model named explicitly in the call still overrides it.

## [0.0.19] — 2026-08-29

### Added

- The dev-only automation harness that drives the desktop app for smoke
  testing can now operate the Profile panel: switching between Today / 7
  days / 30 days / All time, reading and expanding the full model list,
  reading the coverage note, and clicking Refresh. It previously could only
  flip the telemetry toggle, so the panel's biggest feature from the last
  release could only be checked by opening the app and reading the screen by
  eye.

### Changed

- Codex support is now a single ceiling — accepted up to 0.150.x — with no
  floor. AnyCode no longer requires a minimum Codex version by itself; any
  build below the ceiling passes the version check, and the rejection
  message no longer carries its own separately-maintained copy of the range.
  One consequence worth knowing: a very old Codex that used to be turned
  away immediately with an "unsupported version" message is no longer
  stopped at that point. It now fails later, once a session actually starts,
  with a generic transport error instead of a message naming the version
  problem.
- The question "which model did a subagent actually run on" is now answered
  the same way everywhere — the subagent's card, its progress events, and
  its telemetry record all report the model that was requested. The
  provider's own claim about which model it ran (on transports that report
  one) is kept as a separate, clearly labelled value, and — new in this
  release — that value now also reaches telemetry instead of only being
  visible live on the card while the subagent is running.
- `ANYCODE_TELEMETRY_DIR` now only controls where telemetry is written; it
  no longer turns telemetry on by itself. If telemetry was never enabled
  through a config file, setting this variable still leaves it off.

### Fixed

- On an OpenAI-compatible chat-completions server that rejects the
  `stream_options` field used to request usage counts, the request is now
  retried once with that field turned off, the field is then disabled for
  that connection, and a single warning explains what happened. Token
  accounting stays on by default for everyone else, unchanged, and
  `ANYCODE_INCLUDE_USAGE=0` still turns it off by hand.
- The Profile panel's coverage note ("History before … not included") now
  reports the earliest event actually counted in the statistics, instead of
  the modification time of the oldest file it scanned. A session file's
  modification time marks when the session ended, not when it started, so
  the note previously understated how much history was already counted —
  by as much as the length of the oldest included session.
- `glm-5.3-flash` now declares its real output ceiling (131,072 tokens,
  matching `glm-5.3`), so a subagent spawned on that model no longer
  silently drops to the 32,768-token default. More generally: when a model
  has no output ceiling on record in the catalog, that gap is now reported
  — naming the model and the number applied — instead of being applied
  silently.
- Telemetry running under a test runner no longer refuses to write at all
  when no explicit directory is configured; it redirects to a fixed, easy
  to find temp folder instead, and names that path, so a run's data is
  recoverable by hand rather than silently lost.

## [0.0.18] — 2026-08-28

### Added

- The Profile panel can be read by period. Everything below the heatmap now
  answers to Today / 7 days / 30 days / All time, and the model and tool lists
  are complete instead of being cut to the top three and top five. A model
  could previously carry millions of tokens across hundreds of sessions and
  still never appear on the screen, purely because it ranked fourth.
- Sessions running on the Claude or Codex engine write telemetry at all. They
  produced zero records until now, so work done on a foreign engine was absent
  from the Profile panel rather than merely uncounted.
- An inline subagent's tokens and tool calls count toward your totals. The
  panel already reported how many subagents had run while what they cost was
  recorded nowhere, so the number of runs and the price of them disagreed by
  construction.
- "Max output tokens" is an editable field in the connection drawer, with
  click-to-fill presets (Default · 8192 · 16384 · 32768 · Custom), and the
  ceiling for a model the catalog does not know rises from 8,192 to 32,768. A
  reasoning model behind a custom or on-prem endpoint could spend its whole
  output budget thinking and stop before printing a single character.
- A subagent's card names the model the provider's response actually claimed
  to run, and marks it when that differs from the model that was requested.
  Until now the card could only echo the request back at you.

### Changed

- A max-output value above what the model actually supports is clamped to that
  model's real ceiling and says so once, instead of being sent and rejected by
  the provider. The field also shows the number in effect when left empty, and
  an active `ANYCODE_MAX_OUTPUT_TOKENS` override is named on screen instead of
  silently overriding what you typed.
- A subagent started on an explicit model gets that model's own ceiling,
  reasoning levels and context window, rather than inheriting whatever had
  been resolved for its parent's model. Where the catalog declares no output
  ceiling for the child's model, that means the 32,768 default, which can be
  lower than the parent was running with.
- GLM-5.3's reasoning levels are corrected to Low / High / Max — the "Off" it
  used to offer was never supported by the provider — and a Low selection now
  reaches the provider as Low instead of being raised to High. GLM-5.3 Flash
  is selectable.
- Codex is accepted up to 0.150.x. The declared range had fallen five minor
  versions behind the published CLI, so a current Codex met an "unverified
  version" warning on every launch. The new bound is backed by regenerating
  the consumed app-server contract from the real 0.150.1 binary: the methods
  and decision enums AnyCode consumes came back identical to the pin.

### Fixed

- Token counts and cache-hit rate no longer sit at zero on OpenAI-compatible
  chat-completions connections. Usage reporting is requested by default there
  now; a server that refuses the field can be told to stop asking with
  `ANYCODE_INCLUDE_USAGE=0`.
- The Profile panel no longer chooses which sessions to read at random. When
  the history outgrows its read budget it keeps the newest and states the date
  its numbers begin from; before, it truncated in identifier order, so a busy
  working day could show nothing at all.

## [0.0.17] — 2026-08-23

### Fixed

- A quoted flag can no longer smuggle a write past the read-only check. The
  screen that decides a Bash command is safe enough to run without asking
  compared each argument exactly as written, so putting quotes around a flag
  hid it: `git diff "--output" notes.md` read as harmless and was approved
  automatically, and against real git it wrote the named file — `git blame`
  in the same shape truncated an existing one to nothing. The screen now
  reads each argument both as written and with its quotes removed, the way
  the equivalent check for pipelines already did. A command whose quoting
  never closes is no longer assumed harmless either; it asks.
- A session moves to the top of the list when it is used, not only when it is
  renamed. The value that orders the sidebar, labels a session's age and backs
  the session picker is meant to name the last time the session was active,
  but only edits to a session's title, model, mode or worktree ever wrote it —
  talking to a session left it untouched, so a conversation from an hour ago
  could sit below one nobody had opened in days. Writing history now advances
  it, and sessions that already exist are corrected once from the history they
  carry.

## [0.0.16] — 2026-08-23

### Added

- A subagent can be sent to work in the background. A detached child hands the
  turn back the moment it starts instead of holding the conversation still
  until it finishes, so the session carries on and the child's report arrives
  on its own later. If a turn is in flight when the report lands it waits and
  is delivered once that turn settles — nothing is spliced into a turn already
  running; if the session is idle, the report wakes it. The list of running
  background children and the command to cancel one are on the wire already; a
  panel that shows them is a later change.

### Changed

- A subagent is bounded by its turns, not by a ten-minute clock. The old wall
  was 600 seconds of pure elapsed time counted from the moment the child was
  asked for, and it could not tell "the model is thinking" from "we are waiting
  for a person who has not answered a permission prompt yet". A child session
  sitting in front of an unanswered dialog therefore spent its entire budget on
  waiting, and a child doing real work was cut off mid-task at eight minutes.
  The clocks are resized so they can only catch a child that is genuinely hung
  — six hours, the figure already used here for long-running background work —
  and what ends a subagent is now the turn budget, which is visible and
  settable.

### Fixed

- Asking for more session children than the limit allows now queues them
  instead of throwing the work away. Over the cap the spawn was refused outright
  and the delegated task simply vanished, while the in-process tier — on a
  smaller limit — had always just waited its turn. A spawn that cannot start yet
  waits in line and starts the moment a slot frees, and a parent sitting at its
  own limit no longer holds up a different parent that has room.

## [0.0.15] — 2026-08-22

### Added

- A document can be opened from the tool card that created it. A successful
  `Read`/`Write`/`Edit` of an `.html`/`.htm`/`.md`/`.markdown` path now carries
  an `Open` control in its header row, so the one place where the path is known
  exactly is finally a place you can click. Until now the only way into the
  viewer was a markdown link the model happened to write, which gated the
  affordance on markup rather than on the file.
- A path stated in prose or in inline code is now clickable too — "saved it to
  `report.html`" opens like a link, without the model having had to format it
  as one. False positives are cut by existence rather than by guesswork: a path
  becomes a link only after it is confirmed to be a real file inside the same
  allowed roots the viewer already enforces, so a name that is merely mentioned,
  or a file since deleted, stays ordinary text. Nothing is linkified inside a
  code block, inside a link that already exists, or in inline code the path does
  not fill completely.

### Fixed

- `.markdown` is treated exactly like `.md`. The list of viewable extensions had
  been copied by hand into six independent places and `.markdown` was absent
  from every one of them, so a file named `notes.markdown` could not be opened
  through any path at all — not the tool card, not a link, not the automatic
  open at the end of a turn. The six now read from one list.

## [0.0.14] — 2026-08-22

### Added

- A proxy is now a named profile in one registry instead of a string retyped on
  every scope. Settings gained a Network panel where profiles are created and
  edited once; a provider connection and each engine simply point at one. The
  editor plaque exists in exactly one place, and every scope offers a dropdown.
- "Check connection" actually goes through the proxy being tested — the probe
  spawns a child rather than asking the app's own network stack, so what it
  reports is what a session will experience, including eight distinct failure
  shapes taken from live measurement instead of one generic error.
- The Codex and Claude engines can each use their own proxy, separate from any
  provider connection. `codex login`, which main spawns itself, finally
  completes behind a corporate proxy. The ladder is shell > engine >
  connection, with the shell winning as a whole family.
- A running session can be moved to a different provider connection without
  losing it: children are drained, the host is shut down, and the session
  resumes on the new connection.
- Hitting the turn cap is now a decision instead of an ending. The run asks for
  more turns once, and the answer is structural — a single declared tool whose
  arguments are checked byte-for-byte, never parsed prose. Grants shrink each
  round (half the budget, then a quarter, then an eighth) with at most three
  rounds, so an autonomous run can finish a job it underestimated while a
  runaway one still stops. Anything unreadable is a refusal.

### Changed

- Codex versions up to 0.149.x are accepted. The supported range had fallen
  behind the CLI's own releases, so anyone on a current Codex — including a
  plain `npm i -g @openai/codex` — was refused by default and had to click
  through a risk acceptance. The consumed app-server contract was regenerated
  from the real 0.147.0 and 0.149.0 binaries and came back byte-identical in
  every method and decision the adapter speaks. AnyCode still installs 0.144.3
  when it downloads Codex itself, since that is the version with a full live
  smoke behind it.

### Fixed

- A run with nobody at the screen no longer pays the full two-minute permission
  deadline for every tool call. The first unanswered ask marks the session
  unattended and later asks are refused at once, so the wait is bounded by one
  deadline instead of growing with the number of calls — four serial asks used
  to cost eight minutes of dead time. Answering a prompt or typing a message
  brings it back; a window merely reattaching does not.
- The refusal text those calls receive is written for the model that reads it.
  It used to say "permission request timed out", which read as a broken
  environment: in a live run the model retried four spellings of the same
  command and then started debugging its PATH. It now states that the command
  did not fail, that the refusal is not on the merits, and that rephrasing will
  not help.
- Sessions running on the Codex or Claude engines honour always-allow rules.
  Those engines never pass through the core permission layer, so a rule saved
  from a permission prompt could not reach them at all and the same prompt came
  back every time.
- An autonomous run can be given a narrow, per-run list of Bash commands to
  allow (`ANYCODE_RUN_ALLOW_BASH`) — the middle ground between asking for
  everything and the blanket yolo mode. It is a process input, never persisted
  and never shown in Settings, matched by exact token prefix with no globs, and
  refused outright for anything containing shell composition.

## [0.0.13] — 2026-08-18

### Added

- Choosing a model when starting a session no longer means choosing a provider
  first. The chip on the New Session screen opens a drill-down: three quick
  picks ranked from your own recent sessions, then one row per connected
  provider, then that provider's models — and, when the model has thinking
  modes, its effort levels. Previously the screen offered only the active
  connection's models, and reaching anything else meant a trip to Settings.
- The picker states the effort the session will actually start with, on the chip
  itself (`GLM-5.3 · Max`), the way a running session's model pill does. The
  levels offered belong to the model, not to the app: a model with three modes
  shows three, and a model with none shows no effort row at all instead of a
  made-up list.
- The popup no longer grows past the bottom of the window and hands you a
  scrollbar: each level is sized against the room actually available above or
  below the chip.

### Fixed

- GLM-5.3 was running with no thinking at all, silently, even with effort set to
  Max on the connection: the model was not declared as a reasoning model, and
  the stored effort was dropped on the way to the request. It now declares the
  same off/high/max modes as GLM-5.2, and the effort reaches the provider.
- The `k3-256k` model that the Kimi subscription endpoint serves was missing from
  the catalog entirely, so it too had no thinking modes. It now carries K3's.

## [0.0.12] — 2026-08-17

### Added

- A connection can be pointed at an HTTP(S) proxy. Behind a corporate proxy the
  app was simply unusable and there was nothing to configure: an app started
  from the Dock never sees a shell's `https_proxy`. A connection now carries one
  Proxy URL field, and everything that connection starts goes through it — the
  session's own requests as well as the Claude and Codex engines' child
  processes. Local endpoints (LM Studio, ollama, anything on loopback) keep
  going direct, and a proxy already exported by the shell still wins. The field
  accepts the `user:pass@` form authenticated proxies need; it is stored as
  plain text and handed to every process the connection starts, which the field
  says outright.
- Subagents get a turn budget that can actually be raised. The limit was eight
  turns, hard-clamped: a delegated task that needed a tenth step died with no
  way for anyone — the caller, a workflow, or the settings — to give it more.
  The default is now forty, an explicit request is honoured up to a runaway
  ceiling, and Settings → Tools carries the knob.
- Editing inside the workspace stops asking. A write to a path inside the
  directory the session was opened on goes through without a prompt, while
  anything outside it still requires one — and a path that cannot be resolved is
  refused rather than assumed safe.
- Shell commands that provably only read are auto-approved, pipelines included:
  a chain whose every stage is a known read-only command no longer interrupts
  the turn. The grammar is deliberately narrow, and anything it cannot prove
  read-only asks as before.
- The permission mode can be changed while a turn is running, instead of only
  between turns. It takes effect from the next tool call; a prompt already on
  screen is answered under the mode that raised it.
- An engine binary is trusted per path. Pointing the app at a Claude or Codex
  executable now shows a consent card naming the file and the reason, the trust
  is invalidated if that file changes, and it can be revoked in settings. A
  binary you configured explicitly and then refused is no longer silently
  replaced by a different one further down the search order.

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
