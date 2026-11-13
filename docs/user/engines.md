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
window on macOS and runs `claude auth login` under your shell environment.
On other platforms, run that command yourself in a terminal. Read the pane's status line before you
rely on a Claude tab: it shows whether the binary and the signed-in account are
both ready.

## Trust for the engine binaries

AnyCode checks the `codex` and `claude` binaries using these rules:

- A world-writable file is refused.
- A file owned by neither you nor root is refused.
- A group-writable file is refused except for `wheel`/`admin` on macOS, or on
  Linux when you own it and its group matches your effective primary group.
- The same checks apply to every ancestor directory of the resolved file and,
  for a symlink, to the directories containing the link.
- Windows skips these ownership and permission checks.
- Writability refusals and directory-ownership refusals offer
  **Review executable trust…** / **Trust this binary…** when the executable is
  owned by you or root and every ancestor is a directory.
- A file owned by neither you nor root cannot be trusted through consent.
  Missing paths, non-files, non-executable files and non-directory ancestors
  also provide no consent action.
- A consent is for one path and pins the file's current state (mode, owner,
  group, size and modification time). If it changes, the consent no longer
  matches; a new consent action appears only if the refusal remains eligible.
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

- A Codex or Claude tab can delegate to your subagent profiles when a profile or configured role
  is available. The Codex tool is `anycode_agent`; the Claude tool is
  `mcp__anycode__agent`. Neither appears in a child session.
- Root Claude and Codex processes can receive three app builtins: `anycode-setup`,
  `using-browser-preview` and `control-browser`. Claude uses the `anycode-app:`
  namespace; Codex uses `anycode-app-*` aliases listed in [skills.md](skills.md).
  Settings → Skills controls both engines at the next process launch, including
  resume. Both ignore workspace settings in untrusted workspaces.
  Claude reports preparation and recognition in the session; the pane shows
  settings, not process state or proof of model use.
- Filesystem skills remain Native-only; same-name files do not replace the app
  catalog in either engine. Windows forwarding is unavailable. See
  [skills.md](skills.md) for policy, aliases and crash retention.

## Binary discovery and versions

Codex discovery order is `ANYCODE_CODEX_BIN`, `codex.binaryPath`, `PATH`, common
install folders, then the managed install. Claude discovery is
`ANYCODE_CLAUDE_BIN`, `claude.binaryPath`, `PATH`, then common install folders.
An invalid override falls through to the next discovery source. A trust refusal
for an explicit environment or settings override stops discovery; the pane lets
you pick a different executable.

Common POSIX folders include `~/.local/bin`, `~/.npm-global/bin`,
`/opt/homebrew/bin` and `/usr/local/bin`; Windows also checks the npm install
folder. Managed Codex versions live in `~/.anycode/codex/bin/<version>/`.

The Codex installer downloads the platform package from the npm registry,
verifies sha512 integrity before unpacking, and does not run npm lifecycle
scripts. Managed installs can auto-upgrade to the recommended version; binaries
you selected yourself are never changed.

In AnyCode 0.0.90, the bundled Codex support range is `>=0.144.0 <0.170.0`,
recommended 0.169.0. The support manifest refreshes at most every six hours.
Read the pane for the current verdict and recommendation. Accepting risk for
an unsupported version applies to that version only. Claude requires at least
2.1.212; its doctor uses initialization rather than a model turn. AnyCode does
not install Claude Code.

## Accounts, speed and context

Codex account profiles use separate homes under
`~/.anycode/codex/profile-<id>/`, with at most eight profiles. The system profile
uses the normal Codex home and cannot be deleted. Choose the active profile in
Settings → Codex → Accounts. Browser and device-code sign-in have a five-minute
timeout. Claude uses its normal CLI account.

**Continue on another account**, enabled unless
`codexContinueOnAnotherAccount` is `"off"`, lets a Codex session continue using
another available profile when its account runs out. For supported Codex models,
the composer offers **Fast** speed. It consumes usage limits faster; changes
apply on the next turn.

Settings → Claude offers a context-window limit of 100k–1M tokens for new
sessions, affecting the meter and auto-compaction. Leave it blank for the CLI
default. The pane caches the live model list for the account and binary.

## What is forwarded

Configured MCP servers are resolved by AnyCode and forwarded when the CLI
process starts; project entries require folder trust. Restart the session after
changing them. The AnyCode bridge exposes delegation, child status, connection
listing and up to ten browser tools, depending on availability and restrictions.
Codex names them `anycode_*`; Claude uses `mcp__anycode__*`.

Native filesystem skills, hooks, workflows and LSP diagnostics do not become
CLI-native features. The three app skills have shorter engine-oriented bodies
and use the aliases above. Ordinary tool approval still belongs to the CLI.

You can switch engines inside a session while retaining conversation history.
The new engine uses its own runtime, account and approval controls.

## How to verify it applied

- Engine ready: open Settings → Codex or Settings → Claude and read the status
  line.
- Native tab: Settings → Provider shows a ready connection, then start a new tab.
- Profiles in an engine tab: a Codex or Claude tab declares the profile list when
  its session starts. After you add or rename a profile, start a new session in
  that tab.
