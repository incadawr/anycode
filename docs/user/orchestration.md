# Orchestration (multi-model workflows)

Orchestration is the pattern where one session — the **supervisor** —
dispatches work to AnyCode subagent profiles instead of doing it all itself:
it plans, delegates to a lead/builder profile, awaits the result, verifies the
work, and accepts or returns defects.

Requires AnyCode 0.0.30 or newer.

## The three roles

| Role | Runs on | Spawned as | Does |
|---|---|---|---|
| Supervisor | Codex CLI (GPT), a normal AnyCode session | top-level session you drive | dispatches, awaits, verifies, accepts |
| Lead | Native engine (e.g. `glm-5.3`) | session-tier child via `anycode_agent` | plans, implements, self-reviews |
| Builder (optional) | Native engine, cheaper model | inline child spawned by the lead | one bounded, fully-resolved task |

## Getting started in four steps

1. Set up the supervisor's account (Settings → Codex) and a model connection
   for the lead (Settings → Provider) — details in the full doc.
2. Write the role profiles into `<project>/.anycode/agents/` (copy-paste
   examples: [subagents.md](subagents.md)).
3. Start a session on the supervisor's engine and dispatch through
   `anycode_agent` by `agent_type`.
4. Watch the child cards in the parent session: transcripts, progress, and
   the result report all surface there.

## Where to read more

- **The full setup** — accounts, connections, per-profile routing, idle
  watchdog, terminal markers: [../orchestration.md](../orchestration.md).
- **The profile format** (`engine:`, `connection:`, `model:`, the three hard
  frontmatter rules), plus complete copy-paste profiles per engine kind:
  [subagents.md](subagents.md).
- **Engine tabs and delegation** (what an engine session can see, the
  new-session rule for profile lists): [engines.md](engines.md).

> Role presets and fallback chains (Settings → Orchestration) arrive with
> AnyCode 4704 — until then, roles are plain markdown profiles like the ones
> above.
