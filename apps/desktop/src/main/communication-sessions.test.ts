import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAccessStore, defaultSessionAccessFromSettingsFile } from "./communication-sessions.js";

let dir: string;
let file: string;
let defaultOn: boolean;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "anycode-sessions-")); file = join(dir, "communication-sessions.json"); defaultOn = false; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const store = () => createSessionAccessStore({ file, defaultOn: () => defaultOn });

describe("per-session Sessions API switch (Taskana 4747 owner amendment)", () => {
  it("an unknown session is not exposed (fail closed)", () => {
    expect(store().isExposed("never-seen")).toBe(false);
  });

  it("a new tab takes the default: off unless defaultSessionAccess is on", () => {
    const s = store();
    s.register({ sessionId: "s-off" });
    defaultOn = true;
    s.register({ sessionId: "s-on" });
    expect(s.isExposed("s-off")).toBe(false);
    expect(s.isExposed("s-on")).toBe(true);
  });

  it("set toggles an existing session, and refuses an unknown one", () => {
    const s = store();
    s.register({ sessionId: "a" });
    expect(s.set("a", true)).toBe(true);
    expect(s.isExposed("a")).toBe(true);
    expect(s.set("ghost", true)).toBe(false);
    expect(s.isExposed("ghost")).toBe(false);
  });

  it("switch off hides the session immediately", () => {
    const s = store();
    s.register({ sessionId: "a" });
    s.set("a", true);
    s.set("a", false);
    expect(s.isExposed("a")).toBe(false);
  });

  it("a child inherits its parent's switch (on)", () => {
    const s = store();
    s.register({ sessionId: "parent" }); s.set("parent", true);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    expect(s.isExposed("child")).toBe(true);
  });

  it("a child inherits its parent's switch (off) even when the default is on", () => {
    defaultOn = true;
    const s = store();
    s.register({ sessionId: "parent" }); s.set("parent", false);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    expect(s.isExposed("child")).toBe(false);
  });

  it("re-registering an existing session (resume) keeps its switch, does not reset to default", () => {
    const s = store();
    s.register({ sessionId: "a" }); s.set("a", true);
    defaultOn = false;
    s.register({ sessionId: "a" });
    expect(s.isExposed("a")).toBe(true);
  });

  it("persists the switch across a restart (a fresh store reads the same file)", () => {
    const first = store();
    first.register({ sessionId: "keep" }); first.set("keep", true);
    expect(store().isExposed("keep")).toBe(true);
  });

  it("writes the file with mode 0600", async () => {
    const s = store();
    s.register({ sessionId: "a" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("a corrupt file reads as empty, fail closed", async () => {
    await writeFile(file, "{not json");
    expect(store().isExposed("a")).toBe(false);
  });

  it("drops non-boolean entries from a hand-edited file", async () => {
    await writeFile(file, JSON.stringify({ a: "yes", b: true }));
    const s = store();
    expect(s.isExposed("a")).toBe(false);
    expect(s.isExposed("b")).toBe(true);
  });

  it("exposes only the ids and booleans, and the count of exposed sessions", () => {
    const s = store();
    s.register({ sessionId: "a" }); s.register({ sessionId: "b" });
    s.set("b", true);
    expect(s.exposedCount()).toBe(1);
  });

  it("the stored file contains no token-like material", async () => {
    const s = store();
    s.register({ sessionId: "a" }); s.set("a", true);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ a: true }));
  });

  it("reads defaultSessionAccess from settings.json, failing closed to off", async () => {
    const settingsFile = join(dir, "settings.json");
    await writeFile(settingsFile, JSON.stringify({ communication: { enabled: false, workspaces: [], defaultSessionAccess: "on" } }));
    expect(defaultSessionAccessFromSettingsFile(settingsFile)).toBe(true);
    await writeFile(settingsFile, JSON.stringify({}));
    expect(defaultSessionAccessFromSettingsFile(settingsFile)).toBe(false);
    expect(defaultSessionAccessFromSettingsFile(join(dir, "missing.json"))).toBe(false);
  });

  it("a failed write never throws out of register (tab creation must not fail on the switch file)", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const s = createSessionAccessStore({ file: join(blocker, "sessions.json"), defaultOn: () => true });
    expect(() => s.register({ sessionId: "a" })).not.toThrow();
    expect(s.isExposed("a")).toBe(true); // in-memory state still answers
  });

  it("a failed write on set reverts the switch and reports false", async () => {
    const s = store();
    s.register({ sessionId: "a" });
    await rm(file, { force: true });
    await writeFile(join(dir, "blocker"), "x");
    const broken = createSessionAccessStore({ file: join(dir, "blocker", "sessions.json"), defaultOn: () => false });
    broken.register({ sessionId: "b" });
    expect(broken.set("b", true)).toBe(false);
    expect(broken.isExposed("b")).toBe(false);
  });
});
