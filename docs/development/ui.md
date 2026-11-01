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

Run the guards from the repository root:

```sh
pnpm --filter @anycode/desktop exec vitest run src/renderer/src/color-literals.test.ts src/renderer/src/tokens-defined.test.ts src/renderer/src/raw-controls.test.ts src/renderer/src/ui-boundary.test.ts
```
