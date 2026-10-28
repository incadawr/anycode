import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "./application-menu.js";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SELF_CHECK_MIN_SETTINGS_PANES, checkSettingsPanes, runSelfCheck, createSelfCheckProfile, selfCheckEnvironment, selfCheckBinaryFs, checkReloadProtection, isReloadAcceleratorText } from "./self-check.js";
it("normal launch creates no self-check profile", () => expect(createSelfCheckProfile(["anycode"])).toBeUndefined());
it("self-check creates its own profile and cannot inherit production state or automation", () => {
  const root = createSelfCheckProfile(["anycode", "--self-check"])!;
  try {
    const original = { HOME: "/owner", ANYCODE_API_KEY: "secret-poison", ANYCODE_MODEL: "real", ANYCODE_SETTINGS_PATH: "/owner/settings", ANYCODE_SECRETS_PATH: "/owner/secrets", ANYCODE_AUTOMATION: "1", ANYCODE_WORKSPACE: "/owner/project", CODEX_HOME: "/owner/account", ELECTRON_RENDERER_URL: "http://localhost/", REMOTE_DEBUGGING_PORT: "9222" };
    const env = selfCheckEnvironment(original, root);
    expect(env.HOME).toBe("/owner");
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_AUTOMATION).toBeUndefined();
    expect(env.ANYCODE_WORKSPACE).toBeUndefined();
    expect(env.REMOTE_DEBUGGING_PORT).toBeUndefined();
    expect(env.CODEX_HOME).toBe(join(root, ".codex"));
    expect(env.ANYCODE_DB_PATH).toBe(join(root, "db.sqlite"));
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).provider.connections).toEqual([]);
    expect(original.ANYCODE_API_KEY).toBe("secret-poison");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("self-check cannot discover an installed CLI through ambient fallback rungs", async () => {
  const { discoverCodexBinary } = await import("./codex-binary.js");
  const { discoverClaudeBinary } = await import("./claude-binary.js");
  const inputs = { env: process.env, fs: selfCheckBinaryFs, envOverride: "/absent-self-check-cli" };
  expect(discoverCodexBinary(inputs).path).toBeNull();
  expect(discoverClaudeBinary(inputs).path).toBeNull();
});

describe("checkSettingsPanes (every Settings pane must open without killing or locking the window)", () => {
  type PaneState = { open: boolean; panel: boolean; failed: boolean; extraModal: boolean };
  function fakeDom(panes: string[], stateFor: (id: string) => PaneState, closes = true) {
    let current = "";
    let settingsOpen = true;
    return async (expression: string): Promise<unknown> => {
      if (expression.includes("querySelectorAll('.settings-dialog [role=tab]")) return panes;
      const click = /getElementById\("settings-tab-([^"]+)"\)\.click\(\)/.exec(expression);
      if (click) { current = click[1]!; return undefined; }
      if (expression.includes("extraModal")) return stateFor(current);
      if (expression.includes("Back to app")) { if (closes) settingsOpen = false; return undefined; }
      if (expression.includes(".settings-dialog')?.open")) return settingsOpen;
      throw new Error(`unexpected expression ${expression}`);
    };
  }
  const ids = Array.from({ length: SELF_CHECK_MIN_SETTINGS_PANES }, (_, i) => `pane-${i}`);
  const healthy: PaneState = { open: true, panel: true, failed: false, extraModal: false };
  const noSleep = async () => {};

  it("passes when every pane renders and Back to app closes Settings", async () => {
    await expect(checkSettingsPanes(fakeDom(ids, () => healthy), noSleep)).resolves.toBeUndefined();
  });
  it("fails on a pane that takes the window down (v0.0.38 Language servers)", async () => {
    await expect(checkSettingsPanes(fakeDom(ids, (id) => (id === "pane-3" ? { ...healthy, open: false, panel: false } : healthy)), noSleep)).rejects.toThrow('"pane-3" took the Settings window down');
  });
  it("fails on a pane that shows the error fallback", async () => {
    await expect(checkSettingsPanes(fakeDom(ids, (id) => (id === "pane-5" ? { ...healthy, failed: true } : healthy)), noSleep)).rejects.toThrow('"pane-5" failed to render');
  });
  it("fails on a pane that leaves a modal over the window (v0.0.39 Roles)", async () => {
    await expect(checkSettingsPanes(fakeDom(ids, (id) => (id === "pane-7" ? { ...healthy, extraModal: true } : healthy)), noSleep)).rejects.toThrow('"pane-7" left a modal open');
  });
  it("fails when the rail lists too few panes, or Settings cannot be closed", async () => {
    await expect(checkSettingsPanes(fakeDom(ids.slice(0, 3), () => healthy), noSleep)).rejects.toThrow("too few panes");
    await expect(checkSettingsPanes(fakeDom(ids, () => healthy, false), noSleep)).rejects.toThrow("Back to app did not close Settings");
  });
});

describe("runSelfCheck capture under Xvfb", () => {
  const ids = Array.from({ length: SELF_CHECK_MIN_SETTINGS_PANES }, (_, i) => `pane-${i}`);

  async function run(captureError: Error | undefined, allowUnavailableCapture: boolean) {
    const root = createSelfCheckProfile(["--self-check"])!;
    const expressions: string[] = [];
    const capturePage = vi.fn(async () => {
      if (captureError) throw captureError;
      return { toPNG: () => Buffer.from("png") };
    });
    const executeJavaScript = vi.fn(async (expression: string): Promise<unknown> => {
      expressions.push(expression);
      if (expression.includes("querySelectorAll('.settings-dialog [role=tab]")) return ids;
      if (expression.includes("extraModal")) return { open: true, panel: true, failed: false, extraModal: false };
      if (expression.includes("window.anycode.settings.get()")) return { provider: { connections: [] } };
      if (expression.includes("Back to app")) return undefined;
      if (expression === "!!document.querySelector('.settings-dialog')?.open") {
        return !expressions.some(item => item.includes("Back to app"));
      }
      return true;
    });
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = runSelfCheck({ webContents: { capturePage, executeJavaScript } }, root, allowUnavailableCapture)
        .then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      return { result: await result, capturePage, expressions, warningCount: warning.mock.calls.length,
        welcome: existsSync(join(root, "welcome.png")), settings: existsSync(join(root, "settings.png")) };
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("continues the full renderer and IPC checks when both captures report UnknownVizError", async () => {
    const result = await run(new Error("UnknownVizError"), true);
    expect(result.result).toBeUndefined();
    expect(result.capturePage).toHaveBeenCalledTimes(2);
    expect(result.warningCount).toBe(2);
    expect(result.welcome).toBe(false);
    expect(result.settings).toBe(false);
    expect(result.expressions).toContain("window.anycode.settings.get()");
    expect(result.expressions.filter(item => item.includes("extraModal"))).toHaveLength(ids.length);
    expect(result.expressions.some(item => item.includes("Back to app"))).toBe(true);
  });

  it("still saves both screenshots when capture works", async () => {
    const result = await run(undefined, true);
    expect(result.result).toBeUndefined();
    expect(result.welcome).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.warningCount).toBe(0);
  });

  it("fails on UnknownVizError without the opt-in and on other errors even with it", async () => {
    expect((await run(new Error("UnknownVizError"), false)).result).toEqual(new Error("UnknownVizError"));
    expect((await run(new Error("capture failed"), true)).result).toEqual(new Error("capture failed"));
  });
});

describe("checkReloadProtection (GitHub #19 packaged reload-shortcut check)", () => {
  function fakeWin(overrides: Partial<{ clearOnKey: boolean; loadOnKey: boolean }> = {}) {
    const state = {
      sentinel: null as string | null,
      loadStarts: 0,
      sentEvents: [] as Array<{ type: string; keyCode: string; modifiers: string[] }>,
      listener: undefined as (() => void) | undefined,
    };
    const executeJavaScript = vi.fn(async (expression: string): Promise<unknown> => {
      if (expression.includes("dataset.anycodeReloadSentinel =")) {
        const match = /dataset\.anycodeReloadSentinel = (\"[^\"]+\")/.exec(expression);
        state.sentinel = match ? JSON.parse(match[1]!) : null;
        return state.sentinel;
      }
      return state.sentinel;
    });
    return {
      state,
      win: {
        focus: vi.fn(),
        webContents: {
          on: vi.fn((_event: string, listener: () => void) => { state.listener = listener; }),
          removeListener: vi.fn(() => { state.listener = undefined; }),
          sendInputEvent: vi.fn((event: { type: string; keyCode: string; modifiers: string[] }) => {
            state.sentEvents.push(event);
            if (event.type === "keyDown") {
              if (overrides.clearOnKey) state.sentinel = null;
              if (overrides.loadOnKey) {
                state.loadStarts += 1;
                state.listener?.();
              }
            }
          }),
          executeJavaScript,
        },
      },
    };
  }

  const safeMenu = { items: [{ label: "File", submenu: { items: [{ role: "close" }] } }] };

  it("accepts the production menu with Electron-style null submenus", async () => {
    const convert = (items: MenuItemConstructorOptions[]): { items: import("./self-check.js").ReloadMenuItem[] } => ({
      items: items.map((item) => ({
        role: item.role?.toLowerCase(),
        label: item.label,
        accelerator: item.accelerator ?? null,
        submenu: Array.isArray(item.submenu) ? convert(item.submenu) : null,
      })),
    });
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const menu = convert(buildApplicationMenuTemplate({
        platform, development: false, onReload: () => {}, onForceReload: () => {}, onToggleDevTools: () => {},
      }));
      await checkReloadProtection(fakeWin().win as never, menu, platform);
    }
  });

  it.each(["reload", "forcereload", "toggledevtools", "viewmenu", "forceReload"])(
    "rejects forbidden Electron role %s", async (role) => {
      await expect(checkReloadProtection(fakeWin().win as never, { items: [{ role }] }, "linux"))
        .rejects.toThrow(`role:${role}`);
    },
  );

  it("rejects a missing application menu", async () => {
    const { win } = fakeWin();
    await expect(checkReloadProtection(win as never, null, "darwin")).rejects.toThrow("Application menu is missing");
  });

  it("rejects a forbidden role and a forbidden accelerator nested in the menu", async () => {
    const { win } = fakeWin();
    await expect(
      checkReloadProtection(win as never, { items: [{ role: "viewMenu" }] }, "darwin"),
    ).rejects.toThrow("viewMenu");
    await expect(
      checkReloadProtection(
        win as never,
        { items: [{ label: "View", submenu: { items: [{ label: "Reload", accelerator: "CmdOrCtrl+R" }] } }] },
        "darwin",
      ),
    ).rejects.toThrow("CmdOrCtrl+R");
  });

  it("sends both R and Shift+R keyDown/keyUp with the platform primary modifier and keeps the sentinel", async () => {
    const { win, state } = fakeWin();
    await checkReloadProtection(win as never, safeMenu, "darwin");
    expect(state.loadStarts).toBe(0);
    expect(state.sentEvents.map((e) => `${e.type}:${e.keyCode}:${e.modifiers.join(",")}`)).toEqual([
      "keyDown:R:command",
      "keyUp:R:command",
      "keyDown:R:command,shift",
      "keyUp:R:command,shift",
    ]);
    expect(state.listener).toBeUndefined();
  });

  it("uses control as the primary modifier on win32/linux", async () => {
    const { win, state } = fakeWin();
    await checkReloadProtection(win as never, safeMenu, "win32");
    expect(state.sentEvents[0]).toMatchObject({ type: "keyDown", keyCode: "R", modifiers: ["control"] });
    expect(state.sentEvents[2]).toMatchObject({ modifiers: ["control", "shift"] });
  });

  it("fails when a synthetic reload clears the sentinel, and detaches the listener", async () => {
    const { win, state } = fakeWin({ clearOnKey: true });
    await expect(checkReloadProtection(win as never, safeMenu, "darwin")).rejects.toThrow("reloaded the window");
    expect(state.listener).toBeUndefined();
  });

  it("fails on a load-start during a key press and still detaches the listener", async () => {
    const { win, state } = fakeWin({ loadOnKey: true });
    await expect(checkReloadProtection(win as never, safeMenu, "darwin")).rejects.toThrow("started 1 load");
    expect(state.listener).toBeUndefined();
  });
});

describe("isReloadAcceleratorText", () => {
  it("detects the common reload accelerator spellings", () => {
    for (const accel of ["CmdOrCtrl+R", "CommandOrControl+R", "Cmd+R", "Ctrl+R", "Cmd+Shift+R", "Ctrl+Shift+R", "CommandOrControl+Shift+R"]) {
      expect(isReloadAcceleratorText(accel)).toBe(true);
    }
  });
  it("rejects unrelated accelerators", () => {
    for (const accel of ["CmdOrCtrl+Shift+I", "Alt+Cmd+I", "Ctrl+W", undefined]) {
      expect(isReloadAcceleratorText(accel)).toBe(false);
    }
  });
});
