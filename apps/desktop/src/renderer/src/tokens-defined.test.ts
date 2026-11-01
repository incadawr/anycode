import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
it("defines every CSS custom property used by the renderer, including fallback references", () => {
  const paths = files(fileURLToPath(new URL("../", import.meta.url)));
  const defined = new Set(paths.filter(p => p.endsWith(".css")).flatMap(p => [...readFileSync(p, "utf8").matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gm)].map(m => m[2]!)));
  // Runtime layout values supplied by DockPanel.tsx and composer-clearance.ts.
  const runtime = new Set(["--dock-width", "--composer-clearance"]);
  const used = paths.filter(p => /\.(css|ts|tsx)$/.test(p) && !/\.test\./.test(p)).flatMap(p => [...readFileSync(p, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]!));
  expect([...new Set(used)].filter(name => !defined.has(name) && !runtime.has(name)).sort()).toEqual([]);
});
