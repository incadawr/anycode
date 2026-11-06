# Dev-only automation and GUI smoke

## Purpose

Desktop smoke scripts in `apps/desktop/scripts/` drive a **development**
AnyCode instance through the loopback automation channel. They verify the real
main → preload → renderer → host path rather than replacing it with a test API.

For example, start-screen smoke creates an isolated profile, exercises task
creation, and saves screenshots as evidence.

## Codex orchestration smoke

This driver runs at the app-server level and does not attach to an open app.
From the repository root, with dependencies installed:

```sh
node apps/desktop/scripts/codex-orchestrate-smoke.mjs --fixture-only --keep
```

The fixture mode uses the scripted in-process app-server in the engine tests,
with isolated HOME, CODEX_HOME, user data and temporary paths. It performs no
model request and needs no network. PASS covers the simulated transition and
policy checks only; it does not establish real sandbox or model behaviour.
The optional `--keep` prints the temporary root; otherwise it is removed.

For an explicitly authorised live test on macOS, use a separate account file:

```sh
ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE=1 node apps/desktop/scripts/codex-orchestrate-smoke.mjs \
  --live --bin /absolute/path/to/codex --auth-from /absolute/path/to/auth.json --keep
```

`--model MODEL` optionally selects a low-effort model. The live helper symlinks
only the specified auth file into a fresh CODEX_HOME and uses sandbox-exec to
prevent writes to its source directory; it does not copy the owner's profile or
inherit ambient Codex auth. The retained directory contains private session
artifacts and an auth symlink. The live model sequence is currently scoped to
0.166.0; other admitted versions receive schema-only observations. The driver
reports the binary, version, and per-check PASS/FAIL/SKIP. A missing sentinel
is PASS only when a corresponding attempt is observed; otherwise it is SKIP.
The read and dynamic Agent checks, restart/resume and per-turn application
context marker do not prove developer-instruction priority. The OFF marker is
limited by conversation history. UI menu, slash and reconnect are explicitly
SKIP: this driver neither opens the UI nor replaces the release GUI gate.
A SKIP is not acceptance evidence.

The read and negative sandbox checks require nested seatbelt to be usable. Run
the live smoke outside an enclosing sandbox, for example from a normal Terminal.
The driver preflights sandbox-exec; if it is unavailable these checks are SKIP
and the outcome is incomplete. With a working sandbox, observed attempts give
PASS or FAIL according to the sentinel and read results; unobserved attempts
remain SKIP. Exit code 71 is a sandbox failure, not evidence of enforcement.

When a nested sandbox-exec cannot run, `ORCH_PROBE_NO_SANDBOX_EXEC=1` explicitly
selects an external auth write guard. The auth.json is linked into the isolated
home by symlink and its source must be protected read-only externally; the
result records `authWriteGuard: "external-required"`. The live Agent response
is a fixture: role dispatch/detach/report: not covered by live smoke (covered by integration tests).

## Launching the app from automation

A dev Electron started from an agent shell or CI is not the same as one started
by a person at the desktop. macOS main blocks in `SecItemAdd` until Electron
receives `--use-mock-keychain`, and a windowed launch can fail before creating a
window unless `--no-sandbox` and `--disable-gpu` are passed. New and updated
smoke scripts must therefore launch through the shared helper
`apps/desktop/scripts/smoke-electron-launch.mjs`, never with a hand-written
`spawn("pnpm", ["--filter", "@anycode/desktop", "dev"])`:

```js
import { launchSmokeElectron, smokeElectronArgs } from "./smoke-electron-launch.mjs";

launchSmokeElectron(spawn, { env, remoteDebuggingPort: port });
// or, when the script already owns spawn options:
spawn("pnpm", smokeElectronArgs(), { env, detached: true });
```

`launchSmokeElectron` starts the dev app with `--use-mock-keychain`,
`--no-sandbox` and `--disable-gpu` by default, and removes an inherited
`ELECTRON_CLI_ARGS`/`NO_SANDBOX` so only the switches it built reach Electron.
The three defaults only affect the disposable profile the smoke owns; no manual
flags are needed. A run that must exercise the real OS keychain opts back in
explicitly with `electron: { mockKeychain: false }` (the sandbox and GPU
switches are independently opt-out in the same object; `extra` appends
smoke-specific switches). `remoteDebuggingPort` sets electron-vite's
`REMOTE_DEBUGGING_PORT` lever, which appends `--remote-debugging-port`.

The switches reach the app through electron-vite's literal `--` forwarding
(`ELECTRON_CLI_ARGS`); `pnpm <script> -- ...` preserves that separator. These
switches do not enable automation — the dev-only automation server is still
gated separately.

The migration is incremental. These drivers still build their own launch and
need the same change (alphabetical, one per follow-up):

```text
child-session-explicit-provider-smoke, codex-ctx-quota-live-smoke,
codex-import-live-smoke, codex-install-live-smoke, codex-live-smoke,
codex-profiles-ui-smoke, compact-submit-ui-smoke, ctx-popover-smoke,
custom-provider-live-smoke, env-status-smoke, git-ui-smoke,
keybindings-ui-smoke, lsp-hooks-ui-smoke, mcp-ui-smoke,
model-pricing-ui-smoke, orchestrate-mode-smoke, orchestration-lab,
orchestration-loop-live-smoke, preview-live-smoke, preview-panel-live-smoke,
profile-ui-smoke, prompt-cache-ui-smoke,
provider-dogfood-w13-smoke, queue-smoke, reasoning-ui-smoke, retry-ui-smoke,
rewind-ui-smoke, settings-ui-smoke, sidebar-rowcut-smoke, sidebar-ui-smoke,
skills-ui-smoke, slash-menu-ui-smoke, start-screen-smoke,
model-picker-smoke, subagent-card-smoke, subagents-ui-smoke,
todo-panel-smoke, todo-subagent-smoke, transcript-follow-smoke,
workflow-map-smoke
```

`sidebar-rowcut-smoke` starts `electron-vite` itself rather than `pnpm dev`;
it needs the same switches, passed directly.

For a fully isolated profile, the smoke environment also points the automation
home overrides and telemetry directory into its temporary profile.
`ANYCODE_ISOLATED_SMOKE=1`, combined with the dev automation gate and an
absolute automation home, skips the login-shell PATH probe and the network
manifest refresh. Packaged applications do not honor these overrides.

## Safe release boundary

Automation is for development only.

- The main automation server is compiled only for `electron-vite dev`: the
  production build receives a compile-time `false` gate and contains no server
  chunk.
- The renderer automation facade is also gated by `import.meta.env.DEV`.
- `electron-builder.yml` excludes `out/**/*smoke*/**` from packages.
- Smoke scripts live outside `out/`; start-screen smoke writes screenshots to a
  per-run system-temp directory rather than a release-build input.

After changing this boundary, verify it with:

```bash
pnpm --filter @anycode/desktop build
pnpm --filter @anycode/desktop package:dir
pnpm exec asar list apps/desktop/dist/mac-arm64/AnyCode.app/Contents/Resources/app.asar \
  | rg -i '(smoke|automation)' || true
```

The final command must print nothing. The `mac-arm64` path is platform-specific;
use the actual `app.asar` under `dist/` when necessary.

## Running start-screen smoke

For the first-run connection flow, run:

```bash
node apps/desktop/scripts/first-run-ui-smoke.mjs
# Exercise the compact signed-out account panes using native CLI doubles.
node apps/desktop/scripts/first-run-ui-smoke.mjs --signed-out-engines
```

This opens a disposable development profile, checks all three connection
choices, Settings access, collapsed optional fields, and an API connection
followed by the project draft and a reload that retains readiness. It uses unavailable test CLIs and a fake key;
it makes no provider requests or real account login. Screenshots and the
isolated profile are left in the printed system-temp directory for inspection.
Actual browser/Terminal sign-in still needs a separate account round trip.

You need a configured provider (usually `ANYCODE_API_KEY`, `ANYCODE_MODEL`, and
`ANYCODE_BASE_URL`) and local dependencies.

```bash
node apps/desktop/scripts/start-screen-smoke.mjs
```

The script starts an isolated development profile and removes it afterwards.

Useful options:

```bash
# Attach to an already-running development instance with the automation channel.
node apps/desktop/scripts/start-screen-smoke.mjs --attach

# Keep temporary workspace and profile directories for investigation.
node apps/desktop/scripts/start-screen-smoke.mjs --keep
```

Do not run the dev automation smoke against a packaged app or enable
`ANYCODE_AUTOMATION` in the release workflow.

## Running model settings smoke

```bash
node apps/desktop/scripts/model-overrides-ui-smoke.mjs
```

This uses an isolated profile and a loopback chat-completions fixture, with no
external credentials. It saves two models' context windows and reasoning
choices on one connection, reloads the app, switches A → B → A through the
real model picker and checks each live context budget. It also checks the
unknown-window hint and its shortcut to the current model's context field,
including a save that preserves the connection default and image-input override.
It then edits settings while the host is running and verifies the new windows
and effort on later turns and model switches. Each turn waits for its unique
fixture response and checks the model and reasoning effort on the HTTP request.
Screenshots and the disposable profile stay in the printed temp directory.

## Running workflow-map smoke

For the Workflow run map + collapsed tick strip, run:

```bash
node apps/desktop/scripts/workflow-map-smoke.mjs
# or: pnpm --filter @anycode/desktop smoke:workflow-map
```

This plants a 3-step diamond workflow definition in a disposable temp
workspace, dispatches it through a real model turn (GLM credentials from
`.smoke-secrets/glm.env`, same as the subagent-card smoke), then exercises the
map/ticks probe and driver routes: while the run is live it collapses the card
and asserts the tick strip paints one tick per step with a MIXED bag of
settled and unsettled kinds, expands back and asserts every step id has
exactly one map node and every declared dependency exactly one `from`→`to`
edge, round-trips the map toggle closed and open, and on settle asserts every
node reached a terminal state. If the live model never dispatches the Workflow
tool (one retry allowed), the run reports a documented SKIP and exits 0.
The assertion logic itself is unit-tested in
`apps/desktop/src/main/workflow-map-smoke-assertions.test.ts`, so a
headless environment can still verify the judgements the live run makes.
PNG evidence lands in `apps/desktop/out/workflow-map-smoke/`.

## Running preview loopback smoke

For the pinned per-preview loopback grant, run:

```bash
node apps/desktop/scripts/preview-loopback-smoke.mjs
# or: pnpm --filter @anycode/desktop smoke:preview-loopback
```

This starts an isolated development profile and two throwaway loopback HTTP
fixtures and checks four legs: a preview opened on one origin serves its
relative assets while a second port, the `127.0.0.1` spelling and a WebSocket
to them are denied and legible in the preview console, in-page navigation to
the second port does not commit, a `file:` preview has no loopback grant, and
an explicit open loads the second port and pins only it. No provider
credentials or model requests are needed.

## Workflow for a coding agent

Ask the agent to follow this sequence:

```text
1. Read the relevant source and make the smallest change.
2. Run targeted Vitest tests for the changed area.
3. Run `pnpm --filter @anycode/desktop typecheck`.
4. If UI or packaging changed, run the desktop build.
5. For start-screen or automation changes, run the relevant GUI smoke.
6. Do not commit `out/`, `dist/`, screenshots, profiles, keys, or `working-docs/`.
7. Report the exact verification commands and results.
```

This is process guidance, not a built-in integration with a specific agent.
Claude Code and Codex can follow it only when a developer gives them access to
the local workspace and required provider.


## Checking the packaged executable

Run the artifact's fixed, isolated self-check:

```bash
node apps/desktop/scripts/release-self-check.mjs \
  "$PWD/apps/desktop/dist/mac-arm64/AnyCode.app/Contents/MacOS/AnyCode"
```

The executable's `--self-check` creates a new system-temp profile internally.
It isolates settings, vault, SQLite, Electron userData and account/import homes;
it does not accept a profile path or arbitrary commands. The self-check vault never accesses OS Keychain; encryption is checked
separately by the owner. It checks the actual
packaged renderer, preload, settings IPC and first-run panes, makes no account
login or model request, skips the updater and Codex manifest network refresh,
and exits with a JSON result. It exposes no HTTP control channel. The printed
profile retains screenshots for review. Linux release CI allows an unavailable
screenshot when Xvfb reports `UnknownVizError`, while still running all renderer
and IPC checks; missing screenshots are reported in the app's self-check log.
A normal launch does not enter this mode.

This is a packaging and UI check, not proof that OAuth, Terminal sign-in,
provider credentials or a real model request work. Those require the owner
checks listed in the release policy.

## Provider fixture schema

Seed new profiles with settings version 2 and `provider.connections`, using
`scripts/smoke-provider-profile.mjs`. For env-key fixtures, declare
`credentialFromEnv: true` and isolate the vault. For vault-backed live runs,
pass the existing settings as `sourceSettings`, retain the real connection ID,
and keep the source vault unchanged. Never invent a connection ID and expect
the owner's vault to authenticate it. Migration scenarios deliberately using
version 1 are separate tests and should retain their old fixtures.

## Repo hygiene guard

`apps/desktop/src/main/repo-hygiene.test.ts` fails the suite when any tracked file contains the
literal owner home path (`/Users/<owner>`). When a smoke script needs a per-user default,
derive it from `os.homedir()` / `os.tmpdir()` at runtime (see `apps/desktop/scripts/profile-ui-smoke.mjs`);
when a doc or fixture needs an example path, use the placeholder `/Users/<user>`.
History scrubbing of already-pushed commits is out of scope.


## Codex manual compaction smoke

Codex manual compaction has a credential-free executable-fixture mode:

```bash
node apps/desktop/scripts/compact-submit-ui-smoke.mjs --codex-only
```

It opens isolated Codex fixture tabs and checks Enter, Send, menu submission,
progress, reported context usage, cancellation, busy refusal, and unsupported
app-server refusal. It requires local Electron dependencies and a graphical
session, but no real login or paid provider. These synthetic fixtures do not
prove compaction against the real Codex backend. An independent checker should
inspect `facts.json`, screenshots, and the native request log.

## Running approval expiry smoke

```bash
node apps/desktop/scripts/approval-expiry-smoke.mjs
```

This uses an isolated profile and a loopback provider fixture. It waits for the
normal approval deadlines and captures the countdown, child handoff and expiry,
recovery controls, and a denied card in the printed temporary directory.

Isolated provider automation uses disposable credentials and a fixture-only storage adapter, not the operating system keychain. Startup rejects missing isolation prerequisites or profile paths that do not resolve to the disposable profile. The launcher records its worktree and profile identity for the driver to verify. Review these safeguards before running GUI automation.

Custom provider records have one shared API key: all connections referencing the same record use that key, and replacing or clearing it affects every such connection. Catalog provider connection keys remain scoped to the individual connection.

Isolated CDP drivers request an OS-assigned debugging port and attach through the browser endpoint recorded in the disposable profile. They verify that the listener belongs to the Electron process descended from their launcher and check the owner of each established CDP or automation HTTP socket before sending commands or credentials. This ownership check currently supports macOS; it fails closed elsewhere. The roles smoke uses a separate temporary workspace so the profile remains fresh.

The provider-connections driver also verifies launcher identity and pins each automation request, including quit, to the verified process.

## Engine-switch fixture smoke

Run `node apps/desktop/scripts/engine-switch-ui-smoke.mjs` from the repository.
It uses the isolated launcher, a loopback provider and executable native doubles
for all six directed engine pairs. No account or external provider is used.
The opt-in `ANYCODE_ISOLATED_NATIVE_FIXTURES=1` startup mode admits only exact
copies of the repository native fixture with a fixed interpreter and private
log paths. Discovery sees those two binaries and their directory metadata only;
all ordinary isolation, ownership, worktree and packaged-app refusals still apply.
The feature remains off by default. Screenshots and failure logs stay in the
per-run temporary profile printed by the script.
