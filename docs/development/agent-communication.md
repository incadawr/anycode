# Communicating with live AnyCode sessions

The unreleased TASK.242/TASK.239 implementation can expose a production MCP endpoint while its desktop runtime is open.
It is separate from developer automation/CDP and disabled by default. This first
slice is GUI-backed: it neither starts a headless daemon nor creates agents.

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
the native Codex bridge currently exposes only `anycode_agent`, and native Claude
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
   delivery. Call `get_session_result` with `sessionId` to retrieve the latest
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
changed input is an error. Restart retains this deduplication record, but marks
non-rejected delivery unknown. Acceptance is durably recorded before dispatch.
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
resumes its model when work completes. This slice provides explicit status
queries and GUI delivery; automatic client wake-up, result subscriptions,
`start_agent`, remote access and shared GUI/headless service ownership are later
work. It never executes arbitrary shell commands or exports credentials.
