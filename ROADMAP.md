# AnyCode — Roadmap & Announcements

> A living board of AnyCode ideas and announcements. It is a **statement of
> direction**, not a delivery schedule: priorities and timing may change, and
> some items may never ship. Concrete tasks and research are kept separately.

AnyCode is an open desktop client for AI coding agents. The goal is not another
agent, but a **single interface over agent runtimes**: choose the engine that
runs a session while the interface stays the same.

---

## 🔌 Harness profiles — interchangeable engines

The **harness profiles** model provides one UI over several backends. A
profile is selected per session; the transcript, confirmation dialogs, and
mode switching are shared across engines.

| Profile | What it is | Status |
|---|---|---|
| **Native** | AnyCode's built-in multi-provider agent loop | available now |
| **Codex** | OpenAI Codex as an engine through its `app-server` protocol | available now |
| **Claude Code** | Claude Code as an engine through its CLI headless stream | available now (Orchestrate mode not yet) |

**Profile principles:**

- **Bring your own agent.** A profile launches an agent CLI that you already
  installed and are entitled to use. AnyCode neither stores nor proxies its
  credentials: the agent process runs under your account on your machine. Each
  backend remains subject to its provider's terms.
- **One UI, interchangeable engine.** The shell consumes an event stream and
  does not depend on which engine produced it, so changing engines does not
  break the visual model.
- **Capabilities depend on the engine.** Each profile exposes what its backend
  supports; inapplicable actions are disabled rather than presented as working.
- **Subagents pick their own engine.** An agent profile can pin the children it
  spawns to a specific agent CLI, independently of what runs the parent session,
  so a task can be delegated to another agent without leaving the workspace.

---

## Shipped recently

- First-run tiles for coding subscriptions: GLM Coding Plan, MiniMax M Plan,
  Kimi (kimi.com) and OpenCode Go, next to ChatGPT / Codex, Claude Code and any
  API key or local model.
- Subscription quota windows on connection cards (GLM Coding Plan, MiniMax
  M Plan, OpenCode Go), Codex plan limits in Settings → Codex, and per-step
  cost estimates.
- Orchestrate mode with role routing, in Native and Codex tabs.
- Sessions API for external agents, plus a Telegram remote-control example
  plugin.
- Plugins: install from URL, file or folder, background services, and model
  catalogs supplied by plugins.
- Language-server diagnostics in Edit/Write results, and a Vision fallback model.
- In-app updates on Windows and Linux.

## 💡 Ideas (incubator)

_Ideas and announcements collect here. Once an idea is ready for work, create a
separate task or research item._

### Extensibility

- **anyPlugin.** _Mostly available now:_ the documented manifest spec,
  two-phase install from file / URL / folder (git ahead), and
  the Settings → Plugins management UI (list / enable / disable / update /
  rollback / pin / diagnose), with MCP-server consent gates at install and
  after any command change. Importing skills and MCP servers from Claude Code,
  Codex and zcode configurations is available now. Still ahead: git install
  sources and more contribution types such as slash commands and hooks. The
  official channel stays disabled until production signing keys ship.
- **MCP, first-class.** _Mostly available now:_ per-server connection status
  and tool counts, enable/disable toggles, and remote (streamable HTTP)
  servers. Still ahead: remote-server OAuth and on-demand tool loading so
  large catalogs don't flood the context window.

### Sessions & workflow

- **Mid-session model and provider switching.** _Available now (model on
  every engine; provider on the native engine)._ Change the model — or the provider behind it —
  between turns of one session, e.g. continue on another subscription when a
  quota runs out. Capability gaps (vision, context-window size) and the
  cache-reset cost are surfaced explicitly, never silent.
- **Harness switching (session transplant).** Move a live session between
  engines at a turn boundary, with the AnyCode transcript as the interchange
  format: lossless import/export where an engine's session format allows it,
  an explicit handoff summary where it doesn't. Tracked in
  [#34](https://github.com/incadawr/anycode/issues/34).
- **Multi-agent orchestration.** _Available now in Native and Codex tabs._
  Orchestrate keeps the parent read-only and routes built-in child roles through
  Settings → Roles; see [the guide](docs/user/orchestration.md).
  New Core session children can use separate Git worktrees; these separate
  working folders, not security permissions. Isolation for external-engine
  children remains planned ([#7](https://github.com/incadawr/anycode/issues/7)),
  as does Claude Code Orchestrate ([#35](https://github.com/incadawr/anycode/issues/35)).
- **Native inter-session communication.** The [Sessions API](docs/user/sessions-api.md)
  serves external clients today; communication between engine sessions is tracked
  in [#39](https://github.com/incadawr/anycode/issues/39).
- **Skills in engine tabs.** Forward AnyCode skills into Claude Code and Codex
  tabs: three app built-ins are available to root Claude and Codex processes,
  subject to CLI compatibility; Windows forwarding is unavailable. File-based
  skills are not forwarded. Broader skill support remains planned
  ([#12](https://github.com/incadawr/anycode/issues/12)).
- **Deep research mode.** Multi-step research sessions (web search and fetch,
  source tracking, a final report with citations) built as an orchestration
  preset rather than a separate agent.
- **Checkpoints & rewind.** _Available now (core engine)._ Per-turn snapshots
  of workspace changes with one-click rollback from the transcript timeline;
  capability-gated per engine.
- **Plan mode.** _Available now._ A read-only planning phase that produces a
  plan you approve before any file is touched.

### Preview & media

- **Universal preview pane.** _Markdown and HTML available now._ One surface
  that renders what a session produces, right inside AnyCode — a panel next to
  the chat or a window of its own. Markdown is rendered natively; a local HTML
  file or a live local dev-server page loads in an embedded browser view.
  Rendering is sandboxed and honors the workspace-roots consent model. Still
  ahead: file diffs and images in the same surface, and file mentions in the
  transcript opening there with the right renderer.
- **Agent-facing browser loop.** _Available now._ A second stage on top of the
  embedded browser view: the agent opens a page, reads its rendered text and
  console output, and captures screenshots to verify its own web work
  (screenshots require a vision-capable model). Still ahead: network logs.

### Distribution

- A native, single-file CLI distribution for fast cold starts and
  runtime-free installation.

---

## How this file is organized

- **ROADMAP.md** contains only public ideas and announcements.
- Tasks and research live separately as they are developed.
