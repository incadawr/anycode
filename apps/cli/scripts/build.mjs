import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../../../packages/core/src/cli/main.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: `${pkgRoot}dist/cli/main.js`,
  sourcemap: true,
  logLevel: "info",
});
