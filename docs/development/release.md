# Release policy

## Current stage

AnyCode starts its public version line at **0.0.1 Alpha**.

| Stage | Versions | Meaning |
|---|---|---|
| Alpha | `0.0.x` | Active development; API, storage, and UI may change. |
| Beta | `0.1.x` and later | Begins after the primary user journey stabilizes; changes are documented for users. |

Version `0.0.1` must match in the root manifest and all workspace packages that
ship together (`@anycode/desktop`, `@anycode/core`,
`@anycode/cli`).

## Releasing a change

1. Choose the next SemVer number and update package manifests together.
2. Add a concise user-facing entry to [`CHANGELOG.md`](../../CHANGELOG.md):
   `Added`, `Changed`, `Fixed`, `Removed`, or `Security`.
3. Run typecheck, targeted tests, and the desktop build; for UI flows, run the
   appropriate smoke from the [automation guide](automation-smoke.md).
4. Create annotated tag `v<version>` only after the verified commit has been
   merged and pushed.
5. Push the tag. Pushing is what starts the release — the tag alone does
   nothing until it reaches the remote.

`CHANGELOG.md` records functional changes, not internal refactor-only noise.
Detailed implementation notes and private research remain outside Git in
`working-docs/`.

## What CI does with the tag

`.github/workflows/release.yml` reacts to a `v*` tag push: it runs typecheck and
the test suite once on Linux, then packages macOS (arm64 + x64), Windows (NSIS
x64), and Linux (AppImage x64) in parallel.

Every job uploads into the **draft** GitHub release for that tag, and a final job
sets the release body from the tag's `CHANGELOG.md` section. A tag whose version
has no changelog section fails that job by design.

A tag push therefore never ships anything on its own. The release stays a draft,
invisible to users, until a human reviews it and presses Publish. Running the
workflow manually (`workflow_dispatch`) is always a dry run: it builds and
touches no release.

## Signing

**Alpha releases are unsigned on every platform.** Signing is planned for the
beta. Users clear the first launch themselves: SmartScreen's **More info → Run
anyway** on Windows, **Privacy & Security → Open Anyway** on macOS.

Unsigned does not mean "no signature at all" on macOS, and the difference is the
whole point. electron-builder repacks the Electron bundle and, with
`mac.identity: null`, signs nothing — so the bundle keeps Electron's linker
signature while its own seal is missing, and that *invalid* state is what makes
macOS call a downloaded build **damaged**, with no way out of the dialog. The
`afterPack` hook (`apps/desktop/scripts/adhoc-sign-mac.mjs`) therefore ad-hoc
signs unsigned bundles, which needs no Apple credential and demotes the refusal
to the ordinary, clearable unidentified-developer prompt. The workflow verifies
the signature of every macOS build, signed or not, so a bundle that would ship
"damaged" fails the release instead.

### When macOS signing is turned on

The plumbing is already in place; it activates on the presence of the secrets
`MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `MACOS_CSC_NAME`, `APPLE_API_KEY_P8`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`. It needs a **Developer
ID Application** certificate, which only a team's Account Holder can issue —
Apple Development and Apple Distribution certificates cannot sign a build for
distribution outside the App Store, and `notarytool` rejects them.

`APPLE_API_KEY_P8` holds the **base64 of the `.p8` file**, not the key text —
`notarytool` takes a filesystem path, and the workflow decodes the secret to a
temporary file before pointing electron-builder at it.

### Windows

Windows is a separate decision from macOS. A code-signing certificate now
requires the private key on FIPS 140-2 Level 2 hardware or a cloud HSM, so the
cheap `.pfx`-in-a-secret route no longer exists, and an ordinary certificate
would still not clear SmartScreen immediately — SmartScreen reputation is earned
by download volume, not bought. If this is revisited, the target mechanism is
Azure Artifact Signing via electron-builder's `win.azureSignOptions`.
