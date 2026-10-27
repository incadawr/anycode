import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  buildApplicationMenuTemplate,
  confirmReloadIfBusy,
  isReloadAccelerator,
} from "./application-menu.js";

type Item = MenuItemConstructorOptions & { submenu?: MenuItemConstructorOptions[] };

function flatten(template: MenuItemConstructorOptions[]): Item[] {
  const out: Item[] = [];
  const walk = (node: MenuItemConstructorOptions): void => {
    const item = node as Item;
    out.push(item);
    if (Array.isArray(item.submenu)) {
      for (const child of item.submenu) walk(child);
    }
  };
  for (const node of template) walk(node);
  return out;
}

function devOptions() {
  return {
    platform: "darwin" as const,
    development: true,
    onReload: vi.fn(),
    onForceReload: vi.fn(),
    onToggleDevTools: vi.fn(),
  };
}

describe("buildApplicationMenuTemplate (GitHub #19)", () => {
  it("production menu cannot reload via a role, accelerator or viewMenu", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const template = buildApplicationMenuTemplate({
        platform,
        development: false,
        onReload: () => undefined,
        onForceReload: () => undefined,
        onToggleDevTools: () => undefined,
      });
      const items = flatten(template);
      const roles = items.map((i) => i.role);
      expect(roles).not.toContain("reload");
      expect(roles).not.toContain("forceReload");
      expect(roles).not.toContain("toggleDevTools");
      expect(roles).not.toContain("viewMenu");
      for (const item of items) {
        expect(item.accelerator ?? "").not.toMatch(/\+R$/i);
        expect(item.accelerator ?? "").not.toMatch(/CmdOrCtrl\+R|CommandOrControl\+R/i);
      }
    }
  });

  it("development reload uses guarded click callbacks (no reload role), and the click invokes the callback", () => {
    const options = devOptions();
    const items = flatten(buildApplicationMenuTemplate(options));
    const reload = items.find((i) => i.label === "Reload window");
    const force = items.find((i) => i.label === "Force reload window");
    const devTools = items.find((i) => i.label === "Toggle Developer Tools");
    expect(reload).toBeDefined();
    expect(force).toBeDefined();
    expect(devTools).toBeDefined();
    expect(reload!.role).toBeUndefined();
    expect(force!.role).toBeUndefined();
    expect(devTools!.role).toBeUndefined();
    expect(typeof reload!.click).toBe("function");
    expect(typeof force!.click).toBe("function");
    expect(typeof devTools!.click).toBe("function");
    (reload!.click as () => void)();
    (force!.click as () => void)();
    (devTools!.click as () => void)();
    expect(options.onReload).toHaveBeenCalledTimes(1);
    expect(options.onForceReload).toHaveBeenCalledTimes(1);
    expect(options.onToggleDevTools).toHaveBeenCalledTimes(1);
  });

  it("Edit and Window controls remain available on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const items = flatten(
        buildApplicationMenuTemplate({
          platform,
          development: false,
          onReload: () => undefined,
          onForceReload: () => undefined,
          onToggleDevTools: () => undefined,
        }),
      );
      const roles = items.map((i) => i.role);
      for (const edit of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
        expect(roles).toContain(edit);
      }
      expect(roles).toContain("windowMenu");
    }
  });
});

describe("isReloadAccelerator", () => {
  it("matches primary-modifier R, shifted and unshifted, on darwin", () => {
    expect(isReloadAccelerator({ key: "r", meta: true, type: "keyDown" }, "darwin")).toBe(true);
    expect(isReloadAccelerator({ key: "R", meta: true, shift: true, type: "keyDown" }, "darwin")).toBe(true);
  });

  it("matches primary-modifier R, shifted and unshifted, on win32/linux", () => {
    expect(isReloadAccelerator({ key: "r", control: true, type: "keyDown" }, "win32")).toBe(true);
    expect(isReloadAccelerator({ key: "r", control: true, shift: true, type: "keyDown" }, "linux")).toBe(true);
  });

  it("rejects Alt combinations and keyUp", () => {
    expect(isReloadAccelerator({ key: "r", meta: true, alt: true, type: "keyDown" }, "darwin")).toBe(false);
    expect(isReloadAccelerator({ key: "r", control: true, alt: true, type: "keyDown" }, "win32")).toBe(false);
    expect(isReloadAccelerator({ key: "r", meta: true, type: "keyUp" }, "darwin")).toBe(false);
  });

  it("rejects non-R keys and missing primary modifier", () => {
    expect(isReloadAccelerator({ key: "t", meta: true, type: "keyDown" }, "darwin")).toBe(false);
    expect(isReloadAccelerator({ key: "r", type: "keyDown" }, "darwin")).toBe(false);
    expect(isReloadAccelerator({ key: "r", control: true, type: "keyDown" }, "darwin")).toBe(false);
  });
});

describe("confirmReloadIfBusy (GitHub #19)", () => {
  const tab = (sessionId: string, workspace = "/ws") => ({ sessionId, workspace });

  it("idle across every tab proceeds without a dialog", async () => {
    const confirm = vi.fn(async () => ({ response: 0 }));
    const status = vi.fn(async () => ({ state: "idle" }));
    const result = await confirmReloadIfBusy({
      listTabs: () => [tab("a"), tab("b")],
      status,
      confirm,
    });
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("a busy root asks the fixed dialog and honours Reload / Cancel", async () => {
    const status = vi.fn(async (_id: string) => ({ state: _id === "a" ? "running" : "idle" }));
    const confirm = vi.fn(async () => ({ response: 1 }));
    const deps = { listTabs: () => [tab("a"), tab("b")], status, confirm };
    expect(await confirmReloadIfBusy(deps)).toBe(true);
    expect(confirm).toHaveBeenCalledWith({
      title: "Reload window?",
      message: "A task is running. Reloading reconnects the conversation view.",
      buttons: ["Cancel", "Reload"],
      defaultId: 0,
      cancelId: 0,
    });
    confirm.mockResolvedValueOnce({ response: 0 });
    expect(await confirmReloadIfBusy(deps)).toBe(false);
  });

  it("a busy child (separate session id) also triggers the guard", async () => {
    const status = vi.fn(async (_id: string) => ({ state: _id === "child" ? "running" : "idle" }));
    const confirm = vi.fn(async () => ({ response: 1 }));
    const result = await confirmReloadIfBusy({
      listTabs: () => [tab("root"), tab("child")],
      status,
      confirm,
    });
    expect(result).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("a refused or timed-out status is conservatively busy", async () => {
    const confirm = vi.fn(async () => ({ response: 1 }));
    const result = await confirmReloadIfBusy({
      listTabs: () => [tab("a")],
      status: async () => {
        throw new Error("host gone");
      },
      confirm,
    });
    expect(result).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, {}, { state: "unknown" }, { state: 42 }])("an unrecognized status %j requires confirmation", async (status) => {
    const confirm = vi.fn(async () => ({ response: 1 }));
    const result = await confirmReloadIfBusy({
      listTabs: () => [tab("a")],
      status: async () => status,
      confirm,
    });
    expect(result).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("refuses a duplicate click while a confirmation is pending", async () => {
    const pending = { value: false, get() { return this.value; }, set(v: boolean) { this.value = v; } };
    pending.set(true);
    const status = vi.fn(async () => ({ state: "running" }));
    const confirm = vi.fn(async () => ({ response: 1 }));
    const result = await confirmReloadIfBusy({
      listTabs: () => [tab("a")],
      status,
      confirm,
      pending,
    });
    expect(result).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
