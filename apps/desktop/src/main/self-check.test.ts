import { describe, expect, it, vi } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SELF_CHECK_MIN_SETTINGS_PANES, checkSettingsPanes, runSelfCheck, createSelfCheckProfile, selfCheckEnvironment, selfCheckBinaryFs } from "./self-check.js";
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
