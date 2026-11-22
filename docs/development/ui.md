# UI conventions

Build new UI with the tokens in `apps/desktop/src/renderer/src/tokens.css`
and `accents.css`. Use components from `ui/`. When changing a screen, migrate
the affected fragment to the kit.

Import kit components only through [`ui/index.ts`](../../apps/desktop/src/renderer/src/ui/index.ts).
The kit owns native control markup; application screens use the public components.

A new color literal outside `tokens.css` or `accents.css` is a blocking review
finding. New raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`
elements and `role="menu"` roots outside `ui/` are also blocking findings;
use their kit counterparts.

`color-literals.test.ts` counts renderer literals per file, excluding tests and
comments. Existing literals (including scrims and terminal fallbacks) are a
migration baseline, not an allowance for new colors. New files have a zero
baseline. The test fails both when counts grow and when they shrink: after
removing literals, lower that file's `BASELINE` entry (or remove a zero entry)
in the same change. Never increase the baseline to admit new UI literals.
`raw-controls.test.ts` applies the same per-file ratchet to native controls outside
`ui/`: lower its `BASELINE` when migrating a fragment, and never increase it.
`ui-boundary.test.ts` enforces the public entry and independence from app state.
`tokens-defined.test.ts` checks that referenced custom properties are defined.
`typography-tokens.test.ts` and `overlay-boundary.test.ts` are described below.

Run the guards from the repository root:

```sh
pnpm --filter @anycode/desktop exec vitest run src/renderer/src/color-literals.test.ts src/renderer/src/tokens-defined.test.ts src/renderer/src/raw-controls.test.ts src/renderer/src/ui-boundary.test.ts src/renderer/src/typography-tokens.test.ts src/renderer/src/overlay-boundary.test.ts
node scripts/check-ui-baselines.mjs --base origin/next
```

## Overlays, menus and toasts

- `Modal` uses a native `<dialog>` in the top layer. Its slots are `headerExtra`,
  `children` (scrollable body), and `footer`; sizes are `sm`, `md`, and `lg`
  (`wide` aliases `lg`). The title and subtitle supply `aria-labelledby` and
  `aria-describedby`. Focus stays inside, Escape closes it, and focus returns
  to the trigger when it closes.
- `Drawer` is a side panel with a sticky header and footer, a scrollable body,
  and `md` and `lg` sizes.
- Overlay backdrops use `--bg-scrim`; do not add color literals to the kit.
- `Menu` provides a trigger and a `role="menu"` menu with `MenuItem` and
  `MenuSeparator`. Arrow keys and Home/End navigate; Escape returns focus.
- `AnchoredPanel` is a non-modal `role="dialog"` detail window anchored to a trigger (`anchorRef`, `side`, `align`, `headerActions`); it flips above/below, clamps to the viewport, and closes on Escape, outside click or the close button.
- `Popover` is a manually positioned, viewport-constrained **menu**: it hard-codes `role="menu"` and menu keyboard navigation. Do not use it for informational content; use `AnchoredPanel` for informational panels.
- `Toast` supports `info`, `ok`, `success`, `run`, `warn`, `warning`, `bad`,
  `error`, and `neutral` tones. It uses polite status announcements, except
  errors use assertive alerts. `duration` enables auto-dismissal and the timer
  is cleared on unmount. `ToastStack` optionally labels its region.

## Typography and overlay guards

Both guards keep a named legacy baseline in a JSON file next to the test
(`typography-baseline.json`, `overlay-baseline.json`): one entry per violation,
without line numbers. The test fails on a new entry and on a stale one (a
violation that was fixed), so remove the entry in the same change that fixes it.
Never add entries to a legacy baseline to admit new UI.

`scripts/check-ui-baselines.mjs --base <rev>` makes the shrink-only rule real: it
reads both baselines at HEAD and at the base revision and fails when HEAD has an
entry (counted as a multiset) the base does not. Run it locally against
`origin/next`; the `PR check` workflow runs it with the pull request's base SHA.
`overlay-baseline.json` `exceptions` are not compared: they may grow when a
reviewer agrees the element is layout. The check skips a baseline file that does
not exist at the base (the guard is being introduced).

**`typography-tokens.test.ts`** checks, in every renderer file including `ui/`:
`font-size`, `line-height` and the `font` shorthand in CSS, in CSS strings and
`<style>` text embedded in scripts, and `fontSize` / `lineHeight` / `font` in
style objects of both `.ts` and `.tsx`. Allowed values: exactly `var(--fs-*)` /
`var(--lh-*)` tokens defined in `tokens.css` (an arbitrary `var(--x)` or a numeric
fallback is not a token), and the keywords `inherit`, `initial`, `unset`,
`revert`, `normal`. The shorthand is parsed into parts (weight/style, an `--fs-*`
size, an optional `--lh-*` or `normal` height, a family). Declaring `--fs-*` or
`--lh-*` anywhere except `tokens.css` is a violation, because it would change what
a token means. A same-file `const` that resolves to an allowed token string passes (a name declared more than once in the file, in any scope, is treated as unresolved);
any other non-literal value is a violation. The guard cannot detect a missing
`font-size` or a wrong choice of token: give primitives typographic defaults and
check the result in the browser.

**`overlay-boundary.test.ts`** scans the whole renderer outside `ui/` (App.tsx,
components, hooks, shared CSS). Scripts are parsed with the TypeScript AST:
`role` of `menu`, `dialog` or `alertdialog` in any literal form (`role="menu"`,
`role={"menu"}`, a plain template, a same-file `const`, either branch of a
conditional, a literal object spread `{...{ role: "dialog" }}`), `aria-modal`,
native `<dialog>`, the `popover` attribute, and `createPortal` (aliased imports
included). A `role` that is not a compile-time string is reported as
`role=<dynamic>`. CSS, CSS strings, `<style>` text and inline style objects are
checked for `position: fixed`, for `position: absolute` together with `z-index`,
and for a position set through `var()` or another expression (`position: dynamic`).
Selector lists are split and the declarations of one selector are merged within
its at-rule; the cascade is not modeled, so a dangerous declaration counts even if
a later rule overrides it. JSX entries are keyed by component plus the element's
static tag, class and id, so swapping one menu for another in the same component
shows up. Class names such as `popover` or `dialog` are only a hint for reviewers.

There are two lists in `overlay-baseline.json`:

- `legacy`: hand-made overlays that await migration to the kit. Shrink-only; it
  changes only by removing entries when a fragment moves to the kit.
- `exceptions`: documented non-overlay layout (window chrome, split panes, resize
  handles), each with a one-line reason. It may grow, but only when a reviewer
  agrees the element is layout and not an overlay; an overlay is never an exception.
  Both lists fail on stale entries.

What the guards cannot see is review responsibility: a new element that reuses an
already baselined overlay class (the CSS baseline does not count usages),
`position` and `z-index` split across different classes, values built at runtime
or spread from a variable (`{...props}`), aliasing through destructuring
(`const { createPortal } = ReactDOM`), and, more generally, whether an element is an
overlay at all. When reviewing, check the diff of both JSON files and new uses of
legacy classes.

The `PR check` workflow runs for pull requests into `next` and `master`: baseline
check, typecheck and the full vitest suite. It is only a gate once the branch
protection rules make it a required check.

## UI hand-in

A task that changes how the UI looks is handed in with:

- a screenshot of the actual changed state taken from the running app (the
  Gallery does not replace it), plus the commit, theme, window size and the steps
  to reproduce;
- for an overlay: long content, window edges, Escape and focus behavior according
  to its semantics. A modal traps focus; a non-modal panel does not trap focus.
  Focus returns to the trigger as the primitive's contract says (for example
  `AnchoredPanel` returns it on close);
- the guards, `scripts/check-ui-baselines.mjs` and the affected kit tests run
  before hand-in.

Non-visual changes need no screenshot.
