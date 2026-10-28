/** Opt-in release UI check. Fixed operations, fresh internal temp profile,
 * no HTTP control channel and no login/provider request. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KeyboardInputEvent } from "electron";

export function createSelfCheckProfile(argv: readonly string[]): string | undefined {
  if (!argv.includes("--self-check")) return undefined;
  const root = mkdtempSync(join(tmpdir(), "anycode-self-check-"));
  mkdirSync(join(root, "user-data"), { mode: 0o700 });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ version: 2, provider: { connections: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }), { mode: 0o600 });
  return root;
}

/** Never inherits a real workspace, key, account home, automation listener,
 * or settings override. Does not change HOME or the owner's files. */
export function selfCheckEnvironment(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^ANYCODE_/.test(key) || /^(CODEX_HOME|CLAUDE_CONFIG_DIR|ELECTRON_RENDERER_URL|ELECTRON_RUN_AS_NODE|REMOTE_DEBUGGING_PORT)$/i.test(key)) delete clean[key];
  }
  return { ...clean,
    ANYCODE_DB_PATH: join(root, "db.sqlite"),
    ANYCODE_CODEX_BIN: join(root, "absent-codex"), ANYCODE_CLAUDE_BIN: join(root, "absent-claude"),
    CODEX_HOME: join(root, ".codex"), CLAUDE_CONFIG_DIR: join(root, ".claude"),
  };
}

interface CheckWindow {
  webContents: { executeJavaScript(expression: string): Promise<unknown>; capturePage(): Promise<{ toPNG(): Buffer }> };
}
export async function runSelfCheck(win: CheckWindow, root: string, allowUnavailableCapture = false): Promise<void> {
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Self-check renderer operation timed out")), 10_000); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const evaluate = async (expression: string) => {
    try { return await bounded(win.webContents.executeJavaScript(expression)); }
    catch { throw new Error(`Self-check renderer operation failed: ${expression}`); }
  };
  const capture = async (name: string) => {
    let image: { toPNG(): Buffer };
    try {
      image = await bounded(win.webContents.capturePage());
    } catch (error) {
      // Xvfb can run the renderer without a usable compositor for capturePage.
      // Only the Linux CI opt-in may omit this evidence; all UI/IPC checks run.
      if (!allowUnavailableCapture || !(error instanceof Error) || error.message !== "UnknownVizError") throw error;
      console.warn(`[self-check] ${name} unavailable: ${error.message}`);
      return;
    }
    writeFileSync(join(root, name), image.toPNG());
  };
  const deadline = Date.now() + 30_000;
  while (!await evaluate("document.querySelectorAll('.welcome-path').length === 3")) {
    if (Date.now() >= deadline) throw new Error("First-run screen did not appear");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!await evaluate("document.querySelector('.connection-drawer-body') === null")) throw new Error("Fresh startup opened API form prematurely");
  await new Promise(resolve => setTimeout(resolve, 500));
  await capture("welcome.png");
  // UI-bound choices and error recovery without external auth or network.
  for (const index of [0, 1, 2]) {
    await evaluate(`document.querySelectorAll('.welcome-path')[${index}].click()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await evaluate("!!document.querySelector('.welcome-setup')")) throw new Error("Selected setup pane is missing");
  }
  if (!await evaluate("!!document.querySelector('.connection-drawer-body') && !document.querySelector('.connection-drawer-advanced').open")) throw new Error("API setup advanced controls should be collapsed");
  if (!await evaluate("document.querySelector('.welcome-setup .settings-button-primary').disabled")) throw new Error("Missing credential did not block Connect");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open settings').click()");
  await new Promise(resolve => setTimeout(resolve, 250));
  if (!await evaluate("!!document.querySelector('.settings-dialog')?.open")) throw new Error("First-run settings escape is unavailable");
  await capture("settings.png");
  // The preload must be packaged too; exercise real settings IPC and migration.
  const snapshot = await evaluate("window.anycode.settings.get()");
  if (!(snapshot && typeof snapshot === "object" && JSON.stringify(snapshot).includes('"connections":[]'))) throw new Error("Settings IPC did not return the isolated empty provider profile");
  await checkSettingsPanes(evaluate, (ms) => new Promise(resolve => setTimeout(resolve, ms)));
}

/** Panes the rail must at least offer; a shorter list means the rail itself broke. */
export const SELF_CHECK_MIN_SETTINGS_PANES = 10;

/**
 * Opens every Settings pane in turn. Each must render its tabpanel without
 * the pane error fallback, keep the Settings dialog open (a render crash
 * blanked the window in v0.0.38) and leave no second open modal that makes
 * the window inert (Roles in v0.0.39). Then "Back to app" must close Settings.
 */
export async function checkSettingsPanes(evaluate: (expression: string) => Promise<unknown>, sleep: (ms: number) => Promise<void>): Promise<void> {
  const ids = await evaluate("[...document.querySelectorAll('.settings-dialog [role=tab][id^=\"settings-tab-\"]')].map(b => b.id.slice(13))");
  if (!Array.isArray(ids) || ids.length < SELF_CHECK_MIN_SETTINGS_PANES) throw new Error("Settings rail lists too few panes");
  for (const id of ids as string[]) {
    await evaluate(`document.getElementById(${JSON.stringify(`settings-tab-${id}`)}).click()`);
    await sleep(300);
    const state = await evaluate(`({ open: !!document.querySelector('.settings-dialog')?.open, panel: !!document.getElementById(${JSON.stringify(`settings-pane-${id}`)}), failed: !!document.querySelector('[data-settings-pane-error]'), extraModal: [...document.querySelectorAll('dialog[open]')].some(d => !d.classList.contains('settings-dialog')) })`) as { open?: boolean; panel?: boolean; failed?: boolean; extraModal?: boolean } | null;
    if (!state?.open) throw new Error(`Settings pane "${id}" took the Settings window down`);
    if (!state.panel) throw new Error(`Settings pane "${id}" did not render`);
    if (state.failed) throw new Error(`Settings pane "${id}" failed to render`);
    if (state.extraModal) throw new Error(`Settings pane "${id}" left a modal open over the window`);
  }
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().endsWith('Back to app')).click()");
  await sleep(300);
  if (await evaluate("!!document.querySelector('.settings-dialog')?.open")) throw new Error("Back to app did not close Settings");
}


/** Self-check validates UI/IPC without accessing the OS credential store.
 * Actual safeStorage encryption remains an explicit owner acceptance check. */
export const selfCheckStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (_value: string): Buffer => { throw new Error("Self-check cannot encrypt credentials"); },
  decryptString: (_value: Buffer): string => { throw new Error("Self-check cannot decrypt credentials"); },
};

/** CLI discovery must not fall through an absent override to real installed
 * binaries: an ambient Claude may authenticate through its OS credential store. */
export const selfCheckBinaryFs = {
  stat: (_path: string): never => { throw Object.assign(new Error("Self-check has no external CLI"), { code: "ENOENT" }); },
  realpath: (_path: string): never => { throw Object.assign(new Error("Self-check has no external CLI"), { code: "ENOENT" }); },
  readdir: (_path: string): string[] => [],
};

// ─────────────────────────────────────────────────────────────────────────────
// GitHub #19 — packaged reload-shortcut protection check
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal structural menu shapes (compatible with a real Electron `Menu`). */
export interface ReloadMenuItem {
  role?: string;
  accelerator?: string | null;
  label?: string;
  submenu?: ReloadMenu | ReloadMenuItem[] | null;
}
export interface ReloadMenu {
  items: ReloadMenuItem[];
}

/** The isolated-window surface `checkReloadProtection` needs (satisfied by a real BrowserWindow). */
export interface ReloadCheckWindow {
  focus(): void;
  webContents: {
    on(event: "did-start-loading", listener: () => void): void;
    removeListener(event: "did-start-loading", listener: () => void): void;
    sendInputEvent(event: KeyboardInputEvent): void;
    executeJavaScript(expression: string): Promise<unknown>;
  };
}

type ReloadModifier = NonNullable<KeyboardInputEvent["modifiers"]>[number];

const FORBIDDEN_MENU_ROLES = new Set(["reload", "forcereload", "toggledevtools", "viewmenu"]);

/** Detects the two reload accelerators in their common string spellings. */
export function isReloadAcceleratorText(accelerator: string | null | undefined): boolean {
  if (!accelerator) return false;
  const normalized = accelerator.replace(/\s+/g, "").toLowerCase();
  return /(commandorcontrol|cmdorctrl|command|control|cmd|ctrl)(\+shift)?\+r$/.test(normalized);
}

function collectForbiddenMenuItems(item: ReloadMenuItem, into: string[]): void {
  if (item.role !== undefined && FORBIDDEN_MENU_ROLES.has(item.role.toLowerCase())) into.push(`role:${item.role}`);
  if (isReloadAcceleratorText(item.accelerator)) into.push(`accelerator:${item.accelerator}`);
  const submenu = item.submenu;
  if (Array.isArray(submenu)) {
    for (const child of submenu) collectForbiddenMenuItems(child, into);
  } else if (submenu != null && Array.isArray(submenu.items)) {
    for (const child of submenu.items) collectForbiddenMenuItems(child, into);
  }
}

function reloadKeyInput(platform: NodeJS.Platform, withShift: boolean): KeyboardInputEvent {
  const primary: ReloadModifier[] = platform === "darwin" ? ["command"] : ["control"];
  const modifiers: ReloadModifier[] = [...primary, ...(withShift ? (["shift"] as ReloadModifier[]) : [])];
  return {
    type: "keyDown",
    keyCode: "R",
    modifiers,
  } as KeyboardInputEvent;
}

const RELOAD_SETTLE_MS = 500;

/**
 * Packaged reload-shortcut acceptance (GitHub #19). Verifies the installed
 * application menu has no reload/forceReload/DevTools role, no reload
 * accelerator and no `viewMenu` (which would reinstate implicit reload
 * commands), then sends real Cmd+R / Cmd+Shift+R (Ctrl equivalents elsewhere)
 * key events at the isolated window and asserts zero `did-start-loading`
 * events and an unchanged DOM sentinel. The listener is always detached.
 */
export async function checkReloadProtection(
  win: ReloadCheckWindow,
  menu: ReloadMenu | null,
  platform: NodeJS.Platform,
): Promise<void> {
  if (menu === null || !Array.isArray(menu.items)) {
    throw new Error("Application menu is missing");
  }
  const forbidden: string[] = [];
  for (const item of menu.items) collectForbiddenMenuItems(item, forbidden);
  if (forbidden.length > 0) {
    throw new Error(`Reload shortcuts exposed in application menu: ${forbidden.join(", ")}`);
  }

  win.focus();
  const sentinel = `anycode-reload-sentinel-${Math.random().toString(36).slice(2)}`;
  const setExpression = `document.documentElement.dataset.anycodeReloadSentinel = ${JSON.stringify(sentinel)}; ${JSON.stringify(sentinel)}`;
  const initial = await win.webContents.executeJavaScript(setExpression);
  if (initial !== sentinel) {
    throw new Error("Reload sentinel did not stick before key events");
  }

  let loadStarts = 0;
  const onLoadStart = (): void => {
    loadStarts += 1;
  };
  win.webContents.on("did-start-loading", onLoadStart);
  try {
    for (const withShift of [false, true]) {
      win.webContents.sendInputEvent(reloadKeyInput(platform, withShift));
      win.webContents.sendInputEvent({ ...reloadKeyInput(platform, withShift), type: "keyUp" });
      await new Promise((resolve) => setTimeout(resolve, RELOAD_SETTLE_MS));
      const current = await win.webContents.executeJavaScript(
        "document.documentElement.dataset.anycodeReloadSentinel",
      );
      if (current !== sentinel) {
        throw new Error(`Reload shortcut (${withShift ? "Cmd/Ctrl+Shift+R" : "Cmd/Ctrl+R"}) reloaded the window`);
      }
      if (loadStarts !== 0) {
        throw new Error(`Reload shortcut started ${loadStarts} load(s)`);
      }
    }
  } finally {
    win.webContents.removeListener("did-start-loading", onLoadStart);
  }
}
