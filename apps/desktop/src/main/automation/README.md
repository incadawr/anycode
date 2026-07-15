# Automation channel (Claude-smoke)

A **dev-only** HTTP-loopback control channel that lets an external driver (a
script, or an agent like Claude) run the desktop app end-to-end **without a
human at the window** — send prompts, read the rendered state, approve/deny
permission modals, switch mode, manage tabs. It drives the **same**
`UiToHostMessage` path and the **same** `IpcPermissionBroker` the real UI uses
(via the renderer facade `window.__anycodeAutomation`), so a smoke run exercises
real wiring, not a bypass.

## Safety (why it can't ship)

Off **by default**. It only starts under a double gate:

```
process.env.ANYCODE_AUTOMATION === "1"   AND   !app.isPackaged
```

A normal or packaged launch never even loads `server.ts` (lazy dynamic import),
and the renderer facade is stripped from the production bundle by the
`import.meta.env.DEV` gate. On top of that: binds **127.0.0.1 only** (+ destroys
any non-loopback peer), a fresh 256-bit **Bearer token** per launch checked with
`timingSafeEqual` on **every** route, a `~/.anycode/automation.json` discovery
file at mode **0600**, no CORS, and a 256 KB body cap.

## Enabling

```bash
ANYCODE_AUTOMATION=1 \
ANYCODE_WORKSPACE=/path/to/smoke-ws \
ANYCODE_API_KEY=<key> ANYCODE_MODEL=<model> ANYCODE_BASE_URL=<base> \
pnpm --filter @anycode/desktop dev
```

Optional fixed port: `ANYCODE_AUTOMATION_PORT=<port>` (otherwise ephemeral).

> Running `dev` from a fresh git worktree without the Electron binary downloaded?
> Point it at an installed one: `ELECTRON_EXEC_PATH=/…/electron/dist/Electron.app/Contents/MacOS/Electron`.

## Per-run profile isolation (design/slice-P7.H-cut.md)

Two more dev-only levers, both gated behind `ANYCODE_AUTOMATION==="1" &&
!app.isPackaged` (fail-closed for a packaged build; silently ignored if
malformed — the app boots regardless):

- `ANYCODE_USER_DATA_DIR=<absolute dir>` — repoints Electron's `userData`
  (localStorage, session data, the Chromium singleton lock) to a disposable
  directory. Applied at `main/index.ts` module top level, before
  `app.whenReady()` (Electron decides the profile partition at ready time).
  A relative path is refused with one `console.warn`; a normal dev launch
  with the var unset is byte-identical to before.
- `ANYCODE_AUTOMATION_INFO=<absolute file path>` — repoints the discovery
  file (default `~/.anycode/automation.json`), so two isolated instances
  (e.g. two smoke runs, or a smoke run alongside a manual dev session) never
  overwrite each other's discovery file.

Combined with the existing `ANYCODE_DB_PATH` (per-run SQLite DB, already
respected by main and every forked host), a smoke script can give each run a
fully disposable identity — see `scripts/sidebar-ui-smoke.mjs` and
`scripts/git-ui-smoke.mjs` for the reference wiring. `--attach` mode
deliberately does NOT set any of these: attaching means reusing a foreign
instance's default profile, not creating an isolated one.

## Discovery + auth

On start the server writes `~/.anycode/automation.json` (0600):

```json
{ "pid": 12345, "port": 8317, "token": "…", "startedAt": 1720000000000 }
```

Read `port` + `token` from it (and verify `pid` is alive — stale-file guard).
Every request needs `Authorization: Bearer <token>`; JSON in/out; 256 KB cap.

```bash
PORT=$(jq -r .port ~/.anycode/automation.json)
TOKEN=$(jq -r .token ~/.anycode/automation.json)
AUTH=(-H "Authorization: Bearer $TOKEN"); B=http://127.0.0.1:$PORT
curl -s "${AUTH[@]}" $B/health   # {"ok":true,"pid":…,"version":"…","tabs":1}
```

## Routes

All require `Authorization: Bearer <token>`. Non-loopback peers are dropped;
missing/bad token → `401`.

### Read plane

| Method / path | Returns |
|---|---|
| `GET /health` | `{ok, pid, version, tabs}` |
| `GET /state?tail=N` | `{snapshot:{tabs, activeTabId, states}, tabs:[{tabId, workspace, sessionId, state, pid}]}` — `tail` slices each transcript to the last N blocks |
| `GET /state/:tabId?tail=N` | same, narrowed to one tab |
| `GET /sessions` | `SessionSummary[]` |
| `GET /screenshot` | `{png:"<base64>"}` — window capture (evidence / calibration) |
| `GET /transcript/scroll?tabId=` | `{ok:true, scrollTop, scrollHeight, clientHeight, atBottom, jumpVisible}` \| `{ok:false, reason}` — see below |
| `GET /tabs/:tabId/todo-panel` | `{ok:true, visible, header, panelCollapsed, completedRow, items:[{glyph, content}]}` \| `{ok:false, reason}` — see below |
| `GET /tabs/:tabId/agent-card/:toolCallId` | `{ok:true, expanded, promptCollapsed, feedRowCount, resultRendered}` \| `{ok:false, reason}` — see below |

### Action plane

`ok:false` results carry a `reason` (e.g. `unknown_tab`, `not_ready`, `busy`,
`no_pending_request`, `requestId_mismatch`, `invalid_mode`).

| Method / path | Body | Returns |
|---|---|---|
| `POST /tabs/:tabId/prompt` | `{text}` | `{ok:true, requestId}` |
| `POST /tabs/:tabId/permission` | `{behavior:"allow"\|"deny", requestId?}` | `{ok:true}` |
| `POST /tabs/:tabId/mode` | `{mode}` | `{ok:true}` |
| `POST /tabs/:tabId/stop` | `{}` | `{ok:true}` |
| `POST /tabs/:tabId/retry` | `{}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"\|"no_retry_offer"}` — clicks the one-shot Try-again offer (TASK.33 W8) by calling `dispatchTryAgain` directly (a facade shortcut, NOT a DOM click — see the try-again-button probe/driver below for that); `GET /state`'s per-tab `retryOffer` (null when nothing is offered) mirrors the store's `retry` field |
| `POST /tabs/:tabId/select` | `{}` | `{ok:true}` |
| `POST /tabs/:tabId/close` | `{}` | `{ok:true}` |
| `POST /tabs` | `{kind:"new", workspace}` | `{ok:true, tabId, sessionId, workspace}` (bypasses the native open dialog) |
| `POST /tabs` | `{kind:"resume", sessionId}` | `{ok:true, tabId, workspace}` |
| `POST /wait` | `{tabId, until:{connection?, turnStatus?, permissionPending?, transcriptIncludes?, gitStatusKnown?, gitPendingEmpty?}, timeoutMs?}` | `{matched, elapsedMs, state}` — polls every 150 ms; default 60 s, cap 300 s |
| `POST /quit` | `{}` | `{ok:true}` — graceful shutdown (kills hosts, unlinks discovery file) |

### Git routes (slice 5.8-R8)

Git rides the same read plane as everything else — no new read routes: `git`
is a field on the `GET /state[/:tabId]` snapshot, and `POST /wait` gained
`gitStatusKnown`/`gitPendingEmpty` predicates (absence of `git` in a pre-R8
snapshot reads as `statusKnown:false` / `pendingEmpty:true`). The action plane
gets six thin routes mirroring the git UI's own action paths one-for-one
(panel toggle, view tab, non-destructive dispatch, two-step destructive
confirm). `{command}`/`{intent}` bodies reuse the **same** zod schema the host
validates `git_command` messages with — nothing that fails to parse there can
reach the facade here.

| Method / path | Body | Returns |
|---|---|---|
| `POST /tabs/:tabId/git` | `{command: GitCommand}` | `{ok:true, requestId}` \| `{ok:false, reason}` |
| `POST /tabs/:tabId/git/confirm` | `{intent: GitDestructiveIntent}` | `{ok:true}` \| `{ok:false, reason}` |
| `POST /tabs/:tabId/git/confirm/accept` | `{}` | `{ok:true, requestId}` \| `{ok:false, reason}` |
| `POST /tabs/:tabId/git/confirm/cancel` | `{}` | `{ok:true}` |
| `POST /tabs/:tabId/git/panel` | `{open: boolean}` | `{ok:true}` \| `{ok:false, reason}` |
| `POST /tabs/:tabId/git/view` | `{view: "changes"\|"history"\|"diff"}` | `{ok:true}` \| `{ok:false, reason}` |

A schema-valid destructive command sent straight to `POST /tabs/:tabId/git`
(e.g. `{op:"reset", mode:"hard", confirmed:true}`) parses fine but is refused
by the facade itself with `{ok:false, reason:"destructive_requires_confirm"}`
— the two-step confirm/accept path is the only way to actually run one; the
server does not special-case this, the facade is the sole authority.

Status codes: `200` ok · `400` bad JSON/shape/tail · `401` no/bad token ·
`404` unknown route · `413` body > 256 KB · `503` `facade_unavailable`
(no facade / dead page) · `500` `facade_error`/internal.

## Example: one smoke cycle (prompt → permission → disk)

```bash
PORT=$(jq -r .port ~/.anycode/automation.json)
TOKEN=$(jq -r .token ~/.anycode/automation.json)
A=(-s -H "Authorization: Bearer $TOKEN"); B=http://127.0.0.1:$PORT
J=(-H 'content-type: application/json')
TAB=$(curl "${A[@]}" "$B/state?tail=0" | jq -r '.tabs[0].tabId')

# wait for the host to connect
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"connection\":\"ready\"}}"

# send a prompt, wait for the permission modal, allow it
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/prompt \
  -d '{"text":"Create hello.txt containing: smoke ok"}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"permissionPending\":true}}"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/permission -d '{"behavior":"allow"}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"turnStatus\":\"idle\"}}"

# teardown
curl "${A[@]}" "${J[@]}" -X POST $B/quit -d '{}'
```

## Example: one git cycle (stage → commit → discard-with-confirm)

```bash
PORT=$(jq -r .port ~/.anycode/automation.json)
TOKEN=$(jq -r .token ~/.anycode/automation.json)
A=(-s -H "Authorization: Bearer $TOKEN"); B=http://127.0.0.1:$PORT
J=(-H 'content-type: application/json')
TAB=$(curl "${A[@]}" "$B/state?tail=0" | jq -r '.tabs[0].tabId')

# wait for the pill to know the repo's status, open the panel
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"gitStatusKnown\":true}}"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/git/panel -d '{"open":true}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"gitPendingEmpty\":true}}"

# stage + commit
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/git \
  -d '{"command":{"op":"stage","paths":["a.txt"]}}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"gitPendingEmpty\":true}}"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/git \
  -d '{"command":{"op":"commit","message":"smoke commit"}}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait \
  -d "{\"tabId\":\"$TAB\",\"until\":{\"gitPendingEmpty\":true}}"

# a destructive op is two-step: stage the intent, then either accept or cancel
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/git/confirm \
  -d '{"intent":{"op":"discard","paths":["a.txt"]}}'
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/git/confirm/accept -d '{}'
```

For a full end-to-end live run against a real temp git workspace (panel/view
effects, staged diff truncation, discard-with-disk-assertion, the destructive
bypass probe) see `apps/desktop/scripts/git-ui-smoke.mjs`.

### Transcript sticky-follow routes (slice-P7.3)

Scroll state is DOM-only (never lands in `SnapshotJson`), so this is the sole
probe for F17's sticky-follow behavior. `atBottom` is computed with the exact
same `isAtBottom` predicate `MessageList.tsx`'s own `onScroll` handler uses —
the probe cannot drift from the product behavior it verifies. Both routes
refuse `tabId !== activeTabId` (`reason:"tab_not_active"` — only the active
tab's transcript DOM exists) and a missing `.message-list` element
(`reason:"no_transcript"`).

| Method / path | Body | Returns |
|---|---|---|
| `GET /transcript/scroll?tabId=` | — | `{ok:true, scrollTop, scrollHeight, clientHeight, atBottom, jumpVisible}` \| `{ok:false, reason}` |
| `POST /transcript/scroll` | `{tabId, to:"top"\|"bottom"}` | `{ok:true}` \| `{ok:false, reason}` |

`POST /transcript/scroll` assigns the real `.message-list` element's
`scrollTop` (0 for `"top"`, `scrollHeight` for `"bottom"`) — a genuine DOM
property write, so it fires the container's actual `scroll` event and
exercises the product's follow-pause/resume recompute, not a re-implementation
of it.

```bash
PORT=$(jq -r .port ~/.anycode/automation.json)
TOKEN=$(jq -r .token ~/.anycode/automation.json)
A=(-s -H "Authorization: Bearer $TOKEN"); B=http://127.0.0.1:$PORT
J=(-H 'content-type: application/json')
TAB=$(curl "${A[@]}" "$B/state?tail=0" | jq -r '.tabs[0].tabId')

curl "${A[@]}" "$B/transcript/scroll?tabId=$TAB"
curl "${A[@]}" "${J[@]}" -X POST $B/transcript/scroll -d "{\"tabId\":\"$TAB\",\"to\":\"top\"}"
```

### Todo panel probe (slice-P7.11 F1b, W2)

Read-only DOM probe for the perpetual todo progress panel (`TodoPanel.tsx`) —
no new `SnapshotJson` field, same discipline as the transcript-scroll probe
above. `ok:false` refuses `tab_not_active` / `no_transcript` exactly like
`GET /transcript/scroll`; `ok:true, visible:false` (header/completedRow `null`,
`items:[]`) is a normal reading, not an error — it just means no completed
`TodoWrite` has landed in the transcript yet (or the last one's list is
empty), same as the panel itself rendering nothing.

| Method / path | Returns |
|---|---|
| `GET /tabs/:tabId/todo-panel` | `{ok:true, visible, header, panelCollapsed, completedRow, items:[{glyph:"done"\|"active"\|"pending", content}]}` \| `{ok:false, reason}` |

```bash
curl "${A[@]}" "$B/tabs/$TAB/todo-panel"
```

### Start screen (slice-P7.12 F5#1a W2, extended by slice-F5-1b-cut.md §2-D4)

Mirrors the "New Task" start screen (`StartScreen.tsx`) — `GET
/start-screen` is a live read of the tabs-store draft slot plus a DOM probe
(`rendered`/`recentCount`/`projectMenuOpen`), same "no mirrored state"
discipline as the todo-panel probe above; `sendEnabled` uses the exact same
rule as `StartScreen.tsx`'s own `computeSendDisabledReason` (a folder chosen
AND a non-blank prompt, `design/slice-P7.12-cut.md` §3-D3). `model` is the
draft's raw task-model pick (`null` = provider default). `recentCount` counts
the project popover's recent rows while `projectMenuOpen` is true, `0` while
closed (`design/slice-F5-1b-cut.md` §2-D4). Every POST route goes through the
SAME tabs-store draft actions / `submitStartDraft` the real UI calls — no
second path, no new `SnapshotJson` field.

`engine`/`availableEngines` (codex-fixes TASK.42, cut §3.7) are the ONE
exception to "no new `SnapshotJson` field" — the draft's current engine pick
and the compiled-in engine catalog (`shared/engines.ts` `ENGINE_IDS`, e.g.
`["core","codex"]`), read the same draft-scoped way as `workspace`/`prompt`/
`model` (`engine` is `undefined` until a draft exists; `availableEngines` is
the static catalog regardless of draft state). `POST /start-screen/engine`
drives the SAME `setDraftEngine` tabs-store action `startScreenSetModel`'s
`setDraftModel` neighbor uses — validated host-side against `ENGINE_IDS`
(`isEngineId`), never a raw string trusted from the caller.
`GET /tabs/:tabId/... state` (below) also gains a per-tab `engine` field —
see "Engine metadata on the tab snapshot".

| Method / path | Body | Returns |
|---|---|---|
| `GET /start-screen` | — | `{ok:true, active, rendered, workspace, prompt, model, sendEnabled, recentCount, projectMenuOpen, engine?, availableEngines?}` |
| `POST /start-screen/open` | `{workspace?}` | `{ok:true}` |
| `POST /start-screen/workspace` | `{workspace}` | `{ok:true}` \| `{ok:false, reason:"no_draft"}` |
| `POST /start-screen/prompt` | `{text}` | `{ok:true}` \| `{ok:false, reason:"no_draft"}` |
| `POST /start-screen/model` | `{model: string \| null}` | `{ok:true}` \| `{ok:false, reason:"no_draft"}` |
| `POST /start-screen/engine` | `{engineId}` | `{ok:true}` \| `{ok:false, reason:"no_draft"\|"invalid_engine"}` |
| `POST /start-screen/project-menu` | `{open}` | `{ok:true}` \| `{ok:false, reason:"no_draft"\|"did_not_open"\|"did_not_close"}` |
| `POST /start-screen/submit` | `{}` | `{ok:true, tabId}` \| `{ok:false, message}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/open -d '{}'
curl "${A[@]}" "$B/start-screen"
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/prompt -d '{"text":"hello"}'
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/workspace -d '{"workspace":"/tmp/proj-c"}'
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/model -d '{"model":"claude-opus-4"}'
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/engine -d '{"engineId":"codex"}'
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/project-menu -d '{"open":true}'
curl "${A[@]}" "${J[@]}" -X POST $B/start-screen/submit -d '{}'
```

#### Engine metadata on the tab snapshot (codex-fixes TASK.42, cut §3.7)

`GET /state[/:tabId]`'s per-tab snapshot gains an additive, optional `engine`
field: `{id, model?, activePresetId?}`, mirroring host_ready.engine's own
"absent = legacy core" discipline (cut §2(f)) — a core session's snapshot is
BYTE-UNTOUCHED (the key is omitted entirely), so no existing snapshot
assertion needs updating for core. Present only once a non-core (currently
`codex`) session reaches `host_ready`:

```bash
curl "${A[@]}" "$B/state/$TAB" | jq '.snapshot.states[$TAB].engine'
# {"id":"codex","model":"gpt-5.2-codex","activePresetId":"ask"} — or `null` for a core session
```

### Project routes (GUI-P1)

Mirror the sidebar's two project-menu actions (`design/slice-GUI-P1-cut.md`
§2F.5) through the same paths their real UI equivalents use: `/projects/new`
goes through the renderer's own `createTab` contextBridge invoke — the SAME
call the sidebar's "New session in this project" makes, main is the
authority, no folder dialog; `/projects/hide` calls the real `hideWorkspace`
store action — the SAME call "Remove project from list" makes, so the
open-tabs refusal is decided there, not re-implemented in the channel.

| Method / path | Body | Returns |
|---|---|---|
| `POST /projects/new` | `{workspace}` | `{ok:true, tabId, workspace}` \| `{ok:false, reason}` (same `CreateTabResult` shape as `POST /tabs {kind:"new"}`) |
| `POST /projects/hide` | `{workspace}` | `{ok:true}` \| `{ok:false, reason:"project_has_open_tabs"}` |

`GET /state`'s snapshot also gains `hiddenWorkspaces: string[]` — the
sidebar's shell-level hidden-projects set (not per-tab; a hidden workspace
self-heals out of this set the next time any tab opens in it).

```bash
PORT=$(jq -r .port ~/.anycode/automation.json)
TOKEN=$(jq -r .token ~/.anycode/automation.json)
A=(-s -H "Authorization: Bearer $TOKEN"); B=http://127.0.0.1:$PORT
J=(-H 'content-type: application/json')

curl "${A[@]}" "${J[@]}" -X POST $B/projects/new -d '{"workspace":"/tmp/proj-b"}'
curl "${A[@]}" "$B/state" | jq '.snapshot.hiddenWorkspaces'
curl "${A[@]}" "${J[@]}" -X POST $B/projects/hide -d '{"workspace":"/tmp/proj-b"}'
```

### Prompt queue (slice-P7.14 F15, W3)

Mirrors `PromptQueue.tsx`/`Composer.tsx`'s "queue a message while a turn is
running" flow (`design/slice-P7.14-cut.md` §5) through the SAME store actions
the UI calls — `sendPrompt` above is untouched; queuing is a distinct method
because busy is deliberately NOT a rejection reason here. `tabId` rides in
each body (not the path) since a queue op has no other path segment, same
posture as `POST /transcript/scroll`. Queue state itself has no dedicated GET
route — it rides the existing `GET /state[/:tabId]` snapshot's additive
`promptQueue`/`queuePaused` fields (attachments stripped to `imageCount`, no
base64 in the snapshot).

| Method / path | Body | Returns |
|---|---|---|
| `POST /queue/prompt` | `{tabId, text}` | `{ok:true, id}` \| `{ok:false, reason:"unknown_tab"\|"not_ready"}` |
| `POST /queue/edit` | `{tabId, id, text}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"\|"unknown_prompt"}` |
| `POST /queue/delete` | `{tabId, id}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"\|"unknown_prompt"}` |
| `POST /queue/resume` | `{tabId}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"}` |
| `POST /queue/clear` | `{tabId}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/queue/prompt -d "{\"tabId\":\"$TAB\",\"text\":\"hello\"}"
curl "${A[@]}" "$B/state/$TAB" | jq '.snapshot.states[$TAB].promptQueue'
curl "${A[@]}" "${J[@]}" -X POST $B/queue/resume -d "{\"tabId\":\"$TAB\"}"
```

### Model pill probe/driver (slice-P7.15 F14, W4)

Mirrors `ModelPill.tsx` (the single footer chip that replaced the old
effort-`<select>` + display-only model `<span>`, `design/slice-P7.15-cut.md`
§2.6) — a DOM probe/driver, same "no mirrored state" discipline as the
todo-panel probe above. `GET .../model-pill` refuses `tab_not_active` exactly
like `GET .../todo-panel`; `ok:true, present:false` (every other field at its
conservative default) is a normal reading, not an error — no active tab's
chat UI is mounted yet, or `model` is still `null` pre-`host_ready`
(`ModelPill`'s own `{model === null}` guard). `menuOpen`/`page` are read
straight off the DOM (the popover's open/page state is local component
`useState`, not store-observable); `label`/`modelItems`/`effortItems` are
computed with the SAME exported pure helpers `ModelPill.tsx` itself renders
with (`pillLabel`/`modelDisplayName`/`modelMenuItems`), so the probe cannot
drift from the on-screen labeling/gating.

`POST .../model-pill/pick` drives a REAL pick — it fires actual `.click()`
calls on the pill's own DOM nodes (open the popover if needed, navigate to
the right page if needed, click the item at the same index the component's
own `.map()` render uses), rather than re-implementing the click handlers —
same "one product path" discipline as the git/queue routes above. Every pick
kind is refused with `pick_disabled` while the client-side mirror of the
between-turns guard (`shouldEnqueue(turn, queueInFlight) || !ready`) says so
— the host's own `!busy` check on `set_model`/`set_reasoning_effort` remains
the authoritative backstop; this is the UX-parity guard the same way
`sendPrompt`'s `busy` refusal is.

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/model-pill` | — | `{ok:true, present, label, menuOpen, page:"root"\|"model"\|"effort", effortRowVisible, modelItems:[{id,name}], effortItems:ReasoningEffort[], currentModel, currentEffort, modelPickDisabled, manageModelsDisabled}` \| `{ok:false, reason:"tab_not_active"}` |
| `POST /tabs/:tabId/model-pill/pick` | `{kind:"open"}` \| `{kind:"model", value}` \| `{kind:"effort", value}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"not_present"\|"pick_disabled"\|"did_not_open"\|"effort_row_hidden"\|"navigation_failed"\|"unknown_value"}` |

```bash
curl "${A[@]}" "$B/tabs/$TAB/model-pill"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/model-pill/pick -d '{"kind":"open"}'
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/model-pill/pick -d '{"kind":"effort","value":"high"}'
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/model-pill/pick -d '{"kind":"model","value":"glm-4.6"}'
```

### Ctx-popover probe/driver (slice-P7.17 F12, W4)

Mirrors `CtxPopover` (`Composer.tsx`, the ctx-meter's hover/click popover,
`design/slice-P7.17-cut.md` F12) — a DOM probe/driver, same "no mirrored
state" discipline as the model-pill probe above. `GET .../ctx-popover` refuses
`tab_not_active` exactly like `GET .../model-pill`; `ok:true, open:false`
(headline/percentText null, rows/sessionTokens empty) is a normal reading, not
an error — the meter hasn't rendered yet (pre-`context_usage`, `Composer`'s
own `ctxPercent !== null` mount gate), or the popover is simply closed.
`open`/`headline`/`rows` are read straight off the DOM (the popover's open
state is local component `useState`, not store-observable, and
headline/rows only exist as rendered strings with no store-side counterpart);
`percentText` is the trigger chip's own always-visible text (`"NN% ctx"`),
populated whenever the meter is mounted regardless of `open`.
`sessionTokens` is copied straight off the live store's `sessionTokens` field
rather than re-parsed from the rendered session line, which loses precision
once a count crosses the K/M formatting threshold — populated only while
`open` and the session line is actually rendered.

`POST .../ctx-popover/open` drives a REAL open/close — it fires an actual
`.click()` on the trigger chip (`.composer-ctx-meter`), the exact same node
`CtxPopover`'s own `handleClick` toggles `open` from, rather than a synthetic
state poke (same "one product path" discipline as the model-pill pick route).
A no-op when the panel already reports the requested state (no click fired).

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/ctx-popover` | — | `{ok:true, open, headline:string\|null, percentText:string\|null, rows:[{label,percent}], sessionTokens:{input,output,total}\|null}` \| `{ok:false, reason:"tab_not_active"}` |
| `POST /tabs/:tabId/ctx-popover/open` | `{open:boolean}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"not_present"\|"did_not_open"\|"did_not_close"}` |

```bash
curl "${A[@]}" "$B/tabs/$TAB/ctx-popover"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/ctx-popover/open -d '{"open":true}'
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/ctx-popover/open -d '{"open":false}'
```

### Settings probe/driver (slice-P7.16 F11, W4)

Global (app-level) routes — no `:tabId` segment, Settings is not per-tab.
`GET /settings` deliberately mixes two sources: `permissions.groups` comes
from the settings-store snapshot (the persisted source of truth), while
`open`/`activePane`/`panesVisible`/`searchQuery` are read off the DOM (the
dialog's open state and the rail's active/visible panes are local component
`useState`, not store-observable — same posture as the model-pill probe's
`menuOpen`/`page`). `permissions.groups[].rules[].pattern` is `null` for a
pattern-less ("all uses") rule; `display` is always non-blank.

`POST /settings/open` / `close` drive App's REAL path — a click on the
sidebar's gear trigger / the rail's "← Back to app" row, not a synthetic
state poke (there is no store action for the dialog's open flag; it is
App.tsx-local `useState`). `POST /settings/permissions/add` fills the
manual-add form's tool/pattern inputs and clicks Add — deliberately the form,
not a direct store call, so the request exercises the SAME path a user's
keystrokes would, including the create-time Bash env-prefix sanitizer
(`buildAlwaysAllowRule`, slice-P7.16-cut.md §4.2). `POST
/settings/permissions/remove` clicks the row whose remove button carries the
exact `aria-label` `ruleRemoveAriaLabel` computes for `{toolName, pattern}`.

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings` | — | `{open, activePane, panesVisible:[string], searchQuery, permissions:{groups:[{toolName, rules:[{pattern:string\|null, display}]}]}}` |
| `POST /settings/open` | `{}` | `{ok:true}` \| `{ok:false, reason:"did_not_open"}` |
| `POST /settings/close` | `{}` | `{ok:true}` \| `{ok:false, reason:"did_not_close"}` |
| `POST /settings/pane` | `{paneId}` | `{ok:true}` \| `{ok:false, reason:"not_open"\|"pane_not_visible"\|"pane_switch_failed"}` |
| `POST /settings/permissions/add` | `{toolName, pattern?}` | `{ok:true}` \| `{ok:false, reason:"not_open"\|"form_not_present"\|"add_disabled"\|"add_failed"}` |
| `POST /settings/permissions/remove` | `{toolName, pattern?}` | `{ok:true}` \| `{ok:false, reason:"not_open"\|"rule_not_found"\|"remove_failed"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/open -d '{}'
curl "${A[@]}" "$B/settings"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"permissions"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/permissions/add -d '{"toolName":"Bash","pattern":"node *"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/permissions/remove -d '{"toolName":"Bash","pattern":"node *"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/close -d '{}'
```

### Agent card probe/driver (slice-P7.18 F16b, W4)

Mirrors the expanded Agent card's body (`ToolCallCard.tsx`'s `AgentCardBody`,
design/slice-P7.18-cut.md §4 W3/W4) — a DOM probe reading the three facts that
are NOT already carried by `GET /state`'s snapshot (`transcript[*].modelText`
and `subagent.activity`/`subagent.final` ride the snapshot untouched, no new
`SnapshotJson` field this wave): whether the card is user-expanded, whether
the PROMPT plaque is still in its default collapsed strip (the two-level
collapse invariant), and whether the Markdown RESULT actually painted a node.
`feedRowCount` counts the live `<li>` rows in the DOM directly (not just the
store's `activity.length`), so it proves the feed really rendered. `GET
.../agent-card/:toolCallId` refuses `tab_not_active`/`unknown_tab` like the
other transcript-scoped probes; `ok:true` with the empty defaults
(`expanded:false, promptCollapsed:true, feedRowCount:0, resultRendered:false`)
is a normal reading, not an error — the card hasn't landed in the transcript
yet, or no card carries this exact `toolCallId`.

`POST .../agent-card/:toolCallId/expand` drives a REAL click on the card's own
`.tool-call-toggle` header button — Agent cards default to collapsed in every
status (`defaultExpanded`'s Agent-only branch, slice-P7.4-cut.md §3.2), so
this is the only path a live smoke has to reach the expanded body the probe
above reads. Idempotent: a no-op `{ok:true}` if the card already reads
expanded; `{ok:false, reason:"not_present"}` if no card with this `toolCallId`
is rendered at all; `{ok:false, reason:"did_not_expand"}` if the click never
commits within the poll deadline (a genuine no-op click).

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/agent-card/:toolCallId` | — | `{ok:true, expanded, promptCollapsed, feedRowCount, resultRendered}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"}` |
| `POST /tabs/:tabId/agent-card/:toolCallId/expand` | `{}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"\|"not_present"\|"did_not_expand"}` |

```bash
curl "${A[@]}" "$B/tabs/$TAB/agent-card/$TOOL_CALL_ID"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/agent-card/$TOOL_CALL_ID/expand -d '{}'
```

### Try-again button probe/driver (TASK.33 W8-FIX #2)

`POST /tabs/:tabId/retry` above (the pre-existing route) calls
`dispatchTryAgain` directly — a facade shortcut that proves the resend logic
works but bypasses the RENDERED button's own DOM/onClick wiring entirely, so
it can't catch a broken `MessageList` visibility condition, a missing button,
or a handler-wiring regression. These two routes are a DOM-level
probe/driver pair for the actual `.retry-try-again-button` node, same "no
mirrored state" discipline as the agent-card probe above: `GET
.../try-again-button/:blockId` reads `count`/`visible`/`enabled` straight off
the `loop_end` block's own `data-block-id`-tagged DOM node (`count`
deliberately isn't collapsed to a boolean — more than one button on the same
block is itself a defect this probe exists to catch); `POST
.../try-again-button/:blockId/click` fires a REAL `.click()` on that exact
button — the same node a user's mouse would hit, running through the
button's own `onClick` (which calls the SAME `dispatchTryAgain` the `retry`
route above short-circuits to). Refuses `tab_not_active`/`unknown_tab` like
the agent-card probe/driver; `ok:true, count:0, visible:false, enabled:false`
is a normal reading, not an error — the block hasn't landed in the transcript
yet, or carries no such button (no armed offer, or a different block).
`{ok:false, reason:"not_present"}` from the click route covers both "no
button there" and "more than one" — a caller wanting the "exactly one"
guarantee asserts on the GET probe's `count` first.

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/try-again-button/:blockId` | — | `{ok:true, count, visible, enabled}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"}` |
| `POST /tabs/:tabId/try-again-button/:blockId/click` | `{}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"\|"not_present"}` |

```bash
curl "${A[@]}" "$B/tabs/$TAB/try-again-button/$LOOP_END_BLOCK_ID"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/try-again-button/$LOOP_END_BLOCK_ID/click -d '{}'
```

### Host-kill lever (TASK.33 FIX-A)

The Try-again offer surviving `store.ts`'s host-restart reset only proves the
*state* layer survives a respawn — it says nothing about whether the button
is actually reachable in the post-respawn DOM (the anchored button's render
site is gated on a `loop_end` transcript block, which hydration never
reproduces). `POST /tabs/:tabId/host/kill` is a dev-only lever to make that
distinction testable live: it force-kills the tab's REAL host child process
(`TabHostManager.killHost`, main-plane only — no facade call, a page has no
way to kill its own host), letting the existing crash-respawn machinery
(`tabs.ts`: breaker accounting, fresh port pair, `--resume`) run exactly as it
would for a genuine crash. Deliberately distinct from the graceful
`shutdownTabHost` path `POST /tabs/:tabId/close` and `/quit` use, which marks
the tab `"closing"` first specifically to SUPPRESS a respawn — this route
exists to force one.

| Method / path | Body | Returns |
|---|---|---|
| `POST /tabs/:tabId/host/kill` | `{}` | `{ok:true}` \| `{ok:false, reason:"unknown_tab"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/host/kill -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/wait -d "{\"tabId\":\"$TAB\",\"until\":{\"connection\":\"ready\"}}"
```

### MCP Servers pane probe/driver (slice P7.19 F22, W4)

Exercises `McpServersPane.tsx` (the MCP management page,
`design/slice-P7.19-cut.md` §4 W3/W4) — a DOM probe/driver, same "no mirrored
state" discipline as the settings probe above. `GET /settings/mcp` is a
DEDICATED route: `GET /settings`/`settingsState()` stays byte-untouched (§3
byte-lock). An unmounted pane (Settings closed, or a different pane selected)
reads as the empty defaults below, not an error. `rows` covers BOTH the
"Configured servers" and the read-only "From .mcp.json" sections in the SAME
DOM order they render; `dotKind`/`enabled` are read off each row's own
`mcp-dot-<kind>` class (byte-parity with the on-screen status dot, no
re-derivation); `commandLine` is read off the row's own `title` attribute
(the exact `McpConfigEntryView.commandLine` string), not re-parsed from the
rendered `"<transport> · <commandLine>"` text. `importCandidates`/
`consentChecked` populate only while the import dialog is open.

`POST .../mcp/toggle` drives a REAL click on the named row's enable/disable
switch — the toggle round-trips through the real `McpConfigBridge.setEnabled`
the component itself calls (main IPC + fs write), not a synthetic store poke;
`{ok:false, reason:"not_toggleable"}` for a read-only `.mcp.json` row (no
switch at all). `POST .../mcp/import/open` clicks the header's import button
if the dialog isn't already open, then waits for its real `bridge.importScan`
round-trip to settle (main-process fs fan-out over the fixed harness
allowlist) before returning — so a caller's very next probe read never races
an in-flight scan. `POST .../mcp/import/apply` sets the dialog's own
candidate checkboxes to EXACTLY the requested `names` (every other listed
candidate unchecked — not merely "ensure these are checked", so a caller can
apply one specific candidate at a time regardless of the dialog's own
default-checked seeding), sets the consent checkbox, clicks Apply, and waits
for the results list to visibly change before returning (a real main-process
config write, `config-write.ts`'s atomic tmp+rename).

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/mcp` | — | `{rows:[{name, source, enabled, dotKind, toolsBadge, commandLine}], problems, importOpen, importCandidates:[{harness, name, checked, alreadyConfigured}], consentChecked}` |
| `POST /settings/mcp/toggle` | `{name}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_toggleable"\|"did_not_toggle"}` |
| `POST /settings/mcp/import/open` | `{}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"did_not_open"\|"scan_timeout"}` |
| `POST /settings/mcp/import/apply` | `{consent, names?}` | `{ok:true}` \| `{ok:false, reason:"dialog_not_open"\|"scan_not_loaded"\|"candidate_not_found"\|"apply_disabled"\|"apply_timeout"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"mcp"}'
curl "${A[@]}" "$B/settings/mcp"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/mcp/import/open -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/mcp/import/apply -d '{"consent":false,"names":["my-server"]}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/mcp/toggle -d '{"name":"my-server"}'
```

`ANYCODE_MCP_IMPORT_HOME=<absolute dir>` is a **dev/test-only** override for
the import scan's `home` directory (`main/index.ts`'s `mcp-config-ipc.ts`
wiring: `home: () => process.env.ANYCODE_MCP_IMPORT_HOME ?? homedir()`) — same
ethic as `ANYCODE_USER_DATA_DIR`/`ANYCODE_AUTOMATION_INFO` above: it lets a
smoke run point the import scan (`~/.claude.json`, `~/.codex/config.toml`,
`~/.zcode/cli/config.json`) at a disposable fixture directory instead of the
real machine's harness configs, with zero production code path reading it
(the production default is always the real `os.homedir()`). See
`apps/desktop/scripts/mcp-ui-smoke.mjs` for the reference wiring.

### Skills pane probe/driver (slice P7.20 F23, W4)

Exercises `SkillsPane.tsx` (the Skills management page,
`design/slice-P7.20-cut.md` §5 W3/W4) — a DOM probe/driver, same "no mirrored
state" discipline as the MCP pane probe above. `GET /settings/skills` is a
DEDICATED route: `GET /settings` and `GET /settings/mcp` stay byte-untouched
(§4 custody). An unmounted pane (Settings closed, or a different pane
selected) reads as the empty defaults below, not an error. `rows` covers
every row across BOTH groups ("Workspace and personal skills" then the
read-only "Plugin skills") in the SAME DOM order they render; `sourceKind`/
`enabled` are read off each row's own `data-skill-source`/`data-skill-enabled`
attributes (byte-parity with the on-screen badge/switch, no re-derivation);
`hasToggle` is `true` only for a row that actually renders the enable/disable
switch (a plugin row has none). `importCandidates` populates only while the
import dialog is open — there is no separate consent checkbox here (design §2
D2: the per-candidate checkbox IS the consent act, unlike MCP's forced-off +
explicit consent gate).

`POST .../skills/toggle` drives a REAL click on the named row's enable/disable
switch — round-trips through the real `SkillsBridge.setEnabled` the component
itself calls (main IPC + `skills.disabled` config write), not a synthetic
store poke; `{ok:false, reason:"not_toggleable"}` for a read-only plugin row
(no switch at all). `POST .../skills/delete` drives TWO real clicks — the
row's trash icon (opens the inline "Delete "<name>"?" confirm row), then that
row's own Delete button — same fidelity-over-shortcut posture as the rest of
this file; `{ok:false, reason:"not_deletable"}` for a plugin row (neither
control rendered). `POST .../skills/import/open` clicks the header's import
button if the dialog isn't already open, then waits for its real
`bridge.importScan` round-trip to settle (main-process fs fan-out over the
fixed harness allowlist) before returning. `POST .../skills/import/apply`
optionally sets the dialog's own candidate checkboxes to EXACTLY the requested
`ids` (candidate stable IDENTITIES, `${harness} ${sourceDir} ${name}` — never
bare names, two harnesses can share one; every other listed candidate
unchecked; omitted ⇒ leave the dialog's own current default-checked selection
as-is), sets the "Import into" scope radio, clicks Apply, and waits for the
results list to visibly change before returning (a real main-process
convert+copy into the target catalog).

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/skills` | — | `{rows:[{name, sourceKind, enabled, hasToggle}], problems, importOpen, importCandidates:[{id, harness, name, checked, needsConversion, alreadyPresent}]}` |
| `POST /settings/skills/toggle` | `{name}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_toggleable"\|"did_not_toggle"}` |
| `POST /settings/skills/delete` | `{name}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_deletable"\|"confirm_not_shown"\|"did_not_delete"}` |
| `POST /settings/skills/import/open` | `{}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"did_not_open"\|"scan_timeout"}` |
| `POST /settings/skills/import/apply` | `{scope, ids?}` | `{ok:true}` \| `{ok:false, reason:"dialog_not_open"\|"scan_not_loaded"\|"candidate_not_found"\|"apply_disabled"\|"apply_timeout"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"skills"}'
curl "${A[@]}" "$B/settings/skills"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/skills/import/open -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/skills/import/apply -d '{"scope":"user","ids":["claude /home/x/.claude/skills imported-one"]}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/skills/toggle -d '{"name":"alpha"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/skills/delete -d '{"name":"imported-one"}'
```

`ANYCODE_SKILLS_IMPORT_HOME=<absolute dir>` is a **dev/test-only** override
for the import scan's `home` directory (`main/index.ts`'s `resolveSkillsImportHome`
wiring, same double-gate/ethic as `ANYCODE_MCP_IMPORT_HOME` above) — it lets a
smoke run point the import scan (`~/.claude/skills`, `~/.codex/skills`,
`~/.zcode/skills`, installed CC plugins) at a disposable fixture directory
instead of the real machine's harness catalogs, with zero production code
path reading it (the production default is always the real `os.homedir()`).
See `apps/desktop/scripts/skills-ui-smoke.mjs` for the reference wiring.

### Subagents pane probe/driver (slice P7.21 F21, W4)

Exercises `SubagentsPane.tsx` (the Subagents management page,
`design/slice-P7.21-cut.md` §4 W3/W4) — a DOM probe/driver, same "no mirrored
state" discipline as the Skills pane probe above. `GET /settings/subagents` is
a DEDICATED route: `GET /settings`, `GET /settings/mcp`, and `GET
/settings/skills` all stay byte-untouched (§4 custody). An unmounted pane
(Settings closed, or a different pane selected) reads as the empty defaults
below, not an error. `rows` covers every row across all three groups
(Built-in -> User -> Plugin) in the SAME DOM order they render; `sourceKind`
is read off each row's own `data-subagent-source` attribute, `toolsBadge`/
`description` off its own badge/description text (byte-parity with the
on-screen row); `editable` is `true` only for a row that renders a mutation
controls cell at all (a built-in/plugin row has none). `editor` populates only
while the in-app editor dialog is open — a closed editor reads as
`{open:false, mode:null, tab:null, ...blank fields}`.

`POST .../subagents/editor/open` drives a REAL click on either the header's
"Create subagent" button (`name` omitted) or the named row's Edit button
(`name` given — `{ok:false, reason:"not_editable"}` for a read-only built-in/
plugin row, which renders no Edit button at all); the edit path round-trips
through a real `bridge.read()` IPC call before the dialog mounts.
`POST .../subagents/editor/set` drives the SAME Name/Description/Body fields
and tool-choice chips the editor form renders — a partial patch, only the
provided keys are touched, via native-setter + dispatched `input` events (no
`aria-label` exists on these fields; they are identified structurally by
walking to the `.settings-field` whose own label text matches).
`POST .../subagents/editor/preview` clicks the Preview tab (if not already
selected) and waits for the REAL `bridge.preview()` round-trip to settle —
this is core's actual `buildSubagentSystemPrompt` builder (design §2-D4), not
a lookalike; the response carries the rendered system prompt + the effective
tool list. `POST .../subagents/editor/save` clicks Save and waits for either
the dialog to close (success) or a refusal message to appear (rejected —
`issues[]` carried alongside, the SAME validation detail the dialog itself
renders). `POST .../subagents/delete` drives the SAME two real clicks as
`.../skills/delete` (trash icon -> confirm row's own Delete button);
`{ok:false, reason:"not_deletable"}` for a built-in/plugin row (neither
control rendered) — this is how the live smoke proves `general-purpose`
refuses deletion.

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/subagents` | — | `{rows:[{name, sourceKind, toolsBadge, description, editable}], problems, editor:{open, mode, tab, name, description, tools, body, canSave, error, issues, previewLoading, previewSystemPrompt, previewEffectiveTools}}` |
| `POST /settings/subagents/editor/open` | `{name?}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"already_open"\|"row_not_found"\|"not_editable"\|"did_not_open"}` |
| `POST /settings/subagents/editor/set` | `{name?, description?, tools?, body?}` | `{ok:true}` \| `{ok:false, reason:"editor_not_open"\|"field_not_found"\|"set_failed"}` |
| `POST /settings/subagents/editor/preview` | `{}` | `{ok:true, systemPrompt, effectiveTools}` \| `{ok:false, reason:"editor_not_open"\|"preview_tab_not_found"\|"preview_timeout"\|"preview_unavailable"}` |
| `POST /settings/subagents/editor/save` | `{}` | `{ok:true}` \| `{ok:false, reason, issues?}` |
| `POST /settings/subagents/delete` | `{name}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_deletable"\|"confirm_not_shown"\|"did_not_delete"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"subagents"}'
curl "${A[@]}" "$B/settings/subagents"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/subagents/editor/open -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/subagents/editor/set -d '{"name":"summarizer","description":"Summarizes code.","body":"You summarize code."}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/subagents/editor/preview -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/subagents/editor/save -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/subagents/delete -d '{"name":"summarizer"}'
```

`ANYCODE_SUBAGENTS_HOME=<absolute dir>` is a **dev/test-only** override for
the admin scan's user-scope `home` directory (`main/index.ts`'s
`resolveSubagentsHome` wiring, same double-gate/ethic as
`ANYCODE_SKILLS_IMPORT_HOME` above) — it lets a smoke run point the user-scope
root (`<home>/.anycode/agents/*.md`) at a disposable fixture directory instead
of the real machine's `~`, with zero production code path reading it (the
production default is always the real `os.homedir()`). See
`apps/desktop/scripts/subagents-ui-smoke.mjs` for the reference wiring.

### Profile pane probe/driver (slice P7.22 F19, W4)

Mirrors `ProfilePane.tsx` (the Settings "Profile" usage-stats page,
`design/slice-P7.22-cut.md` §1/§4 W3/W4) — a DOM probe/driver, same "no
mirrored state" discipline as the Subagents pane probe above. `GET
/settings/profile` is a DEDICATED route: `GET /settings`, `GET
/settings/mcp`, `GET /settings/skills`, and `GET /settings/subagents` all
stay byte-untouched (§4 custody). An unmounted pane (Settings closed, or a
different pane selected) reads as the empty defaults below, not an error —
so does the brief pre-fetch "Loading profile…" moment (the pane root is
mounted but the stats body hasn't rendered yet); a caller polls
`GET /settings/profile` until `tiles.length > 0` (or `emptyStateHero`/
`frozenBanner`) settles, same posture as the Skills pane probe's import-scan
poll. `tiles`/`insights`/`topTools` are read straight off the rendered tile
captions/values, insight label/value rows, and top-tools row names
(byte-parity with the on-screen strip); `heatmapNonEmptyCells` counts
rendered heatmap cells whose intensity bucket is non-zero (bucket 0 is
reserved for both zero-token days AND grid-alignment padding cells, so this
is exactly "how many days in the 12-month window have tokens").
`telemetryEnabled`/`killSwitchActive` are read off the toggle switch's own
`aria-checked`/`disabled` attributes. `emptyStateHero` is `true` only for the
`hero` branch (no data + disabled); `frozenBanner` is `true` only for the
`banner` branch (data present + disabled — "Telemetry is off — stats are
frozen").

`POST .../profile/telemetry` drives a REAL click on the toggle switch — always
flips the CURRENT effective state (mirrors a real click, `ProfilePane.tsx`'s
own `nextTelemetryToggleValue`; there is no separate "set to X" request
shape), round-tripping through the real `ProfileBridge.setTelemetry` the
component itself calls (main IPC + `setUserTelemetryEnabled`'s atomic,
sibling-preserving user-config write); `{ok:false, reason:"toggle_disabled"}`
when the `ANYCODE_TELEMETRY` env kill-switch has the switch rendered
`disabled`.

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/profile` | — | `{mounted, tiles:[{label, value}], insights:{totalSessions, totalRuns, toolCalls, subagentRuns, mostUsedModel}, topTools:[name], heatmapNonEmptyCells, telemetryEnabled, killSwitchActive, truncated, emptyStateHero, frozenBanner}` |
| `POST /settings/profile/telemetry` | `{}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"toggle_not_present"\|"toggle_disabled"\|"did_not_toggle"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"profile"}'
curl "${A[@]}" "$B/settings/profile"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/profile/telemetry -d '{}'
```

`ANYCODE_PROFILE_HOME=<absolute dir>` is a **dev/test-only** override for the
Profile pane's user-scope `home` directory (`main/index.ts`'s
`resolveProfileHome` wiring, same double-gate/ethic as
`ANYCODE_SUBAGENTS_HOME` above) — it lets a smoke run point the telemetry-
config/sink-dir resolution (`<home>/.anycode/telemetry`,
`<home>/.anycode/config.json`) at a disposable fixture directory instead of
the real machine's `~`, with zero production code path reading it (the
production default is always the real `os.homedir()`). Profile has no
per-tab workspace concept at all — this is the ONLY home lever the pane
needs (unlike skills/subagents, which also take a `workspaceForTab`). See
`apps/desktop/scripts/profile-ui-smoke.mjs` for the reference wiring.

### Slash-command menu probe/driver (slice P7.23 F24, W4)

Mirrors the composer's `/`-triggered command menu (`Composer.tsx`/
`SlashMenu.tsx`, `design/slice-P7.23-cut.md` §7) — a DOM probe + two textarea
drivers, same "no mirrored state" discipline as the model-pill/ctx-popover
probes above. `GET .../slash-menu` refuses `tab_not_active` exactly like
`GET .../model-pill` (the composer only ever mounts inside the active tab's
`ActiveTabBody`); `ok:true, open:false` (`items:[]`) is a normal reading, not
an error — no trigger active, or the menu is closed/dismissed/zero-matched.
`draft` is the live textarea value (doubling as the insert-assert — a
selected skill row replaces the slash token with `$name `, directly
observable here); `query` is recomputed via the SAME pure `slashQueryAt`
`Composer.tsx` itself calls every render, so it cannot drift. `items`/
`selectedIndex` are read straight off the RENDERED `.slash-menu-row` nodes
(never re-filtered independently) — a row's `highlighted` flag is "does this
row's name contain at least one `<b>` match span" (`SlashMenu.tsx`'s own
`renderHighlightedName`); `section` is derived from DOM position relative to
the (at most one) `.slash-menu-section` "Skills" header.

`POST .../slash-menu/type` and `POST .../slash-menu/key` drive the REAL
`<textarea>` the same way a real keystroke would — `type` sets the value
through the native `HTMLTextAreaElement` value setter (a bare `.value=` is
invisible to React) then dispatches a real bubbling `input` event, with the
caret explicitly placed at the end BEFORE that dispatch; `key` dispatches a
real `KeyboardEvent("keydown")` so `Composer`'s own `onKeyDown` handler runs
unmodified. Neither driver recomputes the menu's open/selection state itself
— both are pure DOM mutations the SAME component-owned effects react to, so a
follow-up `GET .../slash-menu` is the only way to observe the result (same
"drive the real node, read the real render" discipline as the model-pill/
ctx-popover drivers above).

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/slash-menu` | — | `{ok:true, open, query, selectedIndex, draft, items:[{name, section:"commands"\|"skills", sourceLabel?, disabled, highlighted}]}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"}` |
| `POST /tabs/:tabId/slash-menu/type` | `{text:string}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"\|"not_present"}` |
| `POST /tabs/:tabId/slash-menu/key` | `{key:"ArrowDown"\|"ArrowUp"\|"Enter"\|"Tab"\|"Escape"}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"\|"unknown_tab"\|"not_present"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/slash-menu/type -d '{"text":"/mod"}'
curl "${A[@]}" "$B/tabs/$TAB/slash-menu"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/slash-menu/key -d '{"key":"ArrowDown"}'
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/slash-menu/key -d '{"key":"Enter"}'
```

Skills-section rows come from the SAME `SKILLS_LIST_CHANNEL` scan every other
skills probe reads (`ANYCODE_SKILLS_IMPORT_HOME`-overridable, dev/test only —
see the Skills pane probe/driver section above). See
`apps/desktop/scripts/slash-menu-ui-smoke.mjs` for the reference wiring.

### Keyboard shortcuts pane probe/driver (slice P7.24 F20, W4)

Mirrors `KeyboardShortcutsPane.tsx` (the Settings "Keyboard shortcuts" page,
`design/slice-P7.24-cut.md` §1.4/§4 W3/W4) — a DOM probe/driver, same "no
mirrored state" discipline as the Profile pane probe above. `GET
/settings/shortcuts` is a DEDICATED route: every prior `/settings*` probe
stays byte-untouched (§4 custody). An unmounted pane (Settings closed, or a
different pane selected) reads as the empty defaults below, not an error.
Each row's `bindings` are the rendered badge chord strings (already run
through `formatBinding`, e.g. `"⌘J"`, never a raw persisted chord string);
`overridden` mirrors the row's own Reset button; `unassigned` the
"Unassigned" pill; `recording` whether this row currently owns the live
recording chip. `errorText` is the recording chip's inline refusal text
("Use ⌘/Ctrl + key" / "Reserved shortcut" / `Already used by "..."`) — `null`
both when nothing is recording and while a chip is showing its neutral "Press
shortcut…" placeholder (no refusal yet).

`POST .../shortcuts/record` drives a REAL click on a slot's pencil
(`slotIndex` provided) or the "+ Add" button (`slotIndex` omitted — appends
past the current end), entering record mode; `{ok:false,
reason:"not_editable"}` for the two structural read-only rows (`tab.activate`,
`turn.interrupt`). `POST .../shortcuts/press` dispatches a REAL,
capture-visible `window` `keydown` carrying the platform-primary modifier
(`metaKey` on darwin / `ctrlKey` elsewhere) — while a row is recording, the
pane's OWN capture-phase listener sees it first (exactly like a live
keystroke) and the caller polls `GET /settings/shortcuts` afterward for the
badge to update or a refusal to appear (the commit itself round-trips through
an async `setPatch` write, so this driver carries no built-in settle-wait,
same posture as the slash-menu `key` driver above); with Settings closed (or
a different pane active) the IDENTICAL call instead exercises the REAL global
shortcut dispatch path (`App.tsx`'s `matchKeymap` handler) — the one seam
that proves a rebind took effect end-to-end, not just that the Settings row
displays it. `POST .../shortcuts/remove` clicks a badge's "×";
`POST .../shortcuts/reset` clicks the row's Reset button — both round-trip
through the real `store.setPatch` settings.json write and carry the same
commit-race `waitUntil` guard as `mcpToggle`/`skillsToggle`.

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/shortcuts` | — | `{mounted, query, rows:[{action, name, description, editable, bindings:[string], overridden, unassigned, recording}], errorText}` |
| `POST /settings/shortcuts/record` | `{action:string, slotIndex?:number}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_editable"\|"control_not_present"\|"did_not_start"}` |
| `POST /settings/shortcuts/press` | `{key:string, mod:boolean, shift?:boolean}` | `{ok:true}` |
| `POST /settings/shortcuts/remove` | `{action:string, slotIndex:number}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"control_not_present"\|"did_not_remove"}` |
| `POST /settings/shortcuts/reset` | `{action:string}` | `{ok:true}` \| `{ok:false, reason:"pane_not_mounted"\|"row_not_found"\|"not_overridden"\|"control_not_present"\|"did_not_reset"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"shortcuts"}'
curl "${A[@]}" "$B/settings/shortcuts"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/shortcuts/record -d '{"action":"terminal.toggle"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/shortcuts/press -d '{"key":"d","mod":true}'
curl "${A[@]}" "$B/settings/shortcuts"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/shortcuts/reset -d '{"action":"terminal.toggle"}'
```

The persisted override lands at the SAME `ANYCODE_SETTINGS_PATH`-overridable
`settings.json` every other settings-persisting probe/driver above writes to
(`keybindings.overrides`, `shared/settings.ts`) — no dedicated home lever of
its own. See `apps/desktop/scripts/keybindings-ui-smoke.mjs` for the
reference wiring.

### Provider connections pane probe/driver (TASK.45 W12)

Mirrors the Settings dialog's Provider pane (`ConnectionTile`/
`ConnectionDrawer.tsx`) — a DEDICATED route, every prior `/settings*` probe
above stays byte-untouched. `GET /settings/provider` reads the mounted grid
AND the drawer (either the Settings dialog's `ConnectionDrawer` or
WelcomeScreen's chrome-free first-run embed) in one read, same "no mirrored
state" discipline as every other pane probe: `mounted:false` when the grid
isn't rendered, `drawer.open:false` when neither embed is. `rows[].statusTone`
is the tile's own `connection-tile-status-<tone>` class suffix (never a
re-derived guess); `drawer.stage` is `"template"` before a connection exists
yet or `"credential"` once metadata is minted and the credential section has
activated (add/edit sequencing, TASK.45's own cut).

`POST .../provider/add` clicks the trailing "+ Add connection" tile.
`POST .../provider/tile` clicks a tile's own select button (make-default for
new sessions — a no-op, `{ok:true}`, if it's already the default).
`POST .../provider/menu` opens a tile's overflow menu (if not already open)
and invokes ONE of its four actions (`edit`|`replace_key`|`check`|`delete`);
`delete` additionally drives the inline confirm popover's own Delete button —
a distinct node from the menu item that opened it. `POST
.../provider/drawer/set` drives the drawer's fields via the same
native-setter discipline as every other form driver in this channel, setting
only the fields present in the body. `POST .../provider/drawer/submit` /
`save-key` / `clear-key` click the drawer's own buttons and settle once the
settings-store's `snapshot` object reference changes (a fresh object on every
successful `connectionCreate`/`Update`/`setSecret`/`clearSecret` round-trip —
more reliable than the rendered text, which can read byte-identical
before/after a same-shaped credential replace). `POST .../provider/drawer/close`
mirrors X-then-Done-then-refusal — the WelcomeScreen embed has neither.

| Method / path | Body | Returns |
|---|---|---|
| `GET /settings/provider` | — | `{mounted, envOverrideVisible, rows:[{connectionId, providerName, displayName, model, statusText, statusTone, selected, menuOpen, confirmingDelete}], drawer:{open, embedded, stage, providerId, templateLocked, label, model, transport, transportOptions, baseUrlVisible, baseUrl, authKind, apiKeyEntered, credentialStatusText, oauthPending, primaryButtonLabel, primaryButtonEnabled, saveKeyEnabled, clearKeyEnabled}}` |
| `POST /settings/provider/add` | `{}` | `{ok:true}` \| `{ok:false, reason:"grid_not_mounted"\|"add_tile_not_present"\|"did_not_open"}` |
| `POST /settings/provider/tile` | `{connectionId}` | `{ok:true}` \| `{ok:false, reason:"grid_not_mounted"\|"connection_not_found"\|"tile_not_present"\|"did_not_settle"}` |
| `POST /settings/provider/menu` | `{connectionId, action:"edit"\|"replace_key"\|"check"\|"delete"}` | `{ok:true}` \| `{ok:false, reason:"grid_not_mounted"\|"connection_not_found"\|"menu_trigger_not_present"\|"menu_did_not_open"\|"menu_item_not_present"\|"confirm_did_not_open"\|"confirm_delete_not_present"\|"did_not_settle"}` |
| `POST /settings/provider/drawer/set` | `{providerId?, label?, model?, transport?, baseUrl?, apiKey?}` | `{ok:true}` \| `{ok:false, reason:"drawer_not_open"\|"<field>_unavailable"}` |
| `POST /settings/provider/drawer/submit` | `{}` | `{ok:true}` \| `{ok:false, reason:"drawer_not_open"\|"submit_disabled"\|"button_not_present"\|"did_not_settle"}` |
| `POST /settings/provider/drawer/save-key` | `{}` | `{ok:true}` \| `{ok:false, reason:"drawer_not_open"\|"save_key_disabled"\|"button_not_present"\|"did_not_settle"}` |
| `POST /settings/provider/drawer/clear-key` | `{}` | `{ok:true}` \| `{ok:false, reason:"drawer_not_open"\|"clear_key_disabled"\|"button_not_present"\|"did_not_settle"}` |
| `POST /settings/provider/drawer/close` | `{}` | `{ok:true}` \| `{ok:false, reason:"no_close_affordance"\|"close_control_not_present"\|"did_not_close"}` |

```bash
curl "${A[@]}" "${J[@]}" -X POST $B/settings/pane -d '{"paneId":"provider"}'
curl "${A[@]}" "$B/settings/provider"
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/add -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/drawer/set -d '{"providerId":"z-ai","label":"Work"}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/drawer/submit -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/drawer/set -d '{"apiKey":"sk-..."}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/drawer/save-key -d '{}'
curl "${A[@]}" "${J[@]}" -X POST $B/settings/provider/drawer/close -d '{}'
```

### Generic focus probe (TASK.45 W12-smoke)

A DEDICATED, shell-level route — no pane above is widened to carry this.
`document.activeElement` is read directly, so it works regardless of which
screen/dialog is mounted (WelcomeScreen, the Settings dialog, or neither).
Added because no existing probe surfaced which element is focused, which a
live a11y smoke (initial focus on mount, focus-trap/return) needs to assert
against the real DOM rather than re-deriving it from local component state.
`present:false` (every other field `null`/`false`) is a normal reading, not
an error — focus sits on `<body>` or nothing focusable exists yet.

| Method / path | Returns |
|---|---|
| `GET /focus` | `{present, tagName:string\|null, role:string\|null, ariaLabel:string\|null, className:string\|null, disabled}` |

```bash
curl "${A[@]}" "$B/focus"
```

See `apps/desktop/scripts/provider-connections-ui-smoke.mjs` for the
reference wiring.

### LSP / Hooks panel probes/drivers (slice P7.25 F3, W3)

Mirrors `LspPanel.tsx`/`HooksPanel.tsx` (`design/slice-P7.25-cut.md` §3 W3) —
DOM probes/drivers, same "no mirrored state" discipline as the todo-panel
probe above. Both panels render once for the ACTIVE tab only (App.tsx, not
per `data-tab-id`), so these routes take `tabId` as a `?tabId=` query param
(GET) / `{tabId}` body (POST) — same shape as `GET /transcript/scroll` and
`POST /queue/clear` above — rather than a `/tabs/:tabId/...` path segment,
and refuse `{ok:false, reason:"tab_not_active"}` when it doesn't match the
active tab. A closed panel reads as `open:false` with its other fields at
their empty defaults, not an error. `servers[].state` is the raw
`LspServerState` token (`"not_started"|"initializing"|"ready"|"crashed"|
"disposed"`), read off the row's own `lsp-state-<state>` CSS class —
byte-parity with the on-screen badge, not a re-derived guess.
`groups[].event` is a real `HookEvent` string (`HooksPanel.tsx`'s
`formatHookEvent` labels are byte-identical to the enum values). The toggle
routes drive a REAL click on the `SessionHeader` toggle button
(`aria-label="Toggle LSP status"` / `"Toggle hooks"`) — no store poke, no
second path.

| Method / path | Body | Returns |
|---|---|---|
| `GET /panels/lsp?tabId=` | — | `{ok:true, open, counts:string\|null, servers:[{name, state}]}` \| `{ok:false, reason:"tab_not_active"}` |
| `POST /panels/lsp/toggle` | `{tabId}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"}` |
| `GET /panels/hooks?tabId=` | — | `{ok:true, open, configError:string\|null, groups:[{event, count}]}` \| `{ok:false, reason:"tab_not_active"}` |
| `POST /panels/hooks/toggle` | `{tabId}` | `{ok:true}` \| `{ok:false, reason:"tab_not_active"}` |

```bash
curl "${A[@]}" "$B/panels/lsp?tabId=$TAB"
curl "${A[@]}" "${J[@]}" -X POST $B/panels/lsp/toggle -d "{\"tabId\":\"$TAB\"}"
curl "${A[@]}" "$B/panels/hooks?tabId=$TAB"
curl "${A[@]}" "${J[@]}" -X POST $B/panels/hooks/toggle -d "{\"tabId\":\"$TAB\"}"
```

See `apps/desktop/scripts/lsp-hooks-ui-smoke.mjs` for the reference wiring,
including the live-push proof (polling `GET /panels/lsp` for an unsolicited
server-state transition with no Refresh/driver action in between).

### Checkpoint timeline / rewind probe+driver (slice P7.26/R2, W3)

Mirrors `TimelinePanel.tsx` (`design/slice-P7.26-R2-ratification.md` §1 W3),
same "no mirrored state" discipline as the LSP/hooks panel probes above — a
closed panel reads as `visible:false, items:[]`, not an error; `ok:false` is
reserved for the shared `tab_not_active` refusal. Unlike the LSP/hooks
panels, the checkpoint list is fetched ON DEMAND only (no live push), so `GET
/tabs/:tabId/checkpoints` — alone among the panel probes — actively opens the
panel (or clicks its Refresh button if already open) and waits for the
resulting `checkpoint_list` reply to land before returning, rather than
reading whatever happens to already be there. `POST /tabs/:tabId/rewind`
resolves its target checkpoint by an explicit `checkpointId`, OR by `index`
into the CURRENT newest-first list (same order the panel itself renders in) —
exactly one of the two must be given; dispatches the same `rewind_request`
wire message the panel's own confirm button sends, waits for the `ok`/`err`
reply to land, and returns the resulting `rewindState` (the tab's
`lastRewindResult` plus the live rendered transcript-block count — the
deterministic proof a conversation-restoring rewind actually truncated the
transcript).

| Method / path | Body | Returns |
|---|---|---|
| `GET /tabs/:tabId/checkpoints` | — | `{ok:true, visible, items:[{label, age, reason}]}` \| `{ok:false, reason:"tab_not_active"}` |
| `GET /tabs/:tabId/rewind` | — | `{ok:true, lastResult:{conversationRestored, restoredPaths, safetyId}\|null, transcriptBlockCount}` \| `{ok:false, reason}` |
| `POST /tabs/:tabId/rewind` | `{checkpointId?, index?, scope:"both"\|"files"\|"conversation"}` | same shape as `GET /tabs/:tabId/rewind`, read AFTER the result settles |

`GET /tabs/:tabId/rewind` is the read-only counterpart of the POST action below
— it lets a caller capture a baseline `transcriptBlockCount` (e.g. right after
a turn, before any rewind) without driving one.

```bash
curl "${A[@]}" "$B/tabs/$TAB/checkpoints"
curl "${A[@]}" "$B/tabs/$TAB/rewind"
curl "${A[@]}" "${J[@]}" -X POST $B/tabs/$TAB/rewind -d '{"index":0,"scope":"both"}'
```

See `apps/desktop/scripts/rewind-ui-smoke.mjs` for the reference wiring
(checkpoint capture -> list -> rewind -> transcript-truncation proof ->
rewind-then-continue).

## Layout

- `server.ts` — the `node:http` shell: bind, auth perimeter, body limits, zod
  body validation, routing, discovery file. Transport lives here.
- `handlers.ts` — transport-agnostic command handlers (DI, unit-testable with
  fakes). `callFacade` runs `window.__anycodeAutomation.<method>(...)` in the
  page via `webContents.executeJavaScript` (method is an internal constant, args
  cross as JSON literals — no arbitrary eval).
- renderer facade: `apps/desktop/src/renderer/src/automation.ts` — installed
  DEV-only from `main.tsx`; a snapshot projection over the live zustand stores +
  mirrors of the real UI actions.
