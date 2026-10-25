/**
 * Per-session "Full browser access" store (Taskana 4759 owner amendment): brief
 * tests 39-41. Copies the case shape of communication-sessions.test.ts.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAccessStore, defaultBrowserFullAccessFromSettingsFile, effectiveFullAccess } from "./browser-access.js";

let dir: string;
let file: string;
let defaultOn: boolean;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-browser-access-"));
  file = join(dir, "browser-access.json");
  defaultOn = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const store = () => createBrowserAccessStore({ file, defaultOn: () => defaultOn });

describe("browser access store (Taskana 4759) — test 39", () => {
  it("a root session takes defaultOn(); a resumed session keeps its stored value", () => {
    defaultOn = true;
    const s = store();
    s.register({ sessionId: "root" });
    expect(s.isOn("root")).toBe(true);
    s.set("root", false);
    defaultOn = true;
    s.register({ sessionId: "root" });
    expect(s.isOn("root")).toBe(false);
  });

  it("set returns false for an unknown id and leaves the store unchanged", () => {
    const s = store();
    expect(s.set("ghost", true)).toBe(false);
    expect(s.isOn("ghost")).toBe(false);
  });

  it("set persists to a 0600 file and a fresh store reads it back", async () => {
    const s = store();
    s.register({ sessionId: "a" });
    expect(s.set("a", true)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(store().isOn("a")).toBe(true);
  });

  it("a corrupt file reads as all OFF, and new root sessions stay OFF even with the default on", async () => {
    await writeFile(file, "{not json", "utf8");
    defaultOn = true;
    const s = store();
    expect(s.isOn("anything")).toBe(false);
    s.register({ sessionId: "fresh" });
    expect(s.isOn("fresh")).toBe(false);
  });

  it("a non-boolean entry is kept as OFF; it is not dropped and so cannot re-default", async () => {
    await writeFile(file, JSON.stringify({ a: "yes", b: true }), "utf8");
    defaultOn = true;
    const s = store();
    expect(s.isOn("a")).toBe(false);
    expect(s.isOn("b")).toBe(true);
    s.register({ sessionId: "a" });
    expect(s.isOn("a")).toBe(false);
  });

  it("a failed write reverts the change and returns false", async () => {
    const s = store();
    s.register({ sessionId: "a" });
    // The target path is replaced by a directory, so the atomic rename fails.
    await rm(file, { force: true });
    mkdirSync(file);
    expect(s.set("a", true)).toBe(false);
    expect(s.isOn("a")).toBe(false);
  });
});

describe("browser access store — child inheritance (Taskana 4759) — test 40", () => {
  it("a child of an ON parent is ON", () => {
    const s = store();
    s.register({ sessionId: "parent" });
    s.set("parent", true);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    expect(s.isOn("child")).toBe(true);
  });

  it("a child of an OFF parent is OFF even when the settings default is on", () => {
    defaultOn = true;
    const s = store();
    s.register({ sessionId: "parent" });
    s.set("parent", false);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    expect(s.isOn("child")).toBe(false);
  });

  it("a child of an unknown parent is OFF", () => {
    defaultOn = true;
    const s = store();
    s.register({ sessionId: "orphan", parentSessionId: "never-registered" });
    expect(s.isOn("orphan")).toBe(false);
  });

  it("toggling the parent later does not change an existing child", () => {
    const s = store();
    s.register({ sessionId: "parent" });
    s.set("parent", true);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    s.set("parent", false);
    expect(s.isOn("child")).toBe(true);
  });
});

describe("browser access default from settings (Taskana 4759) — test 41", () => {
  it("returns true only for browser.fullAccessDefault = on", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ browser: { fullAccessDefault: "on" } }), "utf8");
    expect(defaultBrowserFullAccessFromSettingsFile(path)).toBe(true);
    await writeFile(path, JSON.stringify({ browser: { fullAccessDefault: "off" } }), "utf8");
    expect(defaultBrowserFullAccessFromSettingsFile(path)).toBe(false);
  });

  it("a missing, corrupt or unknown-value file reads as off", async () => {
    expect(defaultBrowserFullAccessFromSettingsFile(join(dir, "missing.json"))).toBe(false);
    const path = join(dir, "settings.json");
    await writeFile(path, "{{", "utf8");
    expect(defaultBrowserFullAccessFromSettingsFile(path)).toBe(false);
    await writeFile(path, JSON.stringify({ browser: { fullAccessDefault: "maybe" } }), "utf8");
    expect(defaultBrowserFullAccessFromSettingsFile(path)).toBe(false);
  });

  it("a new root session registers ON when the settings file says the default is on", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ browser: { fullAccessDefault: "on" } }), "utf8");
    defaultOn = defaultBrowserFullAccessFromSettingsFile(path);
    const s = store();
    s.register({ sessionId: "new-root" });
    expect(s.isOn("new-root")).toBe(true);
  });
});

describe("effective full access (Taskana 4759): trust gates the stored value", () => {
  it("is ON only when stored ON and the folder's trust is decided", () => {
    expect(effectiveFullAccess(true, "no_pending")).toBe(true);
    expect(effectiveFullAccess(true, { workspace: "/ws", hash: "a".repeat(64) })).toBe(false);
    expect(effectiveFullAccess(true, "unknown_tab")).toBe(false);
    expect(effectiveFullAccess(false, "no_pending")).toBe(false);
  });
});
