# Channel plugins: author guide

A **channel plugin** bridges an outside source of messages (a chat, a form, a
queue, a folder) to your AnyCode sessions. It is a plugin with one or more
**services**: long-running processes that AnyCode starts, supervises and stops.
A service talks to the Sessions API to list sessions, send messages and read
answers.

Read first: [Authoring plugins](plugins-authoring.md) (manifest v1) and the user
guide's [Services](../user/plugins.md#services) and
[Sessions API](../user/sessions-api.md) pages.

## Manifest `services`

```json
{
  "manifestVersion": 1,
  "name": "my-bridge",
  "version": "0.1.0",
  "displayName": "My bridge (example)",
  "description": "Forwards files from an inbox folder to a session.",
  "skills": [],
  "agents": [],
  "workflows": [],
  "services": [
    { "name": "bridge", "command": "node", "args": ["./service.mjs"], "env": { "BRIDGE_POLL_SECONDS": "30" } }
  ]
}
```

| Field | Rule |
|---|---|
| `name` | Matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Unique within the plugin; a duplicate fails the whole manifest. |
| `command` | A bare executable on `PATH` (`node`), a `./` path inside the plugin root, or an absolute path. |
| `args` | Optional string array. Put `./` paths here for scripts (`["./service.mjs"]`). |
| `env` | Optional literal string values. Keys match `^[A-Za-z_][A-Za-z0-9_]*$` and must not start with `ANYCODE_`. Only `${secret:NAME}` is interpolated: AnyCode resolves it from its secret store at spawn, and an unset name blocks the service (`missing_secret`, shown by name). Never put a literal secret here. |

The service's working directory is the plugin root. A service is started only when
the plugin is enabled and the user has approved its definition (see Consent).

## Environment given to a service

The child gets a fixed allow-list from the app environment (`PATH`, `HOME`,
`USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `SYSTEMROOT`, `COMSPEC`), then your
`env` values, then these AnyCode variables. Inherited `ANYCODE_*` variables never
pass through.

| Variable | Value |
|---|---|
| `ANYCODE_PLUGIN_NAME` | The plugin `name`. |
| `ANYCODE_PLUGIN_DIR` | Absolute plugin root. |
| `ANYCODE_SERVICE_NAME` | The service `name`. |
| `ANYCODE_SESSIONS_DISCOVERY` | Absolute path of the discovery file. Set only while the Sessions API runs. |

The token is **not** in the environment. Read it from the discovery file, which
the service opens itself. Never print it, log it, or put it in arguments. A
service that finds no `ANYCODE_SESSIONS_DISCOVERY` should print a hint and stay
idle, not exit in a loop.

## Lifecycle

- **Start:** when AnyCode starts (if the plugin is enabled and approved), when you
  enable the plugin, and when you press **Restart**.
- **Stop:** when you disable or remove the plugin, and when AnyCode quits. A stop
  takes the whole process tree: SIGTERM to the process group, then SIGKILL after a
  short grace period (on Windows, `taskkill /T /F`). Handle SIGTERM and exit cleanly.
- **Restart after a crash:** after 1, 2, 4 seconds and so on, capped at 60 seconds.
- **Crash loop:** five failures within two minutes stop the restarts; the row shows
  **Crash loop** until the user presses **Restart**.
- **Logs:** stdout and stderr go to a bounded buffer. **View log** and **Copy log**
  in Settings → Plugins show the recent lines. Keep log lines short and free of
  message contents you do not want shown.

## Consent

- The install sheet lists each service's command, arguments and environment
  variable **names**. Values are never shown.
- The approval covers name, command, arguments and the set of environment keys. A
  change to any of them asks again. A change to an environment **value** does not.
- A plugin in a project folder (`.anycode/plugins/`) runs its services only after
  the user trusts that folder.

## Connecting to the Sessions API

The discovery file is `communication.json` in the AnyCode user-data directory. It
is mode `0600` and holds:

```json
{ "url": "http://127.0.0.1:52811/mcp", "token": "<64 hex chars>", "workspaces": [] }
```

- Transport: MCP over Streamable HTTP, loopback only (`127.0.0.1`).
- Send every request as `POST` with `Authorization: Bearer <token>`,
  `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- Do **not** send an `Origin` header. Requests with one are refused with 403.
- Responses are plain JSON (stateless). Each POST is one JSON-RPC request, so you
  can call `tools/call` directly. An MCP SDK client also works: it calls
  `initialize` first, which the server accepts.
- A tool result is `{"content":[{"type":"text","text":"<JSON>"}]}`. The text is
  the JSON payload shown below. A failure sets `"isError": true` and the text is
  the plain error message (see the errors table).
- On `401`, the token was regenerated. Read the discovery file again and retry.
  Re-read it on each call rather than caching the token.

## Handles and sharing

The user shares a session from its environment menu (**Sessions API** row) and
can give it a **handle**, for example `build-bot`. A handle is lowercase letters,
digits and `_ . @ -`, up to 64 characters, and must be unique among the sessions
that are open right now. It is stored by AnyCode, so it survives a restart.

Your service addresses a session by its handle: call `list_sessions`, find the
entry whose `handle` equals yours, and use its `sessionId`. A shared session
without a handle is listed without the `handle` key. A child session does not
inherit its parent's handle.

## Tools

Arguments are validated by the server. Unknown keys are refused. The examples
show every field a request needs and a typical response.

### `list_sessions`

Request: `{}`

```json
{
  "sessions": [
    { "sessionId": "sess-7f3a", "workspace": "/Users/me/src/app", "state": "running", "pid": 4242, "handle": "build-bot" }
  ]
}
```

`state` is the host process state, not model activity. `handle` appears only when
one is set. `childOf` is present for a child session.

### `get_session_status`

Request: `{ "sessionId": "sess-7f3a" }`

```json
{ "sessionId": "sess-7f3a", "workspace": "/Users/me/src/app", "pid": 4242, "engine": "core", "state": "idle", "steering": { "supported": false, "ready": false } }
```

`state` is `idle`, `running` or `closing`.

### `get_session_result`

Request: `{ "sessionId": "sess-7f3a" }`

```json
{
  "sessionId": "sess-7f3a",
  "availability": "available",
  "activeTurnId": null,
  "latestResult": {
    "source": "live_turn",
    "turnId": "turn-91",
    "requestId": "req-12",
    "nativeTurnId": null,
    "terminalReason": "completed",
    "publicAnswer": "Build is green.",
    "truncated": false,
    "completedAt": 1761400000000,
    "deliveredMessageIds": ["msg-0a1"],
    "correlationMeaning": "transport_delivery_only"
  },
  "limitation": "Latest completed public text block only. History recovery cannot establish terminal status or turn/message correlation. Completion does not prove a message was applied."
}
```

`availability` is `pending` while a turn runs, `unavailable` before any turn, and
`recovered_unverified` for text recovered from history. `publicAnswer` is plain
assistant text, with no reasoning and no transcript.

### `send_message`

Request (queue for the next turn):

```json
{
  "sessionId": "sess-7f3a",
  "payload": "Please also run the lint job.",
  "mode": "next_turn",
  "kind": "agent_message",
  "correlationId": "chat-123:msg-456",
  "replyTo": "msg-0a1",
  "idempotencyKey": "chat-123:msg-456"
}
```

Only `sessionId`, `payload` (1 to 32000 characters) and `mode` are required.
`mode` is `next_turn` (queue while busy) or `steer` (inject into an active Codex
turn; refused otherwise). `kind` is `agent_message` (default) or `task_result`.
`correlationId` and `replyTo` are up to 200 characters and are echoed in the
envelope. The sender is always stamped by AnyCode; you cannot set it.

Response (the delivery record):

```json
{
  "envelope": {
    "messageId": "msg-0a1",
    "sender": "authenticated-local-supervisor",
    "recipientSessionId": "sess-7f3a",
    "correlationId": "chat-123:msg-456",
    "replyTo": "msg-0a1",
    "kind": "agent_message",
    "payload": "Please also run the lint job.",
    "mode": "next_turn",
    "createdAt": "2026-10-25T10:00:00.000Z"
  },
  "state": "queued",
  "detail": "Dispatch pending",
  "idempotencyKey": "chat-123:msg-456",
  "workspace": "/Users/me/src/app",
  "hostPid": 4242
}
```

`state` is `queued`, `acknowledged`, `rejected` or `unknown` (see Delivery).

**Idempotency.** Reusing an `idempotencyKey` returns the existing record and never
dispatches again. Reusing it with a different `sessionId`, payload, mode, kind,
`correlationId` or `replyTo` is an error. Use one stable key per external event.

### `get_message_status`

Request: `{ "messageId": "msg-0a1" }`

Response: the same delivery record as `send_message`, with the current `state`.
For a message to a shared session the server asks the host for the latest state
first. Use `wait_for_result` when you need the answer.

### `cancel_turn`

Request: `{ "sessionId": "sess-7f3a" }`. It stops the running turn exactly like the
Stop button: queued agent messages are rejected ("Cancelled by Stop before queued
delivery") and parked approvals are denied. The result is
`{ "sessionId", "cancelled": true, "turnId" }` when a turn was stopped, or
`{ "cancelled": false, "reason": "idle" | "closing" | "relocating" }` when there
was nothing to stop. Idle is not an error. Needs only the Sessions API switch.
A `wait_for_result` on the stopped message then returns `done` with
`latestResult.terminalReason: "cancelled"`.

### `list_pending_approvals` and `answer_approval`

These need the session's **External approvals** switch (off by default, in the
tab's environment menu, shown only while the session is shared). Without it both
fail with `External approval is off for this session`.

`list_pending_approvals` (optional `sessionId`; omit it to list every approving
session) returns `{ "approvals": [...], "truncated": false }`. Each item is
`{ sessionId, approvalId, tool, description, presented, expiresInMs, answerable, childOf? }`.
`description` is a short, scrubbed, one-line summary (a command, a path, a URL
without its query, or a tool's argument names). It never includes file contents
or raw input. `presented` is true for the ask the user sees now. `answerable` is
false for `ExitPlanMode` and `AskUserQuestion`, which must be answered in AnyCode.

`answer_approval` takes `{ sessionId, approvalId, decision: "allow" | "deny" }`.
Its `status` is `answered`, `already_answered` (with `settledBy`: `ui`, `external`,
`timeout`, `turn_cancelled`, `disconnect` or `shutdown`), `not_found`, or
`not_answerable`. These are normal results, not errors. The first answer wins,
from the UI or from here. There is no "always allow" from outside AnyCode.

### `wait_for_result`

Request:

```json
{ "sessionId": "sess-7f3a", "messageId": "msg-0a1", "timeoutMs": 50000 }
```

Give exactly one of `messageId` or `correlationId`. With `correlationId`, the
server uses the newest message to that session with that correlation id.
`timeoutMs` is 1 to 120000 (default 30000). The call returns when the turn that
consumed the message reaches a terminal state, or when the timeout passes.

Done (the same shape as `get_session_result`, plus `status` and `messageId`):

```json
{
  "status": "done",
  "sessionId": "sess-7f3a",
  "messageId": "msg-0a1",
  "availability": "available",
  "activeTurnId": null,
  "latestResult": {
    "source": "live_turn",
    "turnId": "turn-92",
    "requestId": "req-13",
    "nativeTurnId": null,
    "terminalReason": "completed",
    "publicAnswer": "Lint passed.",
    "truncated": false,
    "completedAt": 1761400100000,
    "deliveredMessageIds": ["msg-0a1"],
    "correlationMeaning": "transport_delivery_only"
  },
  "limitation": "Latest completed public text block only. History recovery cannot establish terminal status or turn/message correlation. Completion does not prove a message was applied."
}
```

Pending (the timeout passed; call again with the same arguments):

```json
{ "status": "pending", "sessionId": "sess-7f3a", "messageId": "msg-0a1" }
```

Rejected (AnyCode did not deliver the message; this is a result, not an error):

```json
{ "status": "rejected", "sessionId": "sess-7f3a", "messageId": "msg-0a1", "detail": "Inbox full" }
```

Unknown (delivery cannot be confirmed; do not resend blindly):

```json
{ "status": "unknown", "sessionId": "sess-7f3a", "messageId": "msg-0a1", "detail": "Runtime restarted; no automatic replay to model" }
```

**Client timeout.** The MCP SDK's default request timeout is 60 seconds. Either
pass a request timeout longer than `timeoutMs`, or keep `timeoutMs` at or below
50000 and loop while `status` is `pending`. The server also cancels a wait when
the HTTP request closes.

## Delivery semantics

- `queued`: accepted and waiting for the session's next turn. A restart turns it
  into `unknown`.
- `acknowledged`: AnyCode handed the message to the session. It does **not** prove
  the model read or applied it. Use `wait_for_result` for the answer.
- `rejected`: not delivered (session closing, inbox full, steer while idle, and so
  on). Safe to report to the user; a new message with a new key may be sent.
- `unknown`: the outcome is uncertain, for example the host stopped mid-call. Do
  **not** blindly retry. A retry with the same `idempotencyKey` only returns the
  stored record; it never dispatches again.
- The ledger survives an app restart. Records that were in flight become `unknown`
  after a restart and are never replayed into the model. Rejected records stay
  rejected.

## Errors

Tool errors come back with `"isError": true` and this text:

| Text | Meaning and what the bridge should do |
|---|---|
| `Session unavailable or outside authorized workspace` | The session is unknown, not shared, or outside the allowed folders. The three cases give the same text on purpose. Treat the handle as gone; tell the user. |
| `External approval is off for this session` | `list_pending_approvals` or `answer_approval` on a session whose External approvals switch is off. Tell the user to switch it on in AnyCode (session menu), or to answer in AnyCode. Nothing was called on the host. |
| `Message unavailable` | No such message, or it belongs to another session. |
| `Message outside authorized workspace` | `get_message_status` for a message whose folder is no longer allowed. |
| `Idempotency key reused with different input` | Same key, different content. Use a new key for new content. |
| `Message ledger full; restart with a new discovery file after archiving ledger` | Ten thousand messages are stored. Stop sending and tell the user. |
| `Unknown tool` | The tool name is not one of the six. |
| `Too many waiters` | More than 32 concurrent `wait_for_result` calls. Back off and retry later. |
| `Session closed` | During a wait, the host stopped answering (session closed, app restarting, or no answer within 20 seconds). The outcome of the message is unknown; call `get_message_status`. |
| A JSON list of issues (for example `Provide messageId or correlationId`) | The arguments failed validation. Fix the request; do not retry as is. |

HTTP-level refusals (no JSON-RPC body):

| Status | Meaning |
|---|---|
| `400` | The body is not JSON, or the request could not be handled. |
| `401` | Missing or wrong bearer token. Re-read the discovery file (the token may have changed). |
| `403` | An `Origin` header was sent, or the path or `Host` is wrong. |
| `405` | Not a `POST`. |
| `413` | The body is larger than 64 KiB. |

## Recipe: bridge an external chat or form (generic)

The pattern works for any source that can be polled with a cursor. Replace the
three marked calls with your source's own API.

```text
cursor = load_cursor()                                   # persisted on disk
loop:
  events = external_poll(since = cursor, timeout = 50)   # long poll; returns [] on timeout
  for event in events:
    handle = route_to_handle(event.conversation)         # your mapping: conversation -> handle
    sessions = mcp.call("list_sessions")
    target = find(sessions, handle)                      # no match: reply "no session", skip
    if not target: external_reply(event, "no live session"); continue
    sent = mcp.call("send_message", {
      sessionId: target.sessionId, payload: event.text, mode: "next_turn",
      correlationId: event.id, idempotencyKey: event.id })
    loop_wait:
      r = mcp.call("wait_for_result", {sessionId, messageId: sent.envelope.messageId, timeoutMs: 50000})
      if r.status == "pending": continue loop_wait      # the client timeout stays above 50 s
      break
    external_reply(event, answer_for(r))                 # done: publicAnswer; rejected/unknown: say so
  cursor = events.last.id; save_cursor(cursor)
```

Rules that matter:

- Persist the cursor only after the replies for a batch are sent. A crash then
  repeats work, and `idempotencyKey` keeps the Sessions API from doing it twice.
- Use the external event id as both `correlationId` and `idempotencyKey`.
- `unknown` means "do not resend the same event as new". Report it instead.
- Re-read the discovery file when a call returns `401`. Reconnect the MCP client
  when the file's `url` changes.
- Keep the external credentials in the service's own store, never in the plugin
  manifest or the log.

## Example

[`examples/channel-echo/`](../../examples/channel-echo/) is a complete,
dependency-free channel: files in `inbox/` addressed as `<handle>__<anything>.txt`
become messages, and the answers land in `outbox/`. Copy it and replace the three
marked points (SOURCE, MAP, SINK). It installs from its folder through Settings →
Plugins → Install from folder.

A second reference, [`examples/telegram-remote/`](../../examples/telegram-remote/),
adds the secret store to the picture: its service reads `${secret:NAME}` from
Settings → MCP → Secrets and waits for a long poll, not a folder. It is named for
Telegram because it is one product, not a generic channel. A multi-machine hub
(one poller that routes to several bridges) is a possible future option only; it is
not designed here.

See also [Sessions API](../user/sessions-api.md) for the user's view and
[Agent communication](agent-communication.md) for the protocol details.
