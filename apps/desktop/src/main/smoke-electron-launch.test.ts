import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  launchSmokeElectron,
  smokeElectronArgs,
  smokeElectronEnv,
  smokeElectronSwitches,
} from "../../scripts/smoke-electron-launch.mjs";

const AUTOMATION_SWITCHES = ["--use-mock-keychain", "--no-sandbox", "--disable-gpu"];

describe("dev Electron smoke launcher", () => {
  it("isolates the keychain and skips the sandbox and GPU without manual flags", () => {
    expect(smokeElectronSwitches()).toEqual(AUTOMATION_SWITCHES);
    expect(smokeElectronArgs()).toEqual([
      "--filter",
      "@anycode/desktop",
      "dev",
      "--",
      ...AUTOMATION_SWITCHES,
    ]);
  });

  it("keeps every isolation switch individually opt-out for a run that must prove real behaviour", () => {
    expect(smokeElectronArgs({ mockKeychain: false })).toEqual([
      "--filter",
      "@anycode/desktop",
      "dev",
      "--",
      "--no-sandbox",
      "--disable-gpu",
    ]);
    expect(
      smokeElectronSwitches({
        mockKeychain: false,
        noSandbox: false,
        disableGpu: false,
        extra: ["--force-device-scale-factor=2"],
      }),
    ).toEqual(["--force-device-scale-factor=2"]);
    expect(smokeElectronArgs({ mockKeychain: false, noSandbox: false, disableGpu: false })).toEqual([
      "--filter",
      "@anycode/desktop",
      "dev",
    ]);
  });

  it("drops inherited Electron switches and exposes the debugging port", () => {
    const parent = {
      PATH: "/bin",
      NO_SANDBOX: "1",
      ELECTRON_CLI_ARGS: '["--inspect=9229"]',
      REMOTE_DEBUGGING_PORT: "1",
    };
    const env = smokeElectronEnv(parent, { remoteDebuggingPort: 9333 });
    expect(env.NO_SANDBOX).toBeUndefined();
    expect(env.ELECTRON_CLI_ARGS).toBeUndefined();
    expect(env.REMOTE_DEBUGGING_PORT).toBe("9333");
    expect(env.PATH).toBe("/bin");
    expect(parent.NO_SANDBOX).toBe("1");
  });

  it("spawns pnpm with the built argv and a cleaned env copy", () => {
    const child = { pid: 123 };
    const spawn = vi.fn(() => child);
    const env = { ANYCODE_AUTOMATION: "1", NO_SANDBOX: "1" };
    expect(launchSmokeElectron(spawn, { env, detached: true, cwd: "/repo" })).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      "pnpm",
      ["--filter", "@anycode/desktop", "dev", "--", ...AUTOMATION_SWITCHES],
      {
        cwd: "/repo",
        env: { ANYCODE_AUTOMATION: "1" },
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      },
    );
    expect(env.NO_SANDBOX).toBe("1");
  });

  it("is the launcher used by the migrated smoke drivers", () => {
    const drivers = [
      "first-run-ui-smoke",
      "roles-ui-smoke",
      "approval-expiry-smoke",
      "model-overrides-ui-smoke",
      "renderer-reload-smoke-support",
      "dock-squash-smoke",
    ];
    for (const name of drivers) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url)),
        "utf8",
      );
      expect(source, name).toContain("launchSmokeElectron");
      expect(source, name).not.toContain('spawn("pnpm", ["--filter", "@anycode/desktop", "dev"');
    }
  });
});
