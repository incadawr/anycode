import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAccessStore, defaultSessionAccessFromSettingsFile, normalizeHandle } from "./communication-sessions.js";

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

describe("session handles (Taskana 4750b)", () => {
  const handlesFile = () => join(dir, "communication-handles.json");
  const handleStore = (withFile = true) => createSessionAccessStore({ file, defaultOn: () => false, ...(withFile ? { handlesFile: handlesFile() } : {}) });
  const alwaysLive = () => true;

  it("accepts lowercase digits and - _ . @", () => {
    expect(normalizeHandle("build-bot_1.x@y")).toEqual({ ok: true, handle: "build-bot_1.x@y" });
    expect(normalizeHandle("a")).toEqual({ ok: true, handle: "a" });
  });
  it("rejects uppercase (no case folding)", () => {
    expect(normalizeHandle("Build-Bot")).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects 65 chars and accepts 64", () => {
    expect(normalizeHandle("a".repeat(64))).toEqual({ ok: true, handle: "a".repeat(64) });
    expect(normalizeHandle("a".repeat(65))).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects empty after trim as clear not invalid", () => {
    expect(normalizeHandle("   ")).toEqual({ ok: true, handle: null });
    expect(normalizeHandle("")).toEqual({ ok: true, handle: null });
    expect(normalizeHandle(null)).toEqual({ ok: true, handle: null });
  });
  it("rejects leading dot or dash", () => {
    expect(normalizeHandle(".hidden")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeHandle("-flag")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeHandle("_x")).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects spaces and slash", () => {
    expect(normalizeHandle("a b")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeHandle("a/b")).toEqual({ ok: false, reason: "invalid" });
  });
  it("trims surrounding whitespace before validating", () => {
    expect(normalizeHandle("  build-bot  ")).toEqual({ ok: true, handle: "build-bot" });
  });
  it("set then get round-trips and survives reload", () => {
    const s = handleStore();
    s.register({ sessionId: "a" });
    expect(s.setHandle("a", "build-bot", alwaysLive)).toEqual({ ok: true });
    expect(s.getHandle("a")).toBe("build-bot");
    expect(handleStore().getHandle("a")).toBe("build-bot");
    expect(handleStore().sessionIdByHandle("build-bot", alwaysLive)).toBe("a");
  });
  it("duplicate among live sessions refused", () => {
    const s = handleStore();
    s.register({ sessionId: "a" }); s.register({ sessionId: "b" });
    s.setHandle("a", "shared", alwaysLive);
    expect(s.setHandle("b", "shared", alwaysLive)).toEqual({ ok: false, reason: "duplicate" });
    expect(s.getHandle("b")).toBeUndefined();
  });
  it("same handle on same session is idempotent", () => {
    const s = handleStore();
    s.register({ sessionId: "a" });
    expect(s.setHandle("a", "same", alwaysLive)).toEqual({ ok: true });
    expect(s.setHandle("a", "same", alwaysLive)).toEqual({ ok: true });
    expect(s.getHandle("a")).toBe("same");
  });
  it("stale handle of a dead session does not block reuse", () => {
    const s = handleStore();
    s.register({ sessionId: "dead" }); s.register({ sessionId: "fresh" });
    s.setHandle("dead", "reused", alwaysLive);
    const live = (id: string) => id !== "dead";
    expect(s.setHandle("fresh", "reused", live)).toEqual({ ok: true });
    expect(s.sessionIdByHandle("reused", live)).toBe("fresh");
  });
  it("unknown session refused", () => {
    const s = handleStore();
    expect(s.setHandle("ghost", "x", alwaysLive)).toEqual({ ok: false, reason: "unknown_session" });
    expect(s.getHandle("ghost")).toBeUndefined();
  });
  it("clear removes handle", () => {
    const s = handleStore();
    s.register({ sessionId: "a" });
    s.setHandle("a", "gone", alwaysLive);
    expect(s.setHandle("a", null, alwaysLive)).toEqual({ ok: true });
    expect(s.getHandle("a")).toBeUndefined();
    expect(handleStore().getHandle("a")).toBeUndefined();
  });
  it("invalid handle passed to the store is refused", () => {
    const s = handleStore();
    s.register({ sessionId: "a" });
    expect(s.setHandle("a", "BAD", alwaysLive)).toEqual({ ok: false, reason: "invalid" });
  });
  it("corrupt handles file reads as empty", async () => {
    await writeFile(handlesFile(), "{not json");
    expect(handleStore().getHandle("a")).toBeUndefined();
    await writeFile(handlesFile(), JSON.stringify({ a: "good", b: "BAD", c: 7 }));
    const s = handleStore();
    expect(s.getHandle("a")).toBe("good");
    expect(s.getHandle("b")).toBeUndefined();
    expect(s.getHandle("c")).toBeUndefined();
  });
  it("existing boolean access file unchanged and still loads", async () => {
    const s = handleStore();
    s.register({ sessionId: "a" }); s.set("a", true); s.setHandle("a", "keep", alwaysLive);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: true });
    expect(handleStore().isExposed("a")).toBe(true);
    expect(await stat(handlesFile()).then((x) => x.mode & 0o777)).toBe(0o600);
  });
  it("child does not inherit parent handle", () => {
    const s = handleStore();
    s.register({ sessionId: "parent" });
    s.setHandle("parent", "parent-handle", alwaysLive);
    s.register({ sessionId: "child", parentSessionId: "parent" });
    expect(s.getHandle("child")).toBeUndefined();
    expect(s.setHandle("child", "parent-handle", alwaysLive)).toEqual({ ok: false, reason: "duplicate" });
  });
  it("failed write keeps previous handle (fail closed)", async () => {
    await writeFile(join(dir, "blocker"), "x");
    const s = createSessionAccessStore({ file, defaultOn: () => false, handlesFile: join(dir, "blocker", "handles.json") });
    s.register({ sessionId: "a" });
    expect(s.setHandle("a", "first", alwaysLive)).toEqual({ ok: false, reason: "io_error" });
    expect(s.getHandle("a")).toBeUndefined();
  });
  it("without a handles file handles stay in memory", () => {
    const s = handleStore(false);
    s.register({ sessionId: "a" });
    expect(s.setHandle("a", "mem", alwaysLive)).toEqual({ ok: true });
    expect(handleStore(false).getHandle("a")).toBeUndefined();
  });

  // The durable marker that a resume-time repair relies on: which title a host
  // actually committed for this session, so an automatically generated title
  // can be told apart from one written later.
  it("remembers the confirmed title across a restart, and drops it with the handle", () => {
    const markers = () => join(dir, "communication-agent-titles.json");
    const withMarkers = () => createSessionAccessStore({
      file, defaultOn: () => false, handlesFile: handlesFile(), titleConfirmationsFile: markers(),
    });
    const s = withMarkers();
    s.register({ sessionId: "a" });
    s.setHandle("a", "build-bot", alwaysLive);
    expect(s.getConfirmedTitle("a")).toBeUndefined();

    s.confirmTitle("a", "build-bot");
    expect(s.getConfirmedTitle("a")).toBe("build-bot");
    // Durable: a fresh store (a restart) reads the marker back.
    expect(withMarkers().getConfirmedTitle("a")).toBe("build-bot");

    // Clearing the handle makes the marker meaningless.
    expect(s.setHandle("a", null, alwaysLive)).toEqual({ ok: true });
    expect(s.getConfirmedTitle("a")).toBeUndefined();
  });

  it("writes the confirmed-title file with mode 0600 and ignores corrupt entries", async () => {
    const markers = join(dir, "communication-agent-titles.json");
    const store = () => createSessionAccessStore({ file, defaultOn: () => false, titleConfirmationsFile: markers });
    store().confirmTitle("a", "build-bot");
    expect((await stat(markers)).mode & 0o777).toBe(0o600);
    await writeFile(markers, JSON.stringify({ a: "kept", b: 7, c: "" }));
    const read = store();
    expect(read.getConfirmedTitle("a")).toBe("kept");
    expect(read.getConfirmedTitle("b")).toBeUndefined();
    expect(read.getConfirmedTitle("c")).toBeUndefined();
    await writeFile(markers, "{not json");
    expect(store().getConfirmedTitle("a")).toBeUndefined();
  });
});

describe("External approvals store (Taskana 4763)", () => {
  const approvalsFile = () => join(dir, "communication-approvals.json");
  const approvals = () => createSessionAccessStore({ file: approvalsFile(), defaultOn: () => false });
  it("T29 defaults off for a new root (even when sharing defaults on), inherits from the parent, persists across instances, and a corrupt file reads as all off", async () => {
    defaultOn = true;
    const a = approvals();
    a.register({ sessionId: "root" });
    expect(a.isExposed("root")).toBe(false);
    a.set("root", true);
    a.register({ sessionId: "child-of-on", parentSessionId: "root" });
    expect(a.isExposed("child-of-on")).toBe(true);
    a.register({ sessionId: "off-parent" });
    a.register({ sessionId: "child-of-off", parentSessionId: "off-parent" });
    expect(a.isExposed("child-of-off")).toBe(false);
    const reopened = approvals();
    expect(reopened.isExposed("root")).toBe(true);
    expect(reopened.isExposed("child-of-on")).toBe(true);
    await writeFile(approvalsFile(), "{not json");
    const corrupt = approvals();
    expect(corrupt.isExposed("root")).toBe(false);
    expect(corrupt.isExposed("child-of-on")).toBe(false);
  });
  it("a resumed session keeps its own approval value", () => {
    const a = approvals();
    a.register({ sessionId: "s" }); a.set("s", true);
    a.register({ sessionId: "s", parentSessionId: "parent-off" });
    expect(a.isExposed("s")).toBe(true);
  });
});

