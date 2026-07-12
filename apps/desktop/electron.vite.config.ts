import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**

 *  - main: window/lifecycle entry, plus the host utilityProcess as a second
 *    entry of the same (Node, ESM) target — they share externalization rules
 *    and both need `@anycode/core`'s TS sources bundled directly (no core
 *    build step; its `exports` field points at `./src/index.ts`).
 *  - preload: bundled to a single CJS file — sandboxed preload cannot load ESM.
 *  - renderer: plain web target, zero Node.
 * Output module format/extension is left to electron-vite's own presets
 * (design explicitly says not to hand-tune them) — verified empirically via
 * `pnpm --filter @anycode/desktop dev`/`build`.
 */
export default defineConfig(({ command }) => {
  // Unlike a runtime `app.isPackaged` guard, this is a build-time constant:
  // Rollup can remove main's dev-automation dynamic import and its entire
  // chunk from `electron-vite build` output. `serve` retains the channel for
  // local live smokes.
  const devAutomationBuild = command === "serve";

  return {
    main: {
    // Exclude @anycode/core from externalization so its TS sources are bundled
    // into main/host directly (its `exports` points at ./src/index.ts and there
    // is no core build step). Without this, externalizeDepsPlugin treats the
    // workspace dependency as external and the host crashes at runtime with
    // ERR_MODULE_NOT_FOUND on core's .js-suffixed imports. Its npm deps
    // (ai, @ai-sdk/anthropic, zod) stay external — they resolve from node_modules.
      plugins: [externalizeDepsPlugin({ exclude: ["@anycode/core"] })],
      define: {
        __ANYCODE_DEV_AUTOMATION__: JSON.stringify(devAutomationBuild),
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/main/index.ts"),
            host: resolve(__dirname, "src/host/index.ts"),
          },
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: resolve(__dirname, "src/preload/index.ts"),
          },
          // electron-vite's format auto-detection follows package.json "type"
          // (module -> ESM) whenever it believes Electron supports ESM preload;
          // that support is for *non-sandboxed* preload only. Our window uses
          // sandbox:true (design §2, non-negotiable), which can only load CJS
          // preload scripts — force it explicitly rather than rely on the
          // default (verified empirically: ESM preload throws "Cannot use
          // import statement outside a module" under sandbox:true).
          output: {
            format: "cjs",
          },
        },
      },
    },
    renderer: {
      root: resolve(__dirname, "src/renderer"),
      build: {
        rollupOptions: {
          input: resolve(__dirname, "src/renderer/index.html"),
        },
      },
    },
  };
});
