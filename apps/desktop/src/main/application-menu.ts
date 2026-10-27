/**
 * GitHub #19 — explicit application menu + reload-shortcut protection.
 *
 * Electron installs its DEFAULT application menu when none is set, and that
 * menu carries View → Reload / Force Reload / Toggle Developer Tools with the
 * `CmdOrCtrl+R` / `CmdOrCtrl+Shift+R` accelerators. In a chat client those
 * reload the WHOLE renderer mid-turn and the UI comes back degraded (lost tab
 * titles, collapsed agent messages, no live progress). This module replaces
 * the implicit default with an explicit menu that has NO reload entry in a
 * production build and, in development, routes every reload through a
 * busy-turn confirmation guard instead of Electron's role-based shortcuts
 * (which bypass any guard).
 *
 * The menu builder and the accelerator predicate are pure — they take a
 * platform string and callbacks, never touch the real `electron` module at
 * runtime (the import below is type-only, erased by the compiler) so the unit
 * tests run under this package's plain-node vitest environment.
 */
import type { MenuItemConstructorOptions } from "electron";

/** Structural shape of an `before-input-event` `input` (Electron `Input`). */
export interface ReloadInput {
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  type?: string;
}

export interface ApplicationMenuTemplateOptions {
  platform: NodeJS.Platform;
  development: boolean;
  onReload: () => void;
  onForceReload: () => void;
  onToggleDevTools: () => void;
}

/**
 * The primary-modifier R shortcut, with or without Shift. Alt combinations and
 * key-up events are rejected (an Alt+R chord is a different user intent, and
 * `keyUp` is not a trigger). On macOS the primary modifier is Command (`meta`),
 * on every other platform it is Control.
 */
export function isReloadAccelerator(input: ReloadInput, platform: NodeJS.Platform): boolean {
  if (input.type === "keyUp") return false;
  if (input.alt) return false;
  if (input.key.toLowerCase() !== "r") return false;
  const primary = platform === "darwin" ? input.meta === true : input.control === true;
  return primary;
}

/**
 * An explicit menu template WITHOUT `role:"viewMenu"` (which would reinstate
 * Electron's implicit reload commands). macOS gets the native app menu;
 * File/Edit/View/Window stay available on every platform; only a development
 * build appends the reload/DevTools entries, and those use `click` callbacks —
 * never `role:"reload"`/`"forceReload"`, which would bypass the confirmation
 * guard this slice routes dev reloads through.
 */
export function buildApplicationMenuTemplate(options: ApplicationMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = options.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({ role: "appMenu" });
  }

  template.push({
    label: "File",
    submenu: [isMac ? { role: "close" } : { role: "quit" }],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  if (options.development) {
    viewSubmenu.push(
      { type: "separator" },
      { label: "Reload window", accelerator: "CmdOrCtrl+R", click: options.onReload },
      { label: "Force reload window", accelerator: "CmdOrCtrl+Shift+R", click: options.onForceReload },
      {
        label: "Toggle Developer Tools",
        accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
        click: options.onToggleDevTools,
      },
    );
  }

  template.push({ label: "View", submenu: viewSubmenu });
  template.push({ role: "windowMenu" });

  return template;
}

/** Only a known idle turn establishes that a reload needs no confirmation. */
function isRunningStatus(status: unknown): boolean {
  return (status as { state?: unknown } | null | undefined)?.state !== "idle";
}

export interface ReloadConfirmOptions {
  title: string;
  message: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export interface ReloadGuardDeps {
  listTabs(): readonly { sessionId: string; workspace: string }[];
  /** Queries `get_session_status` for one live tab. */
  status(sessionId: string, workspace: string): Promise<unknown>;
  /** Electron's `dialog.showMessageBox`-shaped confirm. */
  confirm(options: ReloadConfirmOptions): Promise<{ response: number }>;
  /** Optional pending-guard cell (tests inject it; the caller normally owns one). */
  pending?: { get(): boolean; set(value: boolean): void };
}

/**
 * Confirms a menu-initiated reload when any live root or child turn is busy
 * (or its busy state cannot be established — a refused/timed-out status is
 * conservatively busy). Returns true to proceed, false to cancel. Idle across
 * every tab proceeds without a dialog. A second invocation while a
 * confirmation is pending is refused outright so a double-click cannot
 * double-reload.
 */
export async function confirmReloadIfBusy(deps: ReloadGuardDeps): Promise<boolean> {
  const pending = deps.pending ?? { get: () => false, set: () => {} };
  if (pending.get()) return false;
  pending.set(true);
  try {
    const tabs = deps.listTabs();
    const states = await Promise.all(
      tabs.map(async (tab) => {
        try {
          return isRunningStatus(await deps.status(tab.sessionId, tab.workspace));
        } catch {
          return true; // a refused/timed-out status is conservatively busy
        }
      }),
    );
    if (!states.some(Boolean)) return true;
    const result = await deps.confirm({
      title: "Reload window?",
      message: "A task is running. Reloading reconnects the conversation view.",
      buttons: ["Cancel", "Reload"],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  } finally {
    pending.set(false);
  }
}
