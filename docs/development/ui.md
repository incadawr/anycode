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

## Typography and overlay guards

Both guards use named baselines: one entry per violation, written as
`file | selector or component | property or signal | value`, with no line numbers.
They fail on a new entry and on a stale one (a violation that was fixed), so a
baseline can only shrink; remove the entry in the same change that fixes it.
Never add entries to a legacy baseline to admit new UI.

**`typography-tokens.test.ts`** checks `font-size`, `line-height` and the `font`
shorthand in all renderer CSS (including `ui/`) and inline `fontSize` / `lineHeight`
in TSX. Allowed values: exactly `var(--fs-*)` / `var(--lh-*)` tokens defined in
`tokens.css` (an arbitrary `var(--x)` or a numeric fallback is not a token), and the
keywords `inherit`, `initial`, `unset`, `revert`, `normal`. The shorthand needs an
`--fs-*` token and no literal sizes. The guard cannot detect a missing
`font-size` or a wrong choice of token: give primitives typographic defaults and
check the result in the browser.

**`overlay-boundary.test.ts`** scans the whole renderer outside `ui/` (App.tsx,
components, shared CSS). JSX/TS is parsed with the TypeScript AST: `role` with
`menu`, `dialog` or `alertdialog` in any literal form (`role="menu"`,
`role={"menu"}`, conditional expressions), `aria-modal`, native `<dialog>`, the
`popover` attribute and `createPortal`. CSS (declarations of one selector are
merged) and inline styles are checked for `position: fixed` and for
`position: absolute` together with `z-index`. Class names such as `popover` or
`dialog` are only a hint for reviewers, not a rule. Static analysis cannot prove
that an element is an overlay, so there are two lists:

- `LEGACY_BASELINE`: hand-made overlays that await migration to the kit.
  Shrink-only; it changes only by removing entries when a fragment moves to the
  kit.
- `LAYOUT_EXCEPTIONS`: documented non-overlay layout (window chrome, split panes,
  resize handles), each with a one-line reason. It may grow, but only when a
  reviewer agrees the element is layout and not an overlay; an overlay is never an
  exception. Both lists also fail on stale entries.

The `PR check` workflow runs these guards on every pull request, but it does not
compare baselines with the target branch: review any diff of these baselines. An
increase of a legacy list is a blocking finding.

## UI hand-in

A task that changes how the UI looks is handed in with:

- a screenshot of the actual changed state taken from the running app (the
  Gallery does not replace it), plus the commit, theme, window size and the steps
  to reproduce;
- for an overlay: long content, window edges, Escape and focus behavior according
  to its semantics (modal traps and restores focus; a non-modal panel does not);
- the guards and the affected kit tests run before hand-in.

Non-visual changes need no screenshot.

Run the guards from the repository root:

```sh
pnpm --filter @anycode/desktop exec vitest run src/renderer/src/color-literals.test.ts src/renderer/src/tokens-defined.test.ts src/renderer/src/raw-controls.test.ts src/renderer/src/ui-boundary.test.ts
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
