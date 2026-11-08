# Communicating with live AnyCode sessions

AnyCode 0.0.31 and later can expose a production MCP endpoint while its desktop runtime is open.
Users enable it in Settings → Sessions API and share sessions one by one (see
[docs/user/sessions-api.md](../user/sessions-api.md)); the environment variable below still overrides those settings.
It is separate from developer automation/CDP and disabled by default. The endpoint is GUI-backed and does not start a headless daemon.

Create a JSON configuration outside the repository, for example:

```json
{
  "workspaces": ["/absolute/path/to/project"],
  "port": 0,
  "discoveryFile": "/absolute/private/directory/communication.json"
}
```

Launch AnyCode with `ANYCODE_COMMUNICATION_CONFIG=/absolute/path/to/config.json`.
The configuration is available in production builds as well as development.
An explicit, exact workspace allowlist is required. Symlinks are resolved;
subdirectories and unrelated workspaces are not implicitly authorized. A session
that relocates into a worktree outside the allowlist becomes unavailable until
that path is explicitly allowed in a subsequent launch.

AnyCode binds only `127.0.0.1`, chooses a free port when `port` is zero, and writes
`{url, token, workspaces}` to the discovery file with mode `0600`. Its parent
folder should be private. The file defaults to `communication.json` under the
AnyCode user-data directory. A new token is generated each launch. Closing
AnyCode removes discovery; disable the environment setting and restart to revoke
access. The token is never printed in logs. Treat the discovery file as a local
credential: every holder represents the same `authenticated-local-supervisor`
principal and receives the configured workspace scope. This slice does not offer
per-client credentials, arbitrary sender identities, remote binding, TLS or OAuth.
Browser Origin headers are rejected, including localhost browser applications.

Use an MCP client supporting Streamable HTTP with URL from discovery and an
`Authorization: Bearer <token>` header. Clients that only support stdio can use
the portable Node 22+ adapter in `examples/agent-communication/stdio.mjs`:

```json
{
  "mcpServers": {
    "anycode-sessions": {
      "command": "node",
      "args": ["/absolute/path/to/stdio.mjs", "/absolute/private/directory/communication.json"]
    }
  }
}
```

The adapter reads the private file itself; no token is embedded in command
arguments or client configuration. `examples/agent-communication` also contains
the existing AnyCode `.anycode-plugin/plugin.json` format. Copy that directory to
an AnyCode plugin discovery directory and edit only the discovery-file argument;
the loader uses the plugin directory as the server's working directory, making
`stdio.mjs` relocatable. No second plugin format or external CLI runtime is
introduced. AnyCode's plugin MCP tools are loaded into the **Core** tool registry;
the native Codex bridge exposes `anycode_agent` plus the `anycode_browser_*` tools
and native Claude
also bypasses that Core plugin registry. To use this endpoint from an external
Codex or Claude client, configure the stdio adapter or HTTP endpoint in that
client's own MCP settings. Loading this AnyCode plugin does not add its tools to
AnyCode's native Codex/Claude engines. The endpoint must be enabled in the target AnyCode runtime; loading
the plugin alone cannot enable it.

A supervisor can perform this sequence:

1. Call `list_sessions` to obtain allowed session IDs, workspace and `childOf`.
   The listed `state` is the **host process** lifecycle, not model activity.
2. Call `get_session_status` with `sessionId`. Its `state` is `idle`, `running`
   or `closing`, and `engine` identifies the executor. For Codex, inspect
   `steering.ready` and `steering.nativeTurnId`: a session can be running while
   still waiting for `turn/start` to return, before it is ready to steer.
3. Call `send_message` with `sessionId`, `payload`, `mode` and an optional stable
   `idempotencyKey`. Use `next_turn` to queue while busy, or `steer` for a live
   Codex turn. `kind` can be `agent_message` or `task_result`; optional
   `correlationId` and `replyTo` link work and replies.
4. Retain the returned `envelope.messageId`; use `get_message_status` to read
   delivery. Call `wait_for_result` with `sessionId` and `messageId` (or a
   `correlationId`) to long-poll until the turn that took the message finishes.
   Call `get_session_result` with `sessionId` to retrieve the latest
   public assistant answer and terminal/turn identity. The receiving GUI also
   shows the message card and response. This API exports neither private
   reasoning nor the session transcript.

`get_session_result` returns `availability: pending` while the session is busy,
`available` after an observed live terminal event, `unavailable` when no public
result exists, or `recovered_unverified` when public assistant text was recovered
from persisted history. `latestResult` contains only the last completed public
assistant text block (capped at 32,000 characters), its terminal reason,
host request/turn ID and native Codex turn ID when observed. It excludes reasoning,
tool input/output, earlier commentary and the rest of the transcript.
`deliveredMessageIds` correlates transport delivery with that turn; neither
completion nor this correlation proves that a clarification was applied. History
recovery has unknown terminal status and no invented turn/message correlation.
While another turn runs, `latestResult` can still refer to the previous result.
Cancelled/error/budget terminals retain their explicit reason, even if public
text was emitted; they are not reported as successful task completion.

Example `send_message` arguments:

```json
{
  "sessionId": "id-from-list-sessions",
  "payload": "Keep the running GLM task alive; check the result against the revised requirement.",
  "mode": "steer",
  "idempotencyKey": "requirement-revision-1",
  "correlationId": "task-42"
}
```

The runtime assigns the envelope's source and recipient; client-supplied role,
source or unknown fields are rejected. The GUI uses a distinct **Agent message**
card with the source, recipient, content and delivery state. The endpoint stores
its envelope ledger in a private `.messages` file alongside discovery and
rehydrates cards after host or renderer restart. This ledger contains message
payloads and should be protected like conversation history. Codex and Claude
accept user-shaped text transport with an explicit authenticated agent envelope;
this is not a native agent-role claim. Core receives `origin: system` metadata
for host-injected input, while the model-facing message remains user-shaped.

Delivery states have deliberately limited meanings:

- `queued`: admitted into the host's bounded next-turn inbox. It has not started
  a model turn. Busy GLM/Core and Claude support this mode, not mid-generation
  steering. The host opens the next turn after the current one settles; child
  completion waits for queued turns, including arrivals during durable flush.
- `acknowledged`: for `steer`, the owned Codex app-server accepted input for the
  expected native turn ID; for `next_turn`, the host started the new turn.
  Neither proves that the model has already applied the message.
- `rejected`: a known refusal such as unsupported steering, no active native
  turn, stale expected turn, full inbox, wrong recipient or session closing.
  There is no silent fallback from steering into a new turn.
- `unknown`: transport/disconnect uncertainty, or a runtime restart. Do not
  blindly resend; the message may already have reached the model. Restart
  never automatically replays payloads into model context. The ledger retains
  the envelope and honest uncertainty for inspection.

Use a stable `idempotencyKey` for retries of the same payload. Reusing it with
changed input is an error. Restart retains this deduplication record and settled
delivery states; a lost host generation can make queued delivery unknown.
Acceptance is durably recorded before dispatch.
The in-memory host inbox is bounded to 32 messages and the durable endpoint
ledger to 10,000; archive the ledger with the runtime stopped when it fills.

In the Codex composer, **Steer** sends a text clarification to the current turn,
**Queue** waits for a separate turn, and **Stop** cancels the current operation and rejects pending agent inbox messages.
The developer automation `POST /prompt/steer` accepts `{tabId,text}` and returns
its submission request ID; this is GUI submission, not app-server delivery.
Use the displayed delivery card or production MCP status for native acceptance.
Steering does not invoke Stop or cancel the pending `anycode_agent`/GLM child.
Application timing during a pending tool call depends on Codex; an app-server
acknowledgement alone does not prove immediate application. A failed native-turn
race remains a visible refusal, never an implicit restart or duplicate send.

MCP tool responses/notifications do not guarantee that every external client
resumes its model when work completes. The HTTP API provides explicit status
queries and GUI delivery. Its external clients have no automatic wake
subscription. Native peer replies below use the host inbox instead. Remote
access and a shared GUI/headless service are not provided. The endpoint never
executes arbitrary shell commands or exports credentials.

Inside a session's own tools, `ANYCODE_SESSION_ID` holds the same value as the
`sessionId` field here (see [Environment of tools](../user/configuration.md#environment-of-tools)).

## Native peer architecture (experimental)

The experimental native sessions flag is off by default; only a development
build started with `ANYCODE_NATIVE_SESSIONS_ENABLED=1` enables it. Main supplies
an explicit host capability. Core uses `SessionsList`, `SessionOpen`,
`SessionSend`, `WhoEdits`; Codex declares `anycode_sessions_list`,
`anycode_session_open`, `anycode_session_send`, `anycode_who_edits`; Claude uses
the corresponding `mcp__anycode__` names. Declaration is not authorization.
See [native session peers](../user/sessions-api.md#native-session-peers-experimental)
for response fields and current limits.

An app-owned broker serves both the HTTP supervisor and the host-to-main peer
port. Native requests never use discovery credentials or TCP. The shared private
ledger is `communication.json.messages` in user data, or the legacy discovery
path with `.messages` appended. HTTP OFF, rebind and token rotation leave the
native broker alive. Both entrances share durable acceptance before dispatch,
bounded storage and card reconciliation, with different authority policies.

Main binds a session principal (`sessionId`, `tabId`) to its current host process
and generation, rather than accepting identity from tool input. Idempotency is
namespaced by principal. Sender titles are display data. The persisted ledger
contains payloads, principal, delivery, chain and subscription metadata; protect
it like conversation history. Incoming/outgoing cards restore for display only.
A live identity link is derived from structured principal data, not wrapper text.

Access requires live, trusted, unrestricted roots with exact canonical workspace
keys. Each operation checks the feature and project switches. Different folders
need an explicit symmetric pair grant; common Git ancestry grants nothing.
Cross-folder open also requires the destination's allow-open switch. Pair grants
do not authorize foreign file lookup, transcripts, approvals, cancellation or
closing tabs. Corrupt/unreadable policy storage at startup closes access until
the app restarts, even if the file is repaired in the meantime; policy changes
also fail until restart. A failed save keeps the previous policy.

Mutation authority is per tab. Main accepts Core roots with host-reported Build,
Edit, Auto or `yolo` authority, or reported Orchestrate ON. Core's dispatcher
asks a human before each send/open in Build, Edit, Auto and Orchestrate; ordinary
`yolo` follows its allow policy. A human approval is for that operation and
cannot replace scope/trust checks. Plan without Orchestrate, unknown modes,
children and restricted callers are refused. Claude/Codex roots report authority
derived from their applied permission preset (the narrower of applied and pending);
their displayed Build mode is never used. Claude Ask/Workspace and Codex Ask for
approval/Approve for me map to Build, Codex Full access maps to `yolo`, and
Read-only, unknown or older presets map to Plan. The native bridge asks a human for
each send/open in Build and never routes peer calls to automatic review. Host
replacement clears reported authority. A resumed Orchestrate tab regains peer
access once the host re-reports its mode/Orchestrate state.

Before draining a queued peer message, main checks current scope, trust, grant,
process/generation and chain lifetime again. A host-generated nonce binds a
single-use drain permit to that message, recipient and generation. Revocation
before drain prevents a new turn; it cannot undo a turn already started.

Explicit replies validate membership in the original ledger record and derive
the target/correlation. An optional `on_turn_end` subscription observes the
terminal of the exact receiving turn. Authenticated turn events carry process
generation, monotonic sequence and delivered message ids; an unrelated latest
answer cannot satisfy the subscription. A reply drains through the existing
inbox into a **new native engine request** (or a Core turn), immediately if idle
or after the current turn. No original tool wait or model polling is needed.
The automatic result carries terminal reason and bounded public answer, including
error/cancel/null outcomes, without reasoning or tool output. An accepted explicit
reply suppresses the automatic one; auto results do not subscribe to more results.

When `replyTo` is omitted, main inherits causal chain limits from the active
receiving turn, even with changed correlation input. An explicit `replyTo` derives
target and correlation from the original record; conflicting correlation input
is refused.
Chains are bounded to 8 hops, 32 messages and 30 minutes; self-send is refused.
Sender/workspace send rates include replies; opens share the HTTP creation
budget. Pending subscriptions become unknown on lost runtime custody; restart
never replays payloads or attaches them to a later turn. Durable deduplication
does not promise exactly-once model execution after a crash.

File activity is bounded metadata evidence, not a lock or OS audit. Successful
supported tool pairs produce `reported_write`; sampled changes during Bash
windows produce candidate evidence only. Overall coverage stays partial, even
when an individual sampler pass is complete. Background writes, late events,
capacity limits and excluded trees make shell attribution incomplete. Windows
live behavior remains unverified.
