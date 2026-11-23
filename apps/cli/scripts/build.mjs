import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../../packages/core/src", import.meta.url));
await build({
  entryPoints: {
    // Keep the CLI and Ink TUI in separate entries (rework, defect 3). The Ink
    // TUI stays lazy because main.ts loads it via a dynamic
    // `await import("./tui.js")`; with code splitting that specifier maps to
    // the emitted dist/cli/tui.js, so ink/react are fetched+parsed ONLY on
    // the --tui path. A single bundled entry hoists the dynamic import's
    // dependencies to the top of the file, loading them on every run — the
    // defect this layout exists to prevent (the lazy import stays lazy).
    "cli/main": `${coreRoot}/cli/main.ts`,
    "cli/tui": `${coreRoot}/cli/tui.tsx`,
    "runtime-worker": `${coreRoot}/codemode/runtime-worker.ts`,
  },
  outdir: `${pkgRoot}dist`,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
