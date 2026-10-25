# Plugins

A plugin is a directory that ships AnyCode extensions as one package: skills,
subagent profiles, slash-menu commands (workflows), and MCP servers. Install
one and its contents appear everywhere they normally would — the Skills and
Subagents panes, the slash menu, the MCP pane — with the plugin named as the
source.

Plugins are **additive-optional**: an AnyCode with zero plugins behaves
exactly as before, and hand-placed plugin directories (below) keep working.

Open the pane from Settings → **Plugins** or by typing `/plugins` in a task.
The Skills and Subagents panes link to it from their plugin rows, and
plugin-contributed MCP servers appear as read-only rows in the MCP pane.

> The official channel is **not configured** until production signing keys
> are published: the pane header says "Official index not configured in this
> build", the *Available from AnyCode* list stays empty, and nothing
> auto-installs. File, URL and folder installs work regardless.

## Where plugins live

| Location | What it is |
|---|---|
| `~/.anycode/plugins/<name>/` | User plugins — managed installs land here, and hand-dropped directories keep working |
| `<workspace>/.anycode/plugins/<name>/` | Project plugins, checked into the repo and shared with the team |
| AnyCode's managed store | Where the app itself installs, updates and rolls back plugins (shown as **Official**, **Third-party** or **Local** in the pane) |

A plugin directory carries a `.anycode-plugin/plugin.json` manifest describing
its name, version, and what it contributes. Anything the manifest does not
declare is not granted — capabilities are derived from content, never
self-declared by the plugin.

## Tiers

- **Official ✓** — from AnyCode's signed plugin index. Verified signature and
  checksum on every download.
- **Third-party** — installed from a URL or a `.tgz` file you chose. Checksum
  is shown before install; you decide whether to trust it.
- **Local** — a dev-linked folder, for writing your own plugins.
- **Project** — hand-placed `<workspace>/.anycode/plugins/<dir>`, versioned
  with the repo.
- **Legacy** — a hand-plugged `~/.anycode/plugins/<dir>` the app did not
  install. It appears in the pane read-only; delete it by deleting the
  directory.

## Install sources

Settings → **Plugins** → **Install…**:

- **From file (.tgz)** — main opens its own file picker; the archive is
  verified and extracted app-side.
- **From URL** — an `https://` link to a `.tgz` archive.
- **From folder (dev link)** — link a local directory you edit; changes apply
  to newly started tasks.
- **From git** — planned; disabled in this build.

Every install is **two-phase**: the app first stages and validates the plugin
and shows you a preview — name, version, source, checksum prefix, the
capabilities it derives, and **the MCP servers it would start (command line
included)** — and nothing is written until you confirm.

## Consent for MCP servers

A plugin's MCP servers never start by themselves. At install the sheet shows
each server's command line and offers two buttons:

- **Install (MCP servers stay off)** — the default. Everything except MCP
  works immediately.
- **Install and allow MCP servers** — records consent for exactly the command
  lines shown.

If the plugin later changes a server's command, the consent no longer matches
and the pane marks the plugin **Needs approval** — a new command needs fresh
approval, every time. You can also grant approval later from the plugin's row
(**Approve MCP**). Consent is per plugin, user-global; project and legacy
plugin rows show the same consent state.

Auto-update for official plugins is OFF by default (toggle **Auto-update
official plugins** in the pane header); third-party and local plugins never
update without an explicit **Update** click.

## Services

A plugin can declare **services**: long-running background processes (for
example, a bridge to a chat app) that AnyCode starts for you. They follow the
same rules as MCP servers:

- Nothing runs until you consent. The install sheet lists each service's
  command, arguments and environment variable **names** (never the values) in a
  red block, behind **Allow this plugin's background services to run**. Without
  that box, or later through **Approve services** on the plugin's row, the
  service stays off and the row shows **Services need approval**.
- A changed command, argument or set of environment variable names needs fresh
  approval. Changing only an environment variable's value does not.
- A service runs only while its plugin is enabled. Disabling or removing the
  plugin stops it, along with the rest of its process tree. Quitting AnyCode
  stops every service.
- A plugin in a project folder (`.anycode/plugins/`) runs its services only
  once you trust that folder.
- A crashed service restarts after 1, 2, 4 seconds and so on, up to one minute.
  After five failures within two minutes it stops restarting and shows
  **Crash loop**; press **Restart** to try again.
- The row shows each service's state. **View log** shows its recent output as
  plain text (last 200 lines, newest last), and **Copy log** copies it.
- A service reaches your AnyCode sessions through the Sessions API. When the
  Sessions API is off, the service still runs, but the row says so and asks you
  to enable it in **Settings → Sessions API**. Each service gets the path to the
  discovery file in `ANYCODE_SESSIONS_DISCOVERY`, only while the Sessions API
  runs. The token is never placed in its environment, arguments or log.
- To write a service that bridges an outside channel, see the
  [channel plugin guide](../development/channel-plugins.md).

## Example: Telegram remote control

[`examples/telegram-remote`](../../examples/telegram-remote/) is a service plugin
that reaches your shared sessions from Telegram. Its secrets are saved in
Settings → MCP → Secrets, and the install sheet lists them. See
[Remote control from a chat app](remote-control.md).

## Updates, rollback, pin

- **Update** — moves to the newest version compatible with your AnyCode.
- **Rollback** — swaps `active` and `previous` and pins, so an auto-update can
  immediately undo itself if it misbehaved.
- **Pin** — freezes a plugin: no auto-updates, no rollback offered, until you
  unpin. Pin what works.
- **Remove** — deletes a managed install. Default (bundled) plugins can be
  removed too; they come back on the next app update unless you remove them
  again (a tombstone remembers your choice).
- **Reveal** — opens the plugin's directory in your file manager.

Enable/disable is user-global per plugin, all tiers: a disabled plugin stays
installed but contributes nothing.

## Troubleshooting

- **A plugin's skill/subagent/slash command doesn't appear** — changes apply
  to newly started tasks; start a new task. Still missing? The pane row shows
  per-plugin problems (a bad manifest, an entry that escapes the plugin root)
  fail-soft — the rest of the plugin still loads.
- **A plugin MCP server doesn't start** — check the MCP pane's *From plugins*
  section (read-only rows): no consent yet shows **Needs approval**; a name
  collision with your own config means your config wins at runtime.
- **Index offline / signature failed** — the pane header says so; installs and
  updates pause until the index refreshes (Check for updates retries).
- **"Official index not configured in this build"** — this build carries no
  production signing key yet, so the official channel is disabled by design.
  Third-party installs (file/URL/folder) still work.
- **The pane says "Plugins service unavailable"** — this build's main process
  does not expose the plugins channels. Hand-placed directories keep working
  as before.

For authoring your own plugin (manifest reference, layout, signing), see
[docs/development/plugins-authoring.md](../development/plugins-authoring.md).
