# Changelog

All notable AnyCode changes are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

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
