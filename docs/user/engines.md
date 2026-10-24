# Engines

An **engine** decides which agent runtime drives a tab: AnyCode's own in-process
loop, the Codex CLI, or Claude Code. A **provider connection** decides which
model API the requests hit. The two choices are independent.

Requires AnyCode 0.0.35 or newer.

## Engine vs provider

- A **connection** (Settings → Provider) picks the model API — e.g. a Z.AI
  connection running `glm-5.3`, or a DeepSeek connection.
- An **engine** picks the runtime that drives the tab — AnyCode's own loop, or
  a real `codex`/`claude` CLI process with its own account, tools, and
  approval model.
- The Native engine uses connections directly. Codex and Claude tabs use their
  CLI's own account (sign-in in their panes) — the app's connections still
  matter for AnyCode-side children those tabs delegate to.

## The three engines

| Engine | Tab type | Runs on | Configured in |
|---|---|---|---|
| Native | core tabs | AnyCode's in-process agent loop | Settings → Provider (connections) |
| Codex | codex tabs | the `codex` CLI as an agent process | Settings → Codex |
| Claude Code | claude tabs | the `claude` CLI as an agent process | Settings → Claude |

### Native

The default. Everything — tools, permissions, skills, subagents, MCP — is
in-process. A Native tab needs at least one working connection in
Settings → Provider before its first message.

### Codex CLI

Settings → Codex discovers (or installs) the `codex` binary, then walks you
through sign-in under the account profile you will use. Multiple account
profiles are supported; a session is frozen to its profile for its lifetime.
The pane's status states tell you the two things that must both be true: the
binary was found (path shown), and an account is signed in.

### Claude Code

Settings → Claude does the same for the `claude` binary: discovery, version
check, and sign-in state. As with Codex, check the pane's status line — found
binary plus signed-in account — before relying on a Claude tab.

## When a tab picks each engine

- **Native** is the default for everyday work in this app: it is the engine
  with the tightest tool, skill, and permission integration.
- **Codex / Claude tabs** are for running work *under that engine's* runtime —
  for example a Codex supervisor session orchestrating AnyCode subagents (see
  [orchestration.md](orchestration.md)) or porting a workflow that already
  assumes one CLI's toolset.

## Trust and consent prompts

The first time an engine tab spawns its CLI, AnyCode asks you to trust the
binary. The prompt names the **path** and the binary's **fingerprint**
(a hash): the path tells you *what* will run, the fingerprint pins *exactly
which build*. Consents are stored per path and listed in Settings →
Permissions → trusted binaries; re-consent is required when the fingerprint
changes.

## When the CLI updates outside the app

The CLI can update itself (or be updated by you) after you trusted it. A new
build means a new fingerprint: the next spawn asks for trust again — that is
the mechanism working, not an error. If the binary moves or is removed, the
engine pane's status returns to "not found" and the tab refuses to start a
session until you re-discover or reinstall in the pane.

## Proxy per engine

Each engine's pane can route its CLI traffic through a proxy profile from
Settings → Network (a Codex profile is an auth home, never a network path —
the proxy is configured separately). See [proxy.md](proxy.md).

## Delegation from engine tabs

Codex and Claude tabs see an `anycode_agent` tool for delegating to AnyCode
subagent profiles — the profiles live in `.anycode/agents/` and are shared
with Native tabs. The deep dive on that setup (profiles, session children,
detached background agents) is [../orchestration.md](../orchestration.md);
the profile format itself is [subagents.md](subagents.md).

## How to verify it applied

- Binary found + signed in: open Settings → Codex / Claude — the status line
  in the pane is the single source of truth.
- A connection for Native tabs: Settings → Provider, then start a new tab.
- Engine tab sees your profiles: profiles are declared to an engine session at
  boot — start a **new session** after adding or renaming a profile
  (editing an existing profile's body applies from the next spawn).
