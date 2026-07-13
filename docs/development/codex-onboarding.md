# Codex onboarding

## Purpose

AnyCode can drive OpenAI's Codex CLI (`codex app-server`) as an alternate
Agent engine alongside the built-in Core engine. This document describes how
a user enables Codex from the product (no environment variable required) and
the separate developer/diagnostic override that still exists for local
testing.

## Normal onboarding (no env var)

Open **Settings → Codex**. The pane runs a check automatically on open and
shows one of four states, each with an in-UI transition:

- **Not installed** — no compatible `codex` binary was found. Install the
  Codex CLI, or click **Choose binary…** to point AnyCode at one directly
  (a native file picker; the picked path is validated — absolute, exists,
  executable — before it is accepted or saved).
- **Update required** — a `codex` binary was found but its version is outside
  the supported range (`>=0.144.0 <0.145.0`). Upgrade or downgrade the CLI,
  then click **Recheck**.
- **Sign in required** — a compatible binary was found but no ChatGPT account
  is signed in. Click **Sign in with ChatGPT**; AnyCode opens the native login
  page in your system browser and shows a waiting/cancel state until it
  completes.
- **Ready** — Codex is installed, version-compatible, and signed in. It now
  appears in the `Agent` selector for new sessions — **no app restart is
  required** (Settings pushes a live refresh the moment onboarding
  completes).

### Discovery order

When you click **Recheck** (or on the pane's first mount, or once
automatically in the background at app launch), AnyCode looks for a binary in
this order, using the first one that resolves to an absolute, existing,
executable file:

1. `ANYCODE_CODEX_BIN` (the developer override below), if set.
2. The path you previously confirmed via **Choose binary…** or a prior
   successful discovery (persisted in `~/.anycode/settings.json` as
   `codex.binaryPath` — never the env-override value).
3. `PATH` (a plain lookup by joining each `PATH` entry with `codex`/
   `codex.exe` — no shell is ever invoked to do this).
4. Common install locations: `~/.npm-global/bin`, `/opt/homebrew/bin`,
   `/usr/local/bin`, `~/.local/bin` on macOS/Linux; `%APPDATA%\npm` on
   Windows.
5. An explicit file picker (**Choose binary…**).

A rung that finds nothing simply falls through to the next one — a stale
`ANYCODE_CODEX_BIN` pointing at an uninstalled dev build, for example, does
not block AnyCode from finding a real install elsewhere.

### What gets stored, what never does

AnyCode persists only `codex.binaryPath` (the confirmed absolute path — never
the `ANYCODE_CODEX_BIN` value) and `codex.lastCheck` (status, version, and a
timestamp) in `~/.anycode/settings.json`. **AnyCode never reads or stores a
raw Codex/ChatGPT token.** The credential stays inside `CODEX_HOME`, owned
entirely by the `codex` CLI; the login flow only ever opens a browser URL and
watches for a native "login completed" signal from the CLI itself.

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

The discovery ladder and the bounded doctor/login children run identically in
a packaged build. `codex app-server` is spawned directly (no shell), as its
own detached process group on macOS/Linux so a bounded close() can reap the
whole group (including any grandchild `codex` may itself spawn) — see
`apps/desktop/src/shared/codex-timeouts.ts` for the exact teardown timing.
Windows uses direct-child teardown only (no process-group signaling), the
same platform split as the host engine's own Codex transport.
