import { defineConfig } from "vitest/config";

/**
 * Package-local config so test runs anchored at this package resolve correctly.
 * The root config's globs are relative to the repo root; when vitest is invoked
 * with cwd = packages/core (e.g. `pnpm --filter @anycode/core exec vitest run
 * src/provider`), it resolves this nearest config instead, whose include glob is
 * relative to the package. Full-repo runs from the root still use the root config.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
