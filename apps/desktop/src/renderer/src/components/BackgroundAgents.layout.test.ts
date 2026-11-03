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
  for (const label of ["background-agents-progress", "background-agents-waiting"]) {
    const styles = rule(label);
    expect(styles).toMatch(/flex:\s*0 1 auto/);
    expect(styles).toMatch(/min-width:\s*0/);
    expect(styles).toMatch(/overflow:\s*hidden/);
    expect(styles).toMatch(/white-space:\s*nowrap/);
    expect(styles).toMatch(/text-overflow:\s*ellipsis/);
  }
  expect(rule("background-agents-action")).toMatch(/flex-shrink:\s*0/);
  expect(rule("background-agents-action:first-of-type")).toMatch(/margin-left:\s*auto/);
});
