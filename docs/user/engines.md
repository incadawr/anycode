# Engines

An **engine** decides which agent runtime drives a tab: AnyCode's own loop
(Native), the Codex CLI, or Claude Code. A **provider connection** decides which
model API the requests go to. The two choices are independent.

## Engine versus provider

- A **connection** (Settings → Provider) picks the model API, for example a
  Z.AI connection running `glm-5.3`, or a DeepSeek connection.
- An **engine** picks the runtime. Native uses AnyCode's own loop and your
  connections. Codex and Claude run the real `codex` or `claude` CLI with its
  own account, tools and approval model.
- Codex and Claude tabs sign in through their CLI, not through a connection.
  Connections still matter for AnyCode subagents that run on Native children.

## The three engines

| Engine | Tab type | Runs on | Configured in |
|---|---|---|---|
| Native | core tabs | AnyCode's in-process loop | Settings → Provider |
| Codex | codex tabs | the `codex` CLI as an agent process | Settings → Codex |
| Claude Code | claude tabs | the `claude` CLI as an agent process | Settings → Claude |

### Native

The default. Tools, permissions, skills, subagents and MCP servers all run
in-process. A Native tab needs a ready connection in Settings → Provider before
its first message.

### Codex

Settings → Codex finds the `codex` executable and checks its version. If it is
not installed, the pane offers an install action. Under **Accounts** you sign in
(**Sign in with a code** is the device-code flow) and choose the account profile
that new sessions use. Under **Advanced troubleshooting** you can choose the
executable by hand.

### Claude Code

Settings → Claude finds the `claude` executable and checks its version. The
**Connect Claude Code** section signs you in. The sign-in opens a Terminal
window and runs under your shell environment. Read the pane's status line before you
rely on a Claude tab: it shows whether the binary and the signed-in account are
both ready.

## Trust for the engine binaries

AnyCode runs the `codex` and `claude` binaries you point it at. It trusts a
binary automatically unless the file sits where someone else could replace it:
the file is writable by others, or owned by another account. Only that case
asks for consent. The Codex and Claude panes then show a refusal with
**Review executable trust…** and **Trust this binary…**.

- A consent is for one path and pins the file's current state (mode, owner,
  group, size and modification time). If the file changes, the consent no longer
  matches and the pane asks again.
- A file owned by another account, and a path that is not a regular executable,
  cannot be trusted this way.
- Consents are listed under Settings → Permissions → Trusted binaries.

## When a tab picks each engine

- **Native** is the default. It has the tightest integration with tools, skills,
  permissions and profiles.
- **Codex and Claude tabs** run work under that engine's own runtime, for example
  a Codex session that supervises AnyCode subagents. See
  [orchestration.md](orchestration.md).

## Proxy per engine

The Codex and Claude panes each have a **Proxy** picker: use the application
proxy, no proxy, or a named proxy profile. A Codex account profile is an auth
home, not a network path, so the proxy is set separately. An `HTTP(S)_PROXY`
already exported in the app's launch environment takes precedence over the pane.
See [proxy.md](proxy.md).

## Delegation and skills in engine tabs

- A Codex or Claude tab can delegate to your subagent profiles when at least one
  profile exists. The Codex tool is `anycode_agent`; the Claude tool is
  `mcp__anycode__agent`. Neither appears in a child session.
- AnyCode skills (including `anycode-setup`) load only in Native tabs. Codex and
  Claude tabs do not receive them.

## How to verify it applied

- Engine ready: open Settings → Codex or Settings → Claude and read the status
  line.
- Native tab: Settings → Provider shows a ready connection, then start a new tab.
- Profiles in an engine tab: a Codex or Claude tab declares the profile list when
  its session starts. After you add or rename a profile, start a new session in
  that tab.
