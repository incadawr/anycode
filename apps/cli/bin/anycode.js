#!/usr/bin/env node
// AnyCode CLI executable: thin shim over the bundled core entry.
// Mirrors main.ts's isDirectRun tail verbatim (runCli -> process.exit),
// but calls runCli EXPLICITLY: the isDirectRun guard compares argv[1] as-given
// with the module's realpath'd import.meta.url, which diverges under the
// symlinked installs every package-manager bin link creates.
import { existsSync } from "node:fs";

const distUrl = new URL("../dist/cli/main.js", import.meta.url);
if (!existsSync(distUrl)) {
  process.stderr.write(
    "anycode: bundle not found — build it first: pnpm --filter @anycode/cli build\n",
  );
  process.exit(1);
}
const { runCli } = await import(distUrl.href);
runCli()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
