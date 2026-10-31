# Dev-only automation and GUI smoke

## Purpose

Desktop smoke scripts in `apps/desktop/scripts/` drive a **development**
AnyCode instance through the loopback automation channel. They verify the real
main → preload → renderer → host path rather than replacing it with a test API.

For example, start-screen smoke creates an isolated profile, exercises task
creation, and saves screenshots as evidence.

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
profile-ui-smoke, prompt-cache-ui-smoke, provider-connections-ui-smoke,
provider-dogfood-w13-smoke, queue-smoke, reasoning-ui-smoke, retry-ui-smoke,
rewind-ui-smoke, settings-ui-smoke, sidebar-rowcut-smoke, sidebar-ui-smoke,
skills-ui-smoke, slash-menu-ui-smoke, start-screen-smoke,
subagent-card-smoke, subagents-ui-smoke, task106-model-picker-smoke,
todo-panel-smoke, todo-subagent-smoke, transcript-follow-smoke,
workflow-map-smoke
```

`sidebar-rowcut-smoke` starts `electron-vite` itself rather than `pnpm dev`;
it needs the same switches, passed directly.

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

For the Workflow run map + collapsed tick strip (Taskana 4161), run:

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
History scrubbing of already-pushed commits is out of scope (see Taskana 4163).

## Running approval expiry smoke

```bash
node apps/desktop/scripts/approval-expiry-smoke.mjs
```

This uses an isolated profile and a loopback provider fixture. It waits for the
normal approval deadlines and captures the countdown, child handoff and expiry,
recovery controls, and a denied card in the printed temporary directory.
