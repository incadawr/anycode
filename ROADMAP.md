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

---

## 💡 Ideas (incubator)

_Ideas and announcements collect here. Once an idea is ready for work, create a
separate task or research item._

### Extensibility

- **anyPlugin.** Grow the existing plugin runtime (a plugin directory already
  contributes skills, agent profiles, and MCP servers) into a public
  ecosystem: a documented manifest spec, installation from a git URL or
  archive, a management UI (list / enable / disable / diagnose), and more
  contribution types such as slash commands and hooks.
- **MCP, first-class.** A management surface for MCP servers instead of raw
  JSON: per-server connection status and tool lists, enable/disable toggles,
  remote (streamable HTTP) servers with OAuth, and on-demand tool loading so
  large catalogs don't flood the context window.

### Sessions & workflow

- **Mid-session model and provider switching.** Change the model — or the
  provider behind it — between turns of one session, e.g. continue on another
  subscription when a quota runs out. Capability gaps (vision, context-window
  size) and the cache-reset cost are surfaced explicitly, never silent.
- **Harness switching (session transplant).** Move a live session between
  engines at a turn boundary, with the AnyCode transcript as the interchange
  format: lossless import/export where an engine's session format allows it,
  an explicit handoff summary where it doesn't.
- **Multi-agent orchestration.** A supervisor session that plans work, spawns
  role-scoped agent sessions, and reviews their results — the substrate for
  everything below.
- **Deep research mode.** Multi-step research sessions (web search and fetch,
  source tracking, a final report with citations) built as an orchestration
  preset rather than a separate agent.
- **Checkpoints & rewind.** Per-turn snapshots of workspace changes with
  one-click rollback; capability-gated per engine.
- **Plan mode.** A read-only planning phase that produces an approvable plan
  before any file is touched.

### Preview & media

- **Universal preview pane.** One surface next to the chat that renders what
  a session produces, right inside AnyCode: markdown, file diffs, images, and
  a live local dev-server page in an embedded browser view. File mentions in
  the transcript open there with the right renderer. Rendering is sandboxed
  and honors the workspace-roots consent model.
- **Agent-facing browser loop.** A second stage on top of the embedded
  browser view: the agent captures screenshots and reads console or network
  logs from the previewed page to verify its own web work (requires a
  vision-capable model for screenshots).

### Distribution

- A native, single-file CLI distribution for fast cold starts and
  runtime-free installation.

---

## How this file is organized

- **ROADMAP.md** contains only public ideas and announcements.
- Tasks and research live separately as they are developed.
