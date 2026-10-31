import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
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
      "model-pill-smoke",
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


it("launches isolated automation with absolute node and a controlled search path", () => {
  const spawn = vi.fn();
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  launchSmokeElectron(spawn, { env: { ANYCODE_ISOLATED_SMOKE:"1", ANYCODE_EXPECTED_DESKTOP_ROOT:desktopRoot, PATH:"/unsafe/bin" }, cwd:resolve(desktopRoot, "../..") });
  const [command, args, options] = spawn.mock.calls[0]! as unknown as [string, string[], {cwd:string; env:NodeJS.ProcessEnv}];
  expect(command).toBe(process.execPath);
  expect(args[0]).toBe(resolve(desktopRoot, "node_modules/electron-vite/bin/electron-vite.js"));
  expect(options.cwd).toBe(desktopRoot);
  expect(options.env.PATH).not.toContain("/unsafe/bin");
  const require = createRequire(resolve(desktopRoot, "node_modules/electron-vite/package.json"));
  const { cac } = require("cac") as { cac: (name: string) => { command: (name: string) => { alias: (name: string) => unknown }; parse: (argv: string[], options: { run: boolean }) => { options: Record<string, unknown> } } };
  const parser = cac("electron-vite");
  parser.command("[root]").alias("dev");
  const parsed = parser.parse([command, ...args], {run:false});
  expect(parsed.options["--"]).toEqual(AUTOMATION_SWITCHES);
});
