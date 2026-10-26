# Sessions API

The Sessions API lets an external agent, such as Claude Code or Codex, list the
live AnyCode sessions you share with it, read their status and last answer, and
send them a message. It is a local MCP endpoint that runs while AnyCode is open.

## Tools

| Tool | What it does |
|---|---|
| `list_sessions` | Lists the shared sessions. No transcript or credentials. |
| `get_session_status` | Engine and running/idle state of a shared session. |
| `get_session_result` | Latest completed public answer and its turn identity. No reasoning. |
| `send_message` | Sends a message. `mode: next_turn` queues it for the next turn; `mode: steer` steers an active Codex turn. |
| `get_message_status` | Delivery state of a message you sent. |
| `wait_for_result` | Waits (up to 120 s per call) until the turn that took your message finishes, then returns its answer. Returns `pending` on timeout; call it again. |
| `cancel_turn` | Stops the running turn of a shared session, like the Stop button. Queued messages are rejected and parked approvals are denied. An idle session answers `cancelled: false`, which is not an error. |
| `close_session` | Closes a shared tab opened by `create_session`; stop a running turn with `cancel_turn` first. |
| `create_session` | Opens a new tab in a project where you switched on **Allow agents to open tasks here**. See "Let agents open tasks" below. |
| `list_pending_approvals` | Lists tool requests waiting for an answer. Only sessions with **External approvals** on. See below. |
| `answer_approval` | Allows or denies one pending request of a session with **External approvals** on. See below. |

A session that is not shared is answered as unavailable, exactly like a session
that does not exist.

## Approve requests from outside

Tool requests (a command, an edit, a fetch) normally wait for you in AnyCode.
To let your external client answer them too, turn on **External approvals** for
that session. Open the tab's environment menu and tick the checkbox under
**Sessions API**. It appears only while the session is shared.

- It is **off by default**. A new top-level tab never has it on, and a child
  session inherits it from the parent that has it on.
- Turning sharing off also turns it off, so sharing it again does not re-enable it.
- `list_pending_approvals` shows the tool and a short, scrubbed description: a
  command with secrets masked and long lines shortened, a file path, a URL
  without its query, or a tool's argument names. It never shows file contents,
  edit text or typed text.
- The first answer wins, whether it comes from AnyCode or from the client. A
  later answer gets `already_answered`, with who answered it. The modal in
  AnyCode then closes with the notice **Answered from the Sessions API.**
- Outside AnyCode you can only **allow** or **deny** once. There is no "always
  allow". `ExitPlanMode` and `AskUserQuestion` must be answered in AnyCode.
- A request still expires after 120 seconds, and the expiry denies it.

## Enable it in Settings

1. Open **Settings → Sessions API** and turn on **Enable local Sessions API**.
2. Optional: **Add folder…** to limit sharing to exact folders. The picker is the
   only way to add one. Subfolders are not included, and symlinks are resolved.
   With no folder, only the sessions you switch on are shared.
3. Optional: set a **Port**. Leave it empty for a random free port.
4. Check the status line. It reads `Listening on 127.0.0.1:PORT` when the
   endpoint is up.

Changes apply immediately. Open client connections are dropped when you change
the toggle, the port, the folders or the token.

## Share a session

Every tab has a **Sessions API** row in its environment menu. Switch it on to
share that session. Once it is on, you can give the session a **handle** in the
same row (for example `build-bot`): lowercase letters, digits and `_ . @ -`, up
to 64 characters, unique among open sessions. An external bridge finds the session
by its handle through `list_sessions`. New tabs start with the default from **Sessions API → New
sessions are shared by default**, which is off unless you change it. A child
session started by a shared session inherits the switch. The switch is saved with
the session, so it survives a restart and a resume.

## Let agents open tasks

`create_session` lets an external agent open a new tab. It is **off for every
project** until you switch it on: open the project's **⋯** menu in the sidebar
and tick **Allow agents to open tasks here**. The switch is saved on this
computer per project (a symlinked path and its target are one project).
Settings → Sessions API → Advanced lists the projects that allow it and has an
**Off** button for each; turning one on is only done in the sidebar.

Input: `workspace` (absolute path, required); optional `engine` (`core`,
`codex`, `claude`), `model`, `handle` and `firstMessage`. The new session is
shared immediately. An accepted `handle` is the tab title for the tab's lifetime
and stays fixed through automatic titling. This pin is in memory: saved session
history retains the automatically generated payload title, which is shown when
the session is resumed after closing the tab or restarting AnyCode. Without a
handle the title comes from the message payload. `firstMessage` is delivered
like `send_message` with
`mode: next_turn` and the reply carries its `messageId`, so `wait_for_result`
works on it. If the new tab's host is not ready within 10 seconds, the reply
omits `messageId`; the tab exists, so send the message yourself with
`send_message`. If the new tab ends up outside the folders list (the list
changed while the tab was opening), `firstMessage` is refused with
`not_allowed` naming the tab's ids instead of being silently dropped.

`model` picks what the new session runs:

- For `engine: "core"` (the default) it selects one of the **provider
  connections** you already configured. Name it by connection id, by its
  **label**, as `<providerId>/<model>` (for example `deepseek/deepseek-v4-pro`),
  or by a model id that connection offers (its default model or an entry in its
  model list). The session is pinned to that connection; when the value names a
  model other than the connection's default, the session runs that model.
- An unknown value, or one that matches more than one connection, is refused
  with `invalid_model` and the error text lists the connections to choose from.
  AnyCode never falls back to the active connection in that case.
- Omit `model` to use the active connection, as before.
- For `engine: "codex"` or `engine: "claude"`, `model` is the model that engine
  runs.

Rules and limits:

- The folder must be trusted in AnyCode (Settings → Permissions).
- At most 5 creations per minute, and at most 8 agent-opened tabs alive at once.
  The per-minute counter resets when the Sessions API restarts; the alive count
  follows the tabs still open in AnyCode.
  Only creations that succeed count towards the 5-per-minute limit; refused
  attempts never consume it.
- A refusal is an error whose text starts with a code: `not_allowed` (the
  project switch is off, or the folders list excludes it), `not_trusted`,
  `folder_not_found`, `rate_limited`, `too_many`, `not_ready` (the engine is not
  signed in, or the tab limit is reached), `invalid_model` (`model` does not
  select exactly one provider connection; the text lists the candidates).
- Tabs an agent opened carry an **agent** marker in the sidebar row and in the
  session header. Agent-opened marking is in memory: after an app restart,
  restored tabs have no agent marker and cannot be closed by agents
  (`not_agent_opened`).
- With `ANYCODE_COMMUNICATION_CONFIG` set, `create_session` always answers
  `not_allowed`.

### Close an agent-opened task

Call `close_session {"sessionId":"…"}` to close a shared tab opened through
`create_session`. It stops the host and removes the sidebar tab through the
same close path as the UI, freeing one place in the 8-alive limit. The reply is
`{"sessionId":"…","closed":true}`. Session history is kept, as with UI closing.

Errors start with `close_session <code>:`: `not_found` (unknown, closing or not shared),
`not_agent_opened` (user-opened tab), `busy` (running turn or host not ready;
call `cancel_turn` and wait for idle), `last_tab` (open another tab before
closing the last remaining tab), or `not_allowed` (env-file mode). Env-file mode never enables this tool.

## Connect an external client

Click **Copy MCP config** and choose **Claude Code** or **Codex**. The button is
enabled only while the endpoint is listening.

- Claude Code: run the one-line `claude mcp add` command shown below the buttons,
  or paste the copied JSON into your Claude Code MCP configuration.
- Codex: paste the copied `[mcp_servers.anycode-sessions]` table into your Codex
  configuration.
- Other clients: use the copied JSON as the `mcpServers` entry.

The copied config runs the bundled stdio adapter with the discovery file as its
argument. The adapter reads the token from that file itself, so the copied
config holds no token. The adapter is copied to the AnyCode user-data directory,
so the config keeps working after an app update. The client needs **Node 22+**.

## Token and discovery file

- The token is generated when the server starts. It is never shown in Settings,
  never written to `settings.json`, and never logged.
- The discovery file is `communication.json` under the AnyCode user-data
  directory. It holds the URL, the token and the folder list, with mode `0600`.
  Keep it private.
- **Regenerate token** writes a new token to the discovery file. A running
  stdio adapter reloads the discovery file and retries once after a network
  error or HTTP 401, including after a restart or token regeneration. A network
  error can occur after a request was processed, so a retry may repeat its effect.

## Environment override

Setting `ANYCODE_COMMUNICATION_CONFIG=/absolute/path/config.json` when you start
AnyCode takes over the endpoint. It ignores the Settings values, and the Settings
pane becomes read-only with the note "Controlled by ANYCODE_COMMUNICATION_CONFIG".
The file has the older shape, `{"workspaces": [...], "port": 0, "discoveryFile": "..."}`,
and every session in those folders is shared. It needs at least one folder.

## Manual settings

The Settings pane writes this block to `~/.anycode/settings.json`:

```json
"communication": { "enabled": true, "workspaces": ["/abs/path"], "port": 0, "defaultSessionAccess": "off" }
```

Hand edits apply at the next launch. Every key is optional. A malformed value
falls back to its default (for example, a bad `port` means a random port). An
unknown key, or a block that is not an object, turns the endpoint off, and the
rest of `settings.json` keeps working.

## Worked example: wake a session

1. In the client, call `list_sessions`. The shared session appears with its
   `sessionId`.
2. Call `send_message` with `sessionId`, `payload`, and `mode: "next_turn"`.
   The message queues for that session's next turn.
3. Call `get_message_status` with the returned `messageId`. A state of
   `acknowledged` means the session took the message. It does not prove the
   model has applied it.
4. Call `wait_for_result` with the same `sessionId` and `messageId` to get the
   answer. Give a request timeout longer than `timeoutMs` in your MCP client
   (its default is 60 seconds), or keep `timeoutMs` at 50000 or less and call
   again while the status is `pending`.

Services that bridge an outside channel use the same tools. See the
[channel plugin guide](../development/channel-plugins.md).

## Security model

- Local only. The server binds `127.0.0.1` and refuses browser origins.
- Every holder of the token acts as the same local supervisor. It can message
  the shared sessions. Treat the discovery file as a credential.
- The folder list is an outer boundary, and the per-session switch is the
  inner one. A session must pass both when folders are set.
- A token holder can open new tabs only in projects where you switched on
  **Allow agents to open tasks here**, only in trusted folders, and within the
  limits above.
- A token holder can also stop the turns of shared sessions (`cancel_turn`).
- Only where **External approvals** is on, a token holder can also allow or deny
  that session's tool requests. The switch is set only from AnyCode's own
  settings. No tool, message or plugin can change it.

## Worked example: approve a command from a bridge

1. Turn on **External approvals** for the session in its environment menu.
2. The session runs a command that asks, for example `npm publish`.
3. Call `list_pending_approvals` with its `sessionId`. You get the tool, the
   scrubbed command and an `approvalId`, with `answerable: true`.
4. Call `answer_approval` with `decision: "allow"`. The command runs. The status
   is `answered`. If the user already answered in AnyCode, the status is
   `already_answered` with `settledBy: "ui"`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Status reads **Off** | The toggle is off. Turn it on. |
| Status reads **Error: the port is already in use** | Another program holds the port. Pick another port, or leave it empty. |
| Status reads **Error: a folder in the list is no longer available** | The folder was moved or deleted. Remove it, or re-add it. |
| Status reads **Error: the server could not start** | Check the AnyCode log. The log names the problem without the token. |
| `list_sessions` returns no sessions | No session is shared yet. Switch on the session's **Sessions API** row. |
| `create_session` says `not_allowed` | Tick **Allow agents to open tasks here** in the project's sidebar **⋯** menu. |
| `create_session` says `not_trusted` | Trust the folder first (Settings → Permissions). |
| `create_session` says `rate_limited` or `too_many` | At most 5 per minute and 8 agent-opened tabs alive. Wait, or close some. |
| `create_session` says `invalid_model` | The `model` value matches no configured provider connection, or more than one. The error lists the connections; retry with a connection id, its label, `<providerId>/<model>`, or omit `model`. |
| Copy buttons are disabled | The endpoint is not listening. Fix the status first. |
| Copied config says the adapter was not found | This build does not include the adapter. Install an official build. |
| `401` after you regenerate the token | Check that the discovery file is private and current, then retry the call or restart the MCP connection. |
| Settings pane is read-only | `ANYCODE_COMMUNICATION_CONFIG` is set. Unset it and restart AnyCode to use Settings. |

See also [configuration.md](configuration.md) and
[troubleshooting.md](troubleshooting.md).
