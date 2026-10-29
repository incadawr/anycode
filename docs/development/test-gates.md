# Test gates

During a fix, run tests for the affected behavior and its callers, plus
`pnpm run typecheck`. Include tests that read changed files directly, such as
styles, fixtures, manifests, and scripts: import-based selection alone cannot
find all of them. Run `cd apps/desktop && pnpm run build` when the change affects
the desktop app, core package, or shared build/dependency configuration, and
use the relevant UI smoke when appropriate.

`node scripts/test-scope.mjs <base-ref>` runs a conservative development scope
for renderer component and CSS changes: the renderer tests, cross-boundary
checks, and tests found through imports. It falls back to the full suite for
other paths; configuration, manifest, data, fixture, snapshot, contract, protocol,
schema, locale, i18n, or generated inputs anywhere in the path; deletions,
renames, or an empty diff. A path in both staged and unstaged diffs also forces
the full suite. It considers committed, staged, unstaged, and untracked changes
independently. The scope is a starting point; add tests for affected behavior
when a dependency is not represented by an import.

Before landing on `next`, run `pnpm run typecheck`, the full `pnpm vitest run`
suite, and the desktop production build. A targeted run helps the development
loop but does not replace this gate. Coordinate full-suite runs with other local
sessions to avoid contention and misleading timeout failures.

Typecheck stores incremental state in this worktree's
`node_modules/.cache/tsc/`. To force a cold check, remove that directory and
rerun `pnpm run typecheck`.

Release CI continues to run the full suite and typecheck before packaging; see
[release policy](release.md) for the remaining release checks.
