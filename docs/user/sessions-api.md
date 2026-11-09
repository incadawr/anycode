# Sessions API

The Sessions API lets an external agent, such as Claude Code or Codex, list the
live AnyCode sessions you share with it, read their status and last answer, and
send them a message. It is a local MCP endpoint that runs while AnyCode is open.

## Worktree sessions

The parent header's **New session children in worktrees** switch also applies to
Core native `SessionOpen`, with the existing experimental gate unchanged. The
target must be the source checkout. Opened roots remain independent: parent close
does not close them; their own close triggers conservative cleanup. The new cwd
inherits neither folder trust nor peer grants; first-message delivery can be
rejected until access is granted. External HTTP `create_session` is outside this
feature because it has no trusted parent. See [worktree limitations and manual
recovery](subagents.md#session-children-in-worktrees). No automatic merge,
post-crash cleanup or managed-session resume is provided.

## Native session peers (experimental)

Native peer tools connect sessions inside AnyCode without configuring an HTTP
client or sharing a bearer token. They use the same delivery broker as the
HTTP Sessions API below, with separate access rules. They are experimental and
**on by default on macOS and Linux**. Start AnyCode with
`ANYCODE_NATIVE_SESSIONS_ENABLED=0` to turn them off. On Windows they stay off
until you start AnyCode with `ANYCODE_NATIVE_SESSIONS_ENABLED=1`.

A root is a top-level session, rather than a child or inline sub-agent. When
enabled, trusted roots in the same exact folder have native access by default,
subject to per-tab permissions. Claude and Codex roots can send messages and open
peers too, and can receive and answer them, under the rules below.
The tab's environment menu has **Native session access** to turn the project off
and **Allow communication** / **Revoke communication** for an explicit pair of
folders. Both folders must be trusted and enabled. Nested folders and sibling
worktrees need their own pair grant. Cross-folder opening
also needs **Allow agents to open tasks here** on the destination. File lookup
stays inside the caller's folder even with a pair grant.

**Enable local Sessions API**, per-tab sharing and **External approvals** control
HTTP access only. Native peers work with HTTP OFF, without a listening socket or
discovery token. HTTP ON, changing its port or regenerating its token does not
grant or revoke native access. Opening a native peer does not turn HTTP on or
force the new tab to be shared externally; the normal new-session default applies.

| Core tool | What it returns |
|---|---|
| `SessionsList` | Up to 20 accessible live root sessions by default (maximum 50): session/tab ids, workspace, engine, activity, addressability, optional title/model/effort and up to five recent paths in the caller's folder. `scope: "granted"` includes granted folders. Cursor pagination and `ownMessageId` queries currently return `unavailable`. |
| `WhoEdits` | Evidence for one exact path in the caller's workspace: successful Edit/Write/NotebookEdit reports (`reported_write`), shell candidates (`observed_during_shell`), observation start time, sampler coverage/freshness and limitations. It returns no file contents or command text. |
| `SessionSend` | A message id and delivery state, without waiting for the answer. Payloads are limited to 32,000 characters. Only `next_turn` works between sessions; `steer` returns `unavailable` with a reason and a hint to use `next_turn`. |
| `SessionOpen` | A new independent root's session/tab ids, optional label and first-message delivery receipt. Workspace and engine default to the caller's. Model/effort still pass creation checks. It does not create a child managed by `Agent`. |

Core roots can send/open in Build, Edit, Auto, `yolo` and Orchestrate, under
Core's permission checks. Build, Edit, Auto and Orchestrate ask a human for each
operation; ordinary `yolo` follows its allow policy. Plan without Orchestrate, unknown authority,
children and restricted callers cannot send/open. A resumed Orchestrate tab
regains peer access once its host reports its mode again, without being reopened.

Claude and Codex roots follow the same rules, taken from their permission preset:

| Root preset | Peer send/open |
|---|---|
| Claude **Ask**, **Workspace** | Allowed, with a human approval for each operation |
| Codex **Ask for approval**, **Approve for me** | Allowed, with a human approval for each operation (peer calls never go to automatic review) |
| Codex **Full access** | Allowed without a prompt, like Core `yolo` |
| Claude **Read-only**, Codex **Read-only** | Refused, like Plan |
| Unknown or older presets | Refused |

An Orchestrate root always asks for a human approval for each operation, even on
Codex **Full access**. A Claude or Codex root also holds no peer access while its
Orchestrate restore is running, or while a failed restore or Orchestrate switch
is unresolved (a verified recovery to Orchestrate off reopens access). A resumed Claude
session holds none until Claude has confirmed its permission mode, and none once its
recovered Orchestrate-off posture has drifted (its tools, MCP servers or permission
mode changed); reopen the conversation to recover.

A preset change that would widen access counts only after it has been applied;
narrowing counts immediately. A Claude or Codex root that receives a message can
answer it with `replyTo`, or the sender can ask for one `on_turn_end` result, the
same as for Core.

For replies, `SessionSend {"replyTo":"<received-message-id>","payload":"…"}`
derives the recipient and correlation from the original message; a supplied
correlation must match. If `replyTo` is omitted, the active receiving turn still
passes on its causal chain limits. The optional `reply` field has no default:
`"explicit"` and omission both create no automatic reply subscription and do not
tell the receiver that a reply is requested. Ask for a reply in the payload if
needed. Opt in with `reply: "on_turn_end"` to receive one public terminal result
for the turn that took the message. Its public answer is capped at 4,000
characters; reasoning, tool output and history are excluded. An accepted explicit
reply suppresses that automatic result. A reply starts a new request in the
sender's engine when its inbox drains, waiting if busy; the original tool call does not wait or poll for it.

Limits and uncertainty:

- Chains allow at most 8 hops and 32 messages within 30 minutes; exceeding them
  returns `refused` with `reason: "loop_limited"`. Sends, including replies,
  are limited to 20/minute per sender and 60/minute per workspace. Creation shares
  the HTTP budget of 5/minute and 8 live agent-opened tabs.
- `queued` is inbox admission; `acknowledged` is turn start, not proof the model
  applied the message. A Core steer is first `queued`; it becomes `acknowledged`
  with `deliveryKind: "core_seam"` once the message is inserted into the model
  input at a safe point of the running turn. That means inserted, never that the
  model read or followed it, and there is no separate "read" state. Poll
  `get_message_status` for the final state. Sessions that send to each other
  (`SessionSend`) cannot steer; use `next_turn`. A parent's `send_to` to a
  running child whose turn has not started yet is delivered as `next_turn` and
  reported with `deliveryKind: "next_turn"`. `rejected` means delivery was
  refused, for example because the inbox is full or authorization fails before
  drain. A steer that has not been inserted when the turn is stopped, closed or
  runs out of budget becomes `rejected` with the message id and a reason, and
  is not run later on its own; send it again as `next_turn` if it is still
  wanted. Stop can therefore reject steers that were still waiting. `unknown` can mean
  receipt/completion is unconfirmed, an open was rolled back before publication
  (with known session/tab ids), or an internal error was caught. Known ids alone
  do not prove a tab still exists. First-message delivery can be uncertain
  separately from opening. Do not blindly retry: check any available delivery
  state and returned ids, and resolve reported setup/access problems first.
  Inspecting tabs can help after an interrupted open but cannot explain every
  `unknown`. A stable `idempotencyKey` deduplicates identical sends from the same
  principal; changed input is refused. Opening is not idempotent.
- Restart restores cards, never model payloads or pending reply subscriptions.
  Settled delivery states survive; lost queued delivery and pending subscriptions
  can become unknown. There is no exactly-once execution guarantee across crashes.
- `WhoEdits` always reports overall coverage as `partial`. Records expire after
  30 minutes and can be evicted. Empty records do not mean nobody wrote the file.
  Bash attribution is incomplete: bounded metadata samples and overlapping shell
  windows identify candidates, never a proven author or file owner. Background
  processes, external editors, late events, excluded trees and stale/partial
  baselines can hide writes; MultiEdit is not indexed.
- Windows live behavior has not been verified. Native peers stay off
  by default on Windows; tool declarations and fixture coverage do not establish live support
  for every engine or platform.

`ListConnections` is separate and remains available without the peer flag. It
lists safe connection/model metadata and the current route. `current` identifies
an API connection for Core or a `native_cli` route for Claude/Codex, without
claiming the active API connection is the CLI's account. Optional provenance is
`selected`, `applied` or `unknown`. Readiness is last observed health, possibly
unknown or stale, rather than a live authentication check or a promise of admission.

## Tools

| Tool | What it does |
|---|---|
| `list_sessions` | Lists the shared sessions. No transcript or credentials. |
| `get_session_status` | Engine, activity state (including a network wait summary), the selected model and effort, the model's supported effort levels and whether an effort change is still pending. |
| `get_session_result` | Latest completed public answer and its turn identity. No reasoning. |
| `send_message` | Sends a message. `mode: next_turn` queues it for the next turn; `mode: steer` steers the running turn of a Core or Codex session. A Core steer returns `queued` at once and is inserted at the next safe point in the loop, so a long tool call finishes first. |
| `get_message_status` | Delivery state of a message you sent. |
| `wait_for_result` | Waits (up to 120 s per call) until the turn that took your message finishes, then returns its answer. Returns `pending` on timeout; call it again. |
| `cancel_turn` | Stops the running turn of a shared session, like the Stop button. Queued messages are rejected and parked approvals are denied. An idle session answers `cancelled: false`, which is not an error. |
| `list_agent_projects` | Lists the projects (folder paths) where you switched on **Allow agents to open tasks here**. Read-only discovery for `create_session`; answers an empty list in the legacy env-file mode. |
| `close_session` | Closes a shared tab opened by `create_session`; stop a running turn with `cancel_turn` first. |
| `create_session` | Opens a new tab in a project where you switched on **Allow agents to open tasks here**, optionally with a validated reasoning effort and — for a Codex session — a chosen Codex account. See "Let agents open tasks" below. |
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
4. Check the status line. It reads `Listening · 127.0.0.1:PORT · N shared` when
   the endpoint is up, where N is the number of shared sessions.

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
**Turn off** button for each; turning one on is only done in the sidebar.

Input: `workspace` (absolute path, required); optional `engine` (`core`,
`codex`, `claude`), `model`, `effort`, `fast`, `account`, `handle` and `firstMessage`.
`fast` is a boolean for Codex only: `true` enables Fast mode and `false` disables
it for this session. Fast mode is quicker but consumes usage limits faster.
The new session is shared immediately. An accepted `handle` becomes the tab
title: it replaces the title the first message would have produced and stays
fixed through automatic titling, closing the tab, restarting AnyCode and resuming
the session.

`create_session` does **not** wait for that title to be stored. It answers as
soon as the tab exists — the tab's process may still be starting, or may have
just been replaced — and the confirmed handle is written to the session store
afterwards: on the tab's next process generation, and every 5 seconds while the
tab lives, for at most 12 attempts in a row. After those 12 the tab stops
asking; the next process generation (a restart, or a respawned host) starts the
count again. Only a committed write is one a restart reads back. If every
attempt fails (for example the session store cannot be written), the tab keeps
showing the handle for this run and the next resume shows whatever title the
store holds.

Sessions an agent opened before this version kept the automatically generated
title in the session store while the handle was saved separately, so resuming one
replaced nothing and the tab came back titled from the first message. Resuming
such a session now rewrites the stored title from its saved handle, but the rule
is exactly this and nothing more: **only a stored title that begins with the raw
delivery header** (`[AnyCode authenticated agent message …`) is replaced, because
that is the one title text nobody chooses. Every other stored title is left
exactly as it is — a handle can also be assigned to an ordinary session from the
environment menu, and the title of a session whose handle you change later is not
the agent's to replace. (Every title a host confirms is also recorded, so a title
written after that confirmation is recognised as someone else's and left alone.)

Without a handle the title comes from the message payload, whose delivery wrapper
AnyCode strips first. `firstMessage` is delivered like `send_message` with
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
  runs. Either id the engine's own catalog carries is accepted — the short
  alias the CLI takes on the wire (`haiku`) and the full model id it reports
  (`claude-haiku-5-5`) name the same model. The new session is confirmed to be
  running that model before it is shared; a value the account does not offer is
  refused with `invalid_model` and the error text lists the ids it does offer.
  AnyCode never replaces it with the engine's default.

### Set the reasoning effort

`effort` sets the new session's reasoning effort for the whole session:

```json
{
  "workspace": "/path/to/project",
  "engine": "codex",
  "model": "gpt-6.1-terra",
  "effort": "xhigh",
  "firstMessage": "Reply with READY."
}
```

- The allowed values are **model-dependent**, so the schema declares a plain
  string and the engine's own list is the authority. A Codex model reports the
  levels its `model/list` entry advertises (which can include levels AnyCode
  itself does not use, such as `xhigh`, and future ones), Claude reports the
  levels its session catalog advertises, and for core the configured provider
  connection's model decides.
- The value must match one of those levels **exactly**: no surrounding spaces,
  no different case, no nearest-level substitution. A value that is not
  advertised, an empty or whitespace-only value, or a non-string is refused.
- The effort is configured **before** the tab is shared, before any handle is
  assigned and before `firstMessage` is delivered, so the very first turn runs
  at the effort you asked for.
- Omit `effort` to keep the engine's own default. The override applies to this
  session only; it never changes the connection's saved model settings, and it
  is not remembered for a later session.
- A model that advertises no effort levels at all refuses every explicit
  effort: nothing is silently downgraded to a default and reported as success.
- The chosen effort survives a turn. Selecting a new effort from the tab's own
  model menu still works as before; a Codex/Claude pick becomes effective on the
  next turn and the status shows it as pending until then.

Refusal example:

```text
create_session invalid_effort: reasoning effort is not supported — engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","medium","high","xhigh"]; reason=not_advertised
```

The code is always `invalid_effort`, and the text names the engine, the selected
model, the requested value and the complete allowed list, so a client can retry
with a value from that list. `reason` is one of `invalid_type` (not a non-empty
string), `no_supported_levels` (the model advertises none) or `not_advertised`
(the value is not in the list). A session whose effort could not be confirmed in
time is refused with `not_ready` instead, and no tab is left behind.

### Session status

`list_sessions` and `get_session_status` report the same activity state: `idle`,
`running`, `waiting_approval` (including queued human interaction),
`waiting_network` (a provider request is waiting for the network or provider to
come back), or `closing`. When several states apply, the order is `closing`, then
`waiting_approval`, then `waiting_network`, then `running`, then `idle`; an
approval can therefore be reported while a network wait is still active. A
pending approval is reported even when External approvals is off. Terminal
sessions report `crash_looped` or `missing_workspace`. Listing reads the latest
activity known to the application without waiting for hosts, including while a
host restarts. Clients should accept the full state vocabulary.

While a session is waiting on the network, both tools add a `networkWait`
summary. If several requests wait at once (the session itself and its
subagents), the summary describes the earliest one that is still active; it
disappears when the last wait ends. All timestamps are epoch milliseconds.

```json
{
  "state": "waiting_network",
  "networkWait": {
    "source": "subagent",
    "startedAt": 1767225600000,
    "deadlineAt": 1767227400000,
    "failureCode": "network"
  }
}
```

| Field | Meaning |
|---|---|
| `networkWait.source` | `parent` for the session's own request, `subagent` for a subagent's. |
| `networkWait.startedAt` | When that wait began. Omitted when the producer did not report it. |
| `networkWait.deadlineAt` | When the wait gives up, projected from the time the session still has left to wait (the allowance is cumulative), not a fresh full allowance per episode. Omitted when unknown. |
| `networkWait.failureCode` | A safe failure category such as `network`, `tls`, `proxy_unreachable` or `rate_limited`; never provider text. Omitted when unknown. |
| `turnStartedAt` | When the running turn started, or `null` when no turn is active. |
| `lastProviderActivityAt` | When the model last produced output or completed a step in this turn, or `null` before the first one and for engines that give no reliable signal. Retries, network checks, tool execution and message delivery do not move it. `list_sessions` repeats these two values from the application's last known activity (published when a turn starts, when a wait or approval changes, and when a turn ends), so they are last-known values that can briefly lag `get_session_status`. |

These are observations, not guarantees: a timestamp does not prove that the
provider or the model read or applied anything, and a missing `networkWait` does
not prove the network is healthy. Retrying early is not available through this
API; the Retry now button in the session's own window is unchanged.

`get_session_status` also answers the engine and these effort fields:

| Field | Meaning |
|---|---|
| `model` | The model selected for the next turn. |
| `effort` | The effort selected for the next turn, or `null` when the session has not reported one. |
| `supportedEfforts` | The selected model's own advertised levels, in the engine's order. Empty means the model advertises none, so no explicit effort can be set. |
| `appliedEffort` | The effort the current applied setting actually carries, or `null`. |
| `effortPending` | `true` while the selected pair differs from the applied pair — a chosen effort that a Codex or Claude session has not applied yet. |

A model default is never invented: `null` means "unknown or absent", not
"the model's default".

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
  signed in, or the tab limit is reached, or the new session could not confirm
  its model or effort), `invalid_model` (`model` does not select exactly one
  provider connection for `core`, or is a model the engine's account does not
  offer; the text lists the candidates), `invalid_effort` (the requested
  effort is not one the selected model advertises; the text lists the allowed
  values), `invalid_account` (the requested Codex account names no configured
  account, or a label two accounts share; the text lists the candidates),
  `invalid_argument` (an argument is unsupported, for example `fast` with an
  engine other than Codex).
- `account` (optional, `engine: "codex"` only) picks the Codex account the new
  session runs on: a profile id or its label from **Settings → Codex**. Omit it
  to start on the account marked **Default** there; an unknown or ambiguous
  value is refused `invalid_account` instead of guessing, because the choice
  decides whose subscription is spent. Sending `account` with any other engine
  is refused `invalid_account` too — there is no Codex account to select there.
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
so the config keeps working after an app update; that copy is refreshed on every
app start, so an update never leaves an outdated adapter behind. The client
needs **Node 22+**.

## Token and discovery file

- The token is generated when the server starts. It is never shown in Settings,
  never written to `settings.json`, and never logged.
- The discovery file is `communication.json` under the AnyCode user-data
  directory. It holds the URL, the token and the folder list, with mode `0600`.
  Keep it private.
- **Regenerate token** writes a new token to the discovery file. A running
  stdio adapter re-reads the discovery file before every call, so a restarted
  app (new port and new token) is reached without reconnecting the client and a
  regenerated token is used on the first attempt. If a connection is refused
  (`ECONNREFUSED`), the adapter re-reads discovery and retries once. An HTTP
  `401` also triggers one discovery refresh and retry. Ambiguous network errors
  are reported without retry because the request may already have been
  processed; a later call picks up the new endpoint.

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
   model has read or applied it.
4. `wait_for_result` defaults to 30 seconds on the server and accepts at most
   120 seconds. Call `wait_for_result` with the same `sessionId` and `messageId` to get the
   answer. Give a request timeout longer than `timeoutMs` in your MCP client
   (its default is 60 seconds), or keep `timeoutMs` at 50000 or less and call
   again while the status is `pending`.

Services that bridge an outside channel use the same tools. See the
[channel plugin guide](https://github.com/incadawr/anycode/blob/master/docs/development/channel-plugins.md).

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
| `create_session` says `invalid_model` | For `core`, the `model` value matches no configured provider connection, or more than one; retry with a connection id, its label, `<providerId>/<model>`, or omit `model`. For `codex`/`claude`, the account does not offer that model; retry with one of the ids the error lists, or omit `model`. |
| `create_session` says `invalid_effort` | The selected model does not advertise that effort. The error lists the allowed values for that engine and model; retry with one of them, or omit `effort` to use the engine default. |
| `create_session` says `invalid_account` | The `account` value names no configured Codex account, a label two accounts share, or it was sent for an engine other than `codex`. The error lists the accounts as `label (id)`; retry with the id, omit `account` to use the default, or drop it for a non-Codex session. |
| Copy buttons are disabled | The endpoint is not listening. Fix the status first. |
| Copied config says the adapter was not found | This build does not include the adapter. Install an official build. |
| `401` after you regenerate the token | Check that the discovery file is private and current, then retry the call or restart the MCP connection. |
| Settings pane is read-only | `ANYCODE_COMMUNICATION_CONFIG` is set. Unset it and restart AnyCode to use Settings. |

See also [configuration.md](configuration.md) and
[troubleshooting.md](troubleshooting.md).

When a session host stops after repeated failures, `get_session_status` returns `state: "crash_looped"`, its engine, and a safe `hostFailure` summary without model or effort details. `list_sessions` reports the same state and includes the same summary.

When the workspace folder is missing and the session passes the authorized-workspace check, `get_session_status` returns `state: "missing_workspace"`, its engine, and `missingWorkspace: true`, without model or effort details; a retained `hostFailure` summary may also be present. `list_sessions` reports the same state and retains `missingWorkspace: true`. With a restricted workspace list, a missing folder is refused as unavailable or outside the authorized workspace.
