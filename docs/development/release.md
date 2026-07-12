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

`CHANGELOG.md` records functional changes, not internal refactor-only noise.
Detailed implementation notes and private research remain outside Git in
`working-docs/`.
