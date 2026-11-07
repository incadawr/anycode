# Telegram remote control

The Telegram example plugin lets you talk to your shared AnyCode sessions from a
private Telegram chat: `/sessions` lists them, `/use` selects one, and any text you
send becomes a new turn whose answer comes back to the chat. It is a plugin you
install from a folder, not a built-in feature.

The full setup (create a bot, save two secrets, enable the Sessions API, install the
plugin) and the command list are in
[`examples/telegram-remote/README.md`](https://github.com/incadawr/anycode/blob/master/examples/telegram-remote/README.md).

Short version of what you will see in Settings → Plugins:

| Status | Meaning |
| --- | --- |
| `starting` | The bridge is starting; wait for the next state. |
| `offline` | Telegram cannot be reached; the bridge retries with backoff. |
| Running, `online` | The bridge polls Telegram and reaches your sessions. |
| `conflict` | Another process uses the same bot token. Use one bot per computer. |
| `token_invalid` | Telegram rejected the token. Fix it in Settings → MCP → Secrets and press Restart. |
| `no_allowlist`, `bad_config` | A secret is missing or wrong. Save it and press Restart. |
| `no_sessions_api` | The Sessions API is off; the bridge answers with a hint. |
| `Missing secret: NAME` | A secret the service reads is not set yet. |

Only your own private chat reaches a session. `/stop` stops the selected session's
running turn. Approvals reach Telegram as Allow and Deny buttons, but only for a
session whose **External approvals** switch you turned on in AnyCode.

The plugin service row can also show **Stopped** when the process is not
running; it is separate from the bridge's reported network status.

## Commands

| Command | Purpose |
|---|---|
| `/status` | Bridge status, pending turns and selected session |
| `/projects` | Projects allowing session creation; selection numbers last ten minutes |
| `/new <project> <text>` | Open and select a session, then send the first turn; optional engine/model/effort/handle selectors |
| `/close` | Close the selected session only if this bridge opened it |
| `/sessions`, `/use <handle or id>` | List shared sessions and select one |
| `/stop`, `/approvals` | Stop the selected turn or inspect its approval buttons |
| `/steer <text>` | Add input to a running Codex turn; other engines may refuse |
| `/help` | Full command list |

Creation still requires an allowed project and folder trust. External approval
buttons require that session's explicit opt-in; sharing alone does not grant it.
