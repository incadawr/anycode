# Codex onboarding

## Purpose

AnyCode can drive OpenAI's Codex CLI (`codex app-server`) as an alternate
Agent engine alongside the built-in Core engine. This document describes:

- how a user gets a `codex` binary onto their machine (no bundled binary, no
  environment variable required);
- **account profiles** — isolated `CODEX_HOME` sandboxes so several ChatGPT/API
  accounts can be used from the product, each selectable per-session;
- how a Codex conversation can be **imported** into AnyCode's own engine to
  continue on a different model;
- the context-usage ring and subscription-quota display inside a Codex
  session;
- **custom model-provider endpoints** for AnyCode's own (Core) engine — a
  feature that shares only a Settings page with Codex, nothing else;
- the developer/diagnostic `ANYCODE_CODEX_BIN` override that still exists for
  local testing.

All e-mail addresses in this document are placeholders (`user@example.com`).
AnyCode never displays a real address in code, logs, or committed docs.

## Account profiles

### Why profiles exist

A user may have more than one Codex/ChatGPT account (this mirrors a common
pattern of maintaining separate `CODEX_HOME` directories per account, e.g. via
a personal `cx`-style shell wrapper). AnyCode lets you register any number of
such accounts as **profiles** and pick one per new session — switching
accounts never requires restarting the app.

### Layout

```
~/.anycode/codex/
  manifest.json          # cached version-support manifest (see "Binary" below), advisory
  bin/<version>/vendor/<triple>/bin/codex   # binaries AnyCode itself downloaded
  profile-<id>/          # CODEX_HOME for one profile, mode 0700
      auth.json          #  ← either written by `codex` itself at login, or a
                          #    SYMLINK we create pointing at an external auth.json
      sessions/…         #  ← this profile's rollout files (import reads from here)
      config.toml, skills/, rules/, …   # created by `codex` itself on first run
```

Each profile is a **self-contained** `CODEX_HOME`: AnyCode creates only the
directory itself (mode `0700`) and, for `authLink`-profiles, the `auth.json`
symlink described below. It does **not** seed `config.toml`, `skills/`, or
`rules/` — those are created by `codex` on first run/login inside the
profile's own home. This is a deliberate trade-off: a profile's session
behaves the same regardless of what the user's global `~/.codex/config.toml`
says (no MCP servers, base instructions, or default model leak in from the
terminal setup) — isolation is worth more than terminal parity. If you want a
session that matches your terminal `codex` exactly, use the `system`
pseudo-profile or `linkedHome` below.

### The `system` pseudo-profile

`system` always exists, is never persisted, and is never deletable. Choosing
it means AnyCode does **not** set `CODEX_HOME` at all — the child process
inherits whatever `CODEX_HOME` (or lack of one) is ambient in the app's own
environment, i.e. today's pre-profiles behavior, byte-for-byte. It's the
default when no profile is selected and the escape hatch for anyone who
doesn't want isolation.

### `linkedHome`: pointing a profile at an entire external `CODEX_HOME`

A profile can carry `linkedHome: "/absolute/path/to/some/CODEX_HOME"` instead
of living in AnyCode's own tree. AnyCode then just sets `CODEX_HOME` to that
path on spawn — it creates nothing inside it, symlinks nothing, and only
reads/spawns there. This gives instant access to an already-configured
external account directory (for example, one previously set up outside
AnyCode) with zero credential copying. `linkedHome` and `authLink` (below) are
mutually exclusive: a record carrying both is a broken record and is dropped
at the settings boundary.

### The "main" profile and `authLink`

Rather than logging in again for an account you already use in your terminal,
a profile can carry `authLink: "~/.codex/auth.json"` (the `~` is expanded to
the user's home directory by main). AnyCode then creates **its own**
self-contained profile home, but makes `<profile home>/auth.json` a **symlink
pointing outward** at your existing credential file — never the reverse.
AnyCode never writes into `~/.codex` itself; it only reads through the
symlink.

Settings → Codex offers a "Use current account" button that is exactly this
sugar: it creates a profile with `authLink: "~/.codex/auth.json"`, default
label `main` (editable). The button hides itself once a profile with that
exact target already exists, so it can't spawn duplicates by accident — the
schema doesn't forbid duplicates outright, it just isn't offered twice.

`authLink` and `linkedHome` differ in what they share: `linkedHome` points at
someone else's *entire* `CODEX_HOME` (config, skills, sessions, everything);
`authLink` shares *only the credential* and keeps everything else
(`sessions/`, `config.toml`, …) local to AnyCode's own profile tree.

### The `auth.json` guard (lstat safety net)

Before every spawn that uses an `authLink` profile (doctor check, login,
`app-server`), AnyCode checks `<profile home>/auth.json` with `lstat`/
`readlink` only — **it never reads the file's contents**, in any branch. That
check enforces:

| What's found at `auth.json` | What happens |
|---|---|
| nothing (symlink missing) | recreated pointing at the configured target, spawn proceeds (a dangling *target* is not AnyCode's problem — `codex` will just report `signed_out`) |
| a symlink pointing at the configured target | OK, spawn proceeds |
| a symlink pointing somewhere else | **refused** (`error`, no spawn, no auto-repair) — a redirected symlink inside a `0700` home is treated as tampering; only an explicit "Recreate link" action in the UI fixes it |
| a regular file (not a symlink) | **refused** (`error`, no spawn, no auto-deletion) — this is the case the guard exists for: something replaced the symlink with an ordinary file. AnyCode never deletes it automatically, because it might hold a token newer than the owner's (`codex` itself can rewrite via temp+rename, which breaks a symlink) |
| anything else (directory, FIFO, …) | **refused** (`error`, no spawn) |

### Profile status

Codex readiness is a function of **(binary, profile)**, not a single global
flag. Each profile has its own doctor report and its own status, computed in
this strict order (first match wins):

1. no compatible binary found → `not_installed`
2. the profile's home fails the trust/guard check above → `error`
3. binary version is outside the supported range and no risk acceptance is
   recorded for it → `update_required`
4. RPC/spawn/timeout failure talking to `codex` → `error`
5. an account of *any* kind (`chatgpt`, `apiKey`, `amazonBedrock`, or an
   unrecognized-but-present variant) is reported → **`ready`**
6. no account, and the server says auth is required
   (`requiresOpenaiAuth: true`) → `signed_out`
7. no account, and the server says auth is **not** required (e.g. an
   `apiKey`/Bedrock setup configured entirely in `config.toml`) →
   **`ready`**
8. no account, and `requiresOpenaiAuth` isn't present on the wire at all →
   `signed_out` (fail-closed default)

Step 7 is the one behavior change from Codex's original single-account
onboarding: previously any setup without a ChatGPT account was reported
`signed_out`, even a perfectly working API-key configuration. Steps 5/6/8
preserve the original behavior.

The doctor re-runs on app boot (for the active profile), whenever
Settings → Codex opens (for every profile, sequentially — never more than
one `codex app-server` spawned at a time for this), on "Recheck", after
login, and after installing/updating the binary. The registry caps out at
**8 profiles**; creating a 9th is refused with a clear message.

### What's shown, and what never leaves AnyCode's memory

Settings → Codex and the account-profile chip (below) show a profile's
`label` (human-editable name) plus, as a secondary line, the account's e-mail
and plan when the wire reports a `chatgpt`-type account — e.g.
`user@example.com · plus`. This is a deliberate reversal of an earlier
custody rule that never surfaced e-mail at all; the new rule is narrower but
strict:

- e-mail, plan, and quota numbers are held **only in main's in-memory doctor
  cache** and projected to the renderer. They are **never** written to
  `settings.json` (only `id`, `label`, `createdAt`, `linkedHome`/`authLink`,
  and `lastCheck` are persisted).
- they are **never** written to the telemetry log, a file log, or an error
  string.
- the raw credential/token is still never read or stored by AnyCode — it
  stays inside `CODEX_HOME`, owned entirely by `codex`.

### Account-profile chip

When Codex is the selected Agent and at least one profile is registered, a
chip (e.g. `( personal ▾ )`) appears next to the `Agent` selector on the
start screen. Its dropdown lists every profile plus "Add account…" as the
last item. A profile whose cached status is `signed_out` is shown but
**cannot be picked**. Once a session has started, the chip becomes read-only
— `CODEX_HOME` is frozen into the spawned child process for that session's
whole lifetime, so switching accounts on a live session isn't just a UI
choice being withheld, it's architecturally impossible (a session is one
`app-server` process bound to one `CODEX_HOME`).

Profile selection travels with the session: it's stored on `SessionMeta` and
re-resolved (never re-defaulted to whatever is currently "active") when a tab
is resumed after an app restart.

## Normal binary onboarding (no env var)

Open **Settings → Codex**. The pane runs a check automatically on open and
shows one of four states, each with an in-UI transition:

- **Not installed** — no compatible `codex` binary was found. Click
  **Install Codex `<version>`** (see "Downloading the binary" below), or
  **Choose binary…** to point AnyCode at one directly (native file picker;
  the picked path is validated — absolute, exists, executable — before it is
  accepted or saved).
- **Update required** — a `codex` binary was found but its version is outside
  the range the current manifest supports. Click **Update to `<version>`**
  to fetch a supported version, or **Use anyway** to run it at your own risk
  (see below).
- **Sign in required** — a compatible binary and profile were found, but the
  profile's account isn't signed in. Click **Sign in**; AnyCode opens the
  native login page in your system browser and shows a waiting/cancel state
  until it completes. An `authLink` profile has no login flow of its own by
  design — the account it mirrors is refreshed by `codex` itself through the
  symlink, or re-authenticated in a terminal / via the `system` profile — so
  attempting to sign in through such a profile is refused at the IPC
  boundary.
- **Ready** — Codex is installed, version-compatible, and the selected
  profile can make a move. It now appears in the `Agent` selector for new
  sessions — **no app restart is required**.

### Discovery order

AnyCode looks for a binary in this order, using the first one that resolves
to an absolute, existing, executable file:

1. `ANYCODE_CODEX_BIN` (the developer override below), if set.
2. The path you previously confirmed via **Choose binary…**, or one AnyCode
   downloaded itself (persisted in `~/.anycode/settings.json` as
   `codex.binaryPath` — never the env-override value).
3. `PATH` (a plain lookup by joining each `PATH` entry with `codex`/
   `codex.exe` — no shell is ever invoked to do this).
4. Common install locations: `~/.npm-global/bin`, `/opt/homebrew/bin`,
   `/usr/local/bin`, `~/.local/bin` on macOS/Linux; `%APPDATA%\npm` on
   Windows.
5. An explicit file picker (**Choose binary…**).

A rung that finds nothing simply falls through to the next one.

### Downloading the binary

AnyCode does **not** ship a `codex` binary in its build. If none is found (or
the found one is outside the supported range), Settings → Codex offers an
**Install**/**Update** button that fetches one directly:

1. AnyCode reads a version-support **manifest** — `codex-support.json`,
   checked into this repository's public remote and fetched over HTTPS from
   a raw-content URL, cached locally with an ETag (refreshed at most every 6
   hours, or on demand). The manifest carries **only policy** — supported
   version ranges, a recommended version, a minimum — never a download URL,
   a checksum, or a package name. Those three are compile-time constants in
   AnyCode's own source (`@openai/codex` on `registry.npmjs.org`), so a
   tampered manifest cannot redirect the download to a different host or
   package, only lie about which versions are "supported". A compile-time
   floor (`0.144.0` as of this writing) additionally guarantees the manifest
   can never claim a version *below* that floor is supported, closing a
   downgrade-via-forged-manifest path. If the network is unavailable, the
   response doesn't parse, or its declared range falls below the floor,
   AnyCode falls back to a manifest bundled in the app itself — garbage from
   the network can only narrow what's "supported", never widen it.
2. The real Codex binary is published on npm as the *same* `@openai/codex`
   package, under a platform-suffixed version string (e.g.
   `0.144.5-darwin-arm64`) rather than as a separately named package.
   AnyCode resolves the manifest's chosen version plus the current
   `process.platform`/`process.arch` to that suffix and fetches exactly that
   npm version's metadata. Six platform/arch combinations are supported
   (darwin/linux/win32 × arm64/x64); anything else fails closed with an
   "unsupported platform" message instead of guessing.
3. The response is validated (package name matches, version matches, `os`/
   `cpu` fields match the current platform, `dist.integrity`/`dist.tarball`
   are present and the tarball host is exactly `registry.npmjs.org`), then
   the tarball is downloaded and its sha512 is checked against the
   registry's own `dist.integrity` **before a single byte is written as
   executable**. AnyCode never runs `npm install` — it downloads and unpacks
   the tarball itself, so no lifecycle script of a third-party package ever
   executes.
4. Only the `package/vendor/<platform-triple>/` subtree of the tarball is
   extracted (the actual binary plus its runtime-adjacent resources like a
   bundled `rg` and a code-mode host the binary resolves relative to itself)
   — every entry is checked for type (regular file/directory only — a
   symlink or hardlink inside the archive fails the whole install), path
   containment (no `..`, no absolute paths, must stay under the expected
   subtree), and size/entry-count caps. Extraction happens into a temp
   directory that is only `rename`d into place after the sha512 check has
   already passed.
5. The resulting path (`~/.anycode/codex/bin/<version>/vendor/<triple>/bin/
   codex`) is written to `settings.codex.binaryPath`, which slots into rung
   2 of the discovery ladder above and survives restarts.

Old downloaded versions are **not** removed automatically — only a version
that fails its own install verification is cleaned up — so rolling back to a
previously-installed version stays possible.

### Using an unsupported version anyway

If a found binary's version falls outside the manifest's supported range,
Settings offers **Use anyway**. Accepting records that exact version in
`settings.codex.riskAcceptedVersions` (a per-version list, not a blanket
opt-out — a *different* out-of-range version will ask again) and the status
recomputes as `ready`. A persistent, non-dismissable banner
("Untested Codex version `<v>`") stays visible in Settings and in any Codex
session header while that version is in use.

## Context-usage ring and subscription quota

A Codex session shows the same context-usage ring and popover as a Core
session, with one honest difference: Codex reports overall context usage
(so the ring and percentage render normally) but has **no per-category
breakdown** (no separate accounting for e.g. tool output vs. conversation
history). Where a Core session's popover would show that breakdown, a Codex
popover shows a plain message — *"Breakdown is not available for this
engine"* — instead of a skeleton that would otherwise spin forever waiting
for data that will never arrive.

Below that, the popover shows:

- **Session tokens** — Codex reports a *cumulative* running total per
  session (not a per-turn delta like Core's `finish` event), so AnyCode
  tracks it as a direct replace on every update rather than summing turn
  deltas — summing a cumulative number would multiply it out on every turn.
- **Subscription quota windows** — pulled once via a rate-limits read (so it
  shows up in Settings even before any session starts, and again as a
  starting snapshot when a session opens) and pushed live during a turn as
  the server emits rolling updates. Window labels (`1h`, `5h`, `Daily`,
  `Weekly`, `Monthly`, or a rounded `<N>h`/`<N>d` for anything else) are
  **always derived from the window's actual duration in minutes** as
  reported by the server — never hardcoded, because different plans report
  different windows (a live probe against a real `plus` account showed a
  single populated weekly window, not the "5h + weekly" pair some other
  Codex UIs assume). A field that never arrives is simply not drawn — an
  absent quota block reads as "no data", never as "0%". Credits are shown
  only when the account actually has a credits balance; an unlimited balance
  shows "Unlimited" instead of a number.
- Because the quota push is a **sparse** update (the server's own
  documentation says a `null` field in an update must not erase a
  previously-observed value), AnyCode merges field-by-field: anything
  present and non-null replaces the prior value; anything null or absent
  leaves the prior value untouched. No delivery of this update can ever
  make the displayed snapshot *less* informed than it already was.
- On resuming a Codex session, the context ring shows a neutral "—" rather
  than a false "0%" until the first turn's usage arrives (resuming doesn't
  itself carry a fresh token-usage snapshot from Codex).

A profile with no quota data at all (e.g. an API-key account with no ChatGPT
plan behind it) simply doesn't show the quota block.

## Importing a Codex session (changing harness)

Settings → Codex → **Import a Codex session…** lets you pick up a
conversation that was started in Codex (whether via AnyCode's own Codex
engine or a bare terminal `codex` session using the same profile's home) and
continue it in AnyCode's own engine — including on a different model. The
flow: pick a profile → pick a rollout file from that profile's own
`sessions/` directory (shown with date, working directory, first user line,
and size) → a preview of the conversion, with **honest statistics** about
what had to be dropped or collapsed → **Import & open**, which is disabled
until a target model is chosen.

This is strictly one-directional: AnyCode only ever *reads* the rollout file
and never writes back into `CODEX_HOME`. The imported conversation becomes a
brand-new AnyCode session; the original Codex session is untouched and keeps
existing independently — the two transcripts diverge from that point on and
are never re-linked.

### What gets kept, dropped, or collapsed

Codex's own UI-derived event stream (`event_msg`, `turn_context`,
`world_state` records) is dropped entirely — it duplicates the conversation
content and would double every message if kept. Of the actual conversation
content (`response_item` records):

| Codex content | Becomes | Why |
|---|---|---|
| user/assistant text | verbatim user/assistant message | — |
| an image the user attached | dropped, replaced by a `[image omitted on import]` marker | keeping base64 image data would bloat AnyCode's database; a future improvement, not v1 |
| a `developer`-role message | dropped silently, not shown at all | these are harness-injected instructions (e.g. `AGENTS.md` content), not something the user said — showing them as a user message would misrepresent the conversation |
| model reasoning traces | dropped | AnyCode's history format has no slot for reasoning, and the vast majority of captured traces have no readable summary anyway |
| `exec_command`/`exec` shell calls (and their output) | mapped 1:1 to AnyCode's own `Bash` tool call/result | the **only** tool AnyCode maps 1:1 — every session has a `Bash` tool, so the imported history doesn't claim a capability the target session doesn't have |
| any other tool call (`apply_patch`, `update_plan`, MCP calls, web search, …) | collapsed into a plain text block showing the call and its result | mapping it to a real tool the model doesn't actually have available would be a false capability claim |
| a tool call with no matching result (an interrupted turn — rare, but it happens) | given a synthetic `[interrupted — no result was recorded]` result rather than being dropped | Anthropic's API rejects an unpaired tool call; dropping the call would also erase the fact that something ran |
| an unrecognized top-level record type, an unrecognized tool-call payload type, or an unrecognized message-content part | skipped with a counter, never silently guessed at or dumped verbatim | an unknown payload might carry opaque/encrypted content that shouldn't leak into a transcript |

The import preview shows counts for every one of these (dropped images,
dropped developer blocks, dropped reasoning, collapsed-to-text tool calls,
synthesized cancelled results, unrecognized records/items/parts, malformed
lines) so the statistics are never hidden.

## Custom model providers

Settings → **Custom providers** is a separate feature from everything above
— it doesn't touch Codex, profiles, or the manifest at all. It lets you
point AnyCode's own (Core) engine at any OpenAI-compatible (or Anthropic- or
OpenAI-shaped) HTTP endpoint:

1. Enter a name, base URL, and provider kind, and (for most endpoints) an API
   key.
2. Click **Fetch models** — this request is made by the **main** process,
   never the renderer, because the renderer never holds a decrypted key. The
   returned model list is shown as checkboxes; the models you select become
   the ones that actually show up in AnyCode's model selector.
3. The key is stored in the same secret vault every other provider's key
   uses (keyed `provider.<custom-id>.apiKey`) — no new storage mechanism was
   introduced for this feature.

Because the base URL is user-supplied and the fetch happens from AnyCode's
own main process, the fetch is deliberately restrictive: `https://` is
required except for an explicit `localhost`/`127.0.0.1`/`[::1]` exception,
redirects to a different origin are refused, the response body is capped,
and the key is only ever sent to that one origin, in the request header —
never logged.

**Honest gap:** custom providers live in their own Settings section, separate
from the provider-connection grid/drawer used for built-in catalog
providers. Once created, a custom provider's selected models appear directly
in the model picker(s) — there's no additional "connect" step — but the
polished connection-management UX (editable connection cards, a "this
connection is broken" banner, etc.) that catalog providers get from the
connection drawer doesn't yet extend to custom providers. Closing that gap
is an open, owner-facing follow-up, not something this document should claim
is already built.

## Developer/diagnostic override: `ANYCODE_CODEX_BIN`

Setting `ANYCODE_CODEX_BIN=/absolute/path/to/codex` before launching AnyCode
still works, and always wins at the top of the discovery ladder above — this
is intentional, so a developer can pin a specific build without touching
Settings. It is documented here as exactly that: a **dev/diagnostic
override**, not the product's only entry point. A normal user never needs to
know it exists.

The value must be an absolute path to an existing, executable file; it is
validated exactly like any other candidate on the ladder (never passed
through a shell). It is never written to `settings.json`.

## Packaged builds

The discovery ladder, the profile/account machinery, the binary downloader,
and the bounded doctor/login children all run identically in a packaged
build. `codex app-server` is spawned directly (no shell), as its own
detached process group on macOS/Linux so a bounded close() can reap the
whole group (including any grandchild `codex` may itself spawn) — see
`apps/desktop/src/shared/codex-timeouts.ts` for the exact teardown timing.
Windows uses direct-child teardown only (no process-group signaling), the
same platform split as the host engine's own Codex transport.
