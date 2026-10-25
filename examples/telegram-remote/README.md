# Telegram remote control (example plugin)

Talk to your shared AnyCode sessions from one Telegram chat. A message goes to the
session you selected as a new turn, and the session's answer comes back to the chat.
The bridge is a plugin service: AnyCode starts it, supervises it and stops it.
It uses only Node built-ins and the global `fetch`, so there is nothing to install.
It needs Node 22 or newer on the `PATH` that AnyCode starts services with.

It is a copy-and-install template. It is named for Telegram by design; the generic
rules for services are in [channel plugins](../../docs/development/channel-plugins.md).

## Set up (about 15 minutes)

1. **Create a bot.** In Telegram, message @BotFather, send `/newbot`, and keep the
   token. Use one bot for one computer. Two AnyCode installs polling the same token
   fight over it (see `conflict` below).
2. **Find your numeric user id.** Message a bot such as @userinfobot. Your id is a
   number, not your username.
3. **Save two secrets.** In AnyCode, open Settings → MCP → Secrets and add
   `TELEGRAM_BOT_TOKEN` (the token from BotFather) and `TELEGRAM_ALLOWED_USERS`
   (your id; several ids separated by commas). The values are write-only and
   encrypted, like MCP secrets.
4. **Enable the Sessions API.** Settings → Sessions API: turn it on, then turn on
   the switch of each session you want to reach, and give it a handle (for example
   `build-bot`) in the tab's environment menu.
5. **Install the plugin.** Settings → Plugins → Install from folder, and choose
   `examples/telegram-remote`. The consent sheet lists the two secret names the
   service reads. Allow the service.
6. **Try it.** Send `/sessions` to your bot, then `/use build-bot`, then any text.

## Commands

| Message | What it does |
| --- | --- |
| `/sessions` | Lists shared sessions. Numbers work with `/use` for 10 minutes. |
| `/use <handle, id, id prefix or number>` | Selects a session. `/use` alone shows the selection. |
| any other text | Sends a new turn to the selected session (queued while it is busy). |
| `/steer <text>` | Adds text to the running turn. Codex only; other engines may refuse it. |
| `/stop` | Stops the running turn of the selected session, like the Stop button. |
| `/approvals` | Lists the approvals waiting in the selected session, each with Allow and Deny buttons. |
| `/status` | Bridge status, pending turns, and the selected session's engine and state. |
| `/help` | The command list. |

A turn you send is answered when the session finishes it. Up to 3 turns per chat can
wait at once. Answers longer than `TELEGRAM_MAX_REPLY_CHARS` (default 16000) are cut
and marked as truncated. Longer answers arrive as numbered parts.

## Status

`[status] <state>` lines in the service log (Settings → Plugins → View log) show the
bridge state. The chat's `/status` shows the same word.

| State | Meaning | What to do |
| --- | --- | --- |
| `starting` | Starting up. | Wait a moment. |
| `online` | Polling Telegram. | Nothing. |
| `conflict` | Another process polls this bot token, or a webhook is set. | Stop the other poller (one bot per computer). For a webhook, remove it yourself with `deleteWebhook`; the bridge never does it for you. It recovers by itself when the other poller stops. |
| `offline` | Telegram cannot be reached. | Nothing; it retries with a backoff and recovers. |
| `token_invalid` | Telegram rejected the bot token. The service stays idle. | Fix `TELEGRAM_BOT_TOKEN` in Settings → MCP → Secrets, then press Restart. |
| `no_allowlist` | `TELEGRAM_ALLOWED_USERS` has no valid id. The service stays idle and does not poll. | Save your numeric id, then press Restart. |
| `bad_config` | The bot token is missing, or the API address is not Telegram. Nothing is sent. | Save `TELEGRAM_BOT_TOKEN`, then press Restart. |
| `no_sessions_api` | The Sessions API is off. The bridge still answers, with a hint. | Enable Settings → Sessions API. |

The service also shows `Missing secret: NAME` when a secret it reads is not set. It
does not start until you save that secret; saving it starts the service.

## Safety

- Only a **private** chat from an id in `TELEGRAM_ALLOWED_USERS` reaches a session.
  Groups, channels, edited messages, buttons and bot senders are dropped before any
  reply or parsing. A stranger gets no reply. The log shows at most one
  `[ignored]` line per minute per id, never the text.
- The bridge adds no sessions. It only sees sessions you switched on in the Sessions
  API, and it names them by handle, state and folder name (not the full path).
- Session output is plain text. The Sessions API token and the bot token are
  redacted from every reply, log line and state file.
- Approvals reach Telegram only where the session's **External approvals** switch
  is on (off by default). Diffs and tool output are not forwarded.
- The token travels only to `https://api.telegram.org` (or a `127.0.0.1` test
  server). Any other `TELEGRAM_API_BASE` is refused.

## Limits

- One bot, one computer, one private chat. No groups, no media, no inline buttons.
- Text only, up to 32000 characters per message to a session.
- Results are long-polled, so an answer can take as long as the session's turn.
- Messages are delivered at least once across a crash. A repeated delivery is not
  sent to the session twice, because each message carries an idempotency key
  (`tg-<update id>`).

## Troubleshooting

- **`conflict` keeps coming back.** Another process has this bot token: an older
  AnyCode, a second computer, or a webhook. Stop it; use a new bot for the other
  computer.
- **`token_invalid` after a change.** Re-check the secret value (no spaces), then
  press Restart on the service.
- **Nothing answers, status `offline`.** Check the network. The bridge retries on
  its own.
- **`AnyCode is not reachable right now.`** AnyCode was quit or restarted, or the
  discovery file was removed. Open AnyCode; the bridge recovers.
- **A session is not listed.** Its Sessions API switch is off, or it is not in an
  allowed folder.

## Files

- `service.mjs`: the bridge (polling, commands, delivery, state).
- `lib.mjs`: pure rules (allowlist, command parsing, chunking, redaction, backoff).
- `.anycode-plugin/plugin.json`: the manifest. Its service reads the two secrets.

## Approvals from Telegram

When a session asks for a tool (a command, an edit, a fetch) and its **External
approvals** switch is on, the bridge sends one message with **Allow** and **Deny**
buttons. Tapping a button answers the request in AnyCode, and the message then
shows `Allowed.` or `Denied.`.

- The switch is set in AnyCode's session menu, is off by default, and only appears
  while the session is shared. Without it the bridge says so once in a while.
- Only **Allow** and **Deny** are offered. Nothing creates an "always allow" rule.
- A long command is shortened and its secrets are masked before it is sent.
- A request that must be answered in AnyCode (a plan or a question) is sent without
  buttons.
- A button for a request that is already answered, expired or unknown says so.
  If you answered in AnyCode first, the message says `Already answered (in AnyCode).`
- Only the owner's private chat can tap the buttons. Forwarding the message to
  someone else does nothing.

