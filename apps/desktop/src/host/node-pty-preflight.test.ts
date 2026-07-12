/**
 * Eternal guard for the node-pty native install (design slice-2.4-cut.md §2.5,
 * spike-node-pty.md §3). It does a REAL pty round-trip — require node-pty, spawn
 * a shell that echoes a marker, read the output, assert the marker came back.
 *
 * This is the standing tripwire for the chmod fix (scripts/fix-node-pty-perms.mjs):
 * if `spawn-helper` loses its `+x` bit again, `pty.spawn()` fails with
 * `posix_spawnp failed` and this test goes red — before the terminal wave (2.4.3)
 * ever ships. It runs under bare vitest/node (N-API ABI stability makes this valid
 * without an Electron host, spike §3). Skipped on platforms node-pty ships no
 * prebuild for (linux), where a from-source rebuild is a packaging concern (2.6).
 */

import { createRequire } from "node:module";
import { platform } from "node:process";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// node-pty ships bundled prebuilds only for darwin + win32 (spike §4). On linux
// there is no prebuild in the tarball and no rebuild toolchain is assumed in the
// gate, so skip rather than fail there.
const HAS_PREBUILD = platform === "darwin" || platform === "win32";

// Marker that cannot appear incidentally in shell startup chatter.
const MARKER = "anycode-pty-preflight-42";

describe("node-pty preflight (native install guard)", () => {
  it.skipIf(!HAS_PREBUILD)(
    "spawns a real pty and reads command output back (chmod +x guard)",
    async () => {
      const pty = require("node-pty") as typeof import("node-pty");

      const shell = platform === "win32" ? "cmd.exe" : "/bin/sh";
      const args =
        platform === "win32" ? ["/c", `echo ${MARKER}`] : ["-c", `echo ${MARKER}`];

      const output = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        let child: import("node-pty").IPty;
        try {
          child = pty.spawn(shell, args, {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: process.env as Record<string, string>,
          });
        } catch (err) {
          reject(err);
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // best-effort teardown
          }
          reject(new Error(`pty produced no output within timeout; got: ${JSON.stringify(buffer)}`));
        }, 8000);

        child.onData((data) => {
          buffer += data;
        });
        child.onExit(() => {
          clearTimeout(timer);
          resolve(buffer);
        });
      });

      expect(output).toContain(MARKER);
    },
    12000,
  );
});
