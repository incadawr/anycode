# Dev-only automation and GUI smoke

## Purpose

Desktop smoke scripts in `apps/desktop/scripts/` drive a **development**
AnyCode instance through the loopback automation channel. They verify the real
main → preload → renderer → host path rather than replacing it with a test API.

For example, start-screen smoke creates an isolated profile, exercises task
creation, and saves screenshots as evidence.

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
profile retains screenshots for review. A normal launch does not enter this mode.

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
