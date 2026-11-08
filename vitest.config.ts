import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Boot wiring suites mock Electron without the peer lifecycle hooks; the on-by-default
    // capability is pinned off here and enabled explicitly by the tests that cover it.
    env: { ANYCODE_NATIVE_SESSIONS_ENABLED: "0" },
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
  },
});
