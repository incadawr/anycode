import { defineConfig } from "vitest/config";

/**
 * Package-local config so test runs anchored at this package resolve correctly.
 * The root config's globs are relative to the repo root; when vitest is invoked
 * with cwd = apps/desktop (e.g. `npx vitest run src/host`), it resolves this
 * nearest config instead, whose include glob is relative to the package.
 * Full-repo runs from the root still use the root config.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Boot wiring suites mock Electron without the peer lifecycle hooks; the on-by-default
    // capability is pinned off here and enabled explicitly by the tests that cover it.
    env: { ANYCODE_NATIVE_SESSIONS_ENABLED: "0" },
    include: ["src/**/*.test.ts"],
  },
});
