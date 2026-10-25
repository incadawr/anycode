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
| **Claude Code** | Claude Code as an engine through its CLI headless stream | available now (early) |

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

## 💡 Ideas (incubator)

_Ideas and announcements collect here. Once an idea is ready for work, create a
separate task or research item._

### Extensibility

- **anyPlugin.** _Mostly available now:_ the documented manifest spec, a signed
  official index, two-phase install from file / URL / folder (git ahead), and
  the Settings → Plugins management UI (list / enable / disable / update /
  rollback / pin / diagnose), with MCP-server consent gates at install and
  after any command change. Importing skills and MCP servers from Claude Code,
  Codex and zcode configurations is available now. Still ahead: git install
  sources and more contribution types such as slash commands and hooks.
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
  an explicit handoff summary where it doesn't.
- **Multi-agent orchestration.** _Available now._ A supervisor session that
  plans work, spawns role-scoped agent sessions, and reviews their results —
  including declarative workflows (see `docs/orchestration.md`) — the
  substrate for everything below.
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
