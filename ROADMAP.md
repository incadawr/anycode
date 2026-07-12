# AnyCode — Roadmap & Announcements

> A living board of AnyCode ideas and announcements. It is a **statement of
> direction**, not a delivery schedule: priorities and timing may change, and
> some items may never ship. Concrete tasks and research are kept separately.

AnyCode is an open desktop client for AI coding agents. The goal is not another
agent, but a **single interface over agent runtimes**: choose the engine that
runs a session while the interface stays the same.

---

## 🔌 Harness profiles — interchangeable engines

The planned **harness profiles** model provides one UI over several backends. A
profile is selected per session; the transcript, confirmation dialogs, and
mode switching are shared across engines.

| Profile | What it is | Status |
|---|---|---|
| **Native** | AnyCode's built-in multi-provider agent loop | available now |
| **Codex** | OpenAI Codex as an engine through its `app-server` protocol | planned |
| **Claude Code** | Claude Code as an engine through its CLI headless stream | planned |

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

- A native, single-file CLI distribution for fast cold starts and runtime-free installation.

---

## How this file is organized

- **ROADMAP.md** contains only public ideas and announcements.
- Tasks and research live separately as they are developed.
