import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps background agent actions visible when labels are long", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    const match = css.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`));
    expect(match).not.toBeNull();
    return match![1];
  };
  expect(rule("background-agents-item")).toMatch(/min-width:\s*0/);
  for (const label of ["background-agents-progress", "background-agents-waiting", "background-agents-failure"]) {
    const styles = rule(label);
    expect(styles).toMatch(/grid-column:\s*4/);
    expect(styles).toMatch(/min-width:\s*0/);
    expect(styles).toMatch(/overflow:\s*hidden/);
    expect(styles).toMatch(/white-space:\s*nowrap/);
    expect(styles).toMatch(/text-overflow:\s*ellipsis/);
  }
  // The row is one shared grid: the description keeps a floor, the status column shrinks first.
  expect(rule("background-agents-item")).toMatch(/grid-template-columns:\s*auto minmax\(14ch, 1fr\) 4em minmax\(0, 36%\)/);
  expect(rule("background-agents-description")).toMatch(/min-width:\s*14ch/);
  expect(rule("background-agents-elapsed")).toMatch(/text-align:\s*right/);
  const action = rule("background-agents-action");
  expect(action).toMatch(/grid-column:\s*5/);
  expect(action).toMatch(/border:\s*1px solid var\(--border\)/);
  expect(action).toMatch(/color:\s*var\(--text-2\)/);
  expect(action).toMatch(/text-align:\s*center/);
  expect(rule("background-agents-action:last-child")).toMatch(/grid-column:\s*6/);
  expect(rule("background-agents-action:focus-visible")).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
});
