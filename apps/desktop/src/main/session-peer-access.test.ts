import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSessionPeerPolicyStore, normalizePeerWorkspaceKey } from "./session-peer-policy.js";
import { createSessionPeerAccess, type PeerSessionFacts } from "./session-peer-access.js";
import { parseSessionPeerRequest } from "../shared/session-peers.js";

let dir: string, a: string, b: string, file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "peer-access-"));
  a = join(dir, "a"); b = join(dir, "b"); file = join(dir, "policy.json");
  mkdirSync(a); mkdirSync(b);
  a = realpathSync(a); b = realpathSync(b);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const facts = (workspace = a): PeerSessionFacts => ({
  workspace, workspaceKey: realpathSync(workspace), live: true, root: true,
  restricted: false, readOnly: false,
});
function setup() {
  const policy = createSessionPeerPolicyStore({ file });
  const trusted = new Set([a, b]);
  let enabled = true;
  const access = createSessionPeerAccess({ policy, enabled: () => enabled,
    isTrusted: key => trusted.has(key), realpathSync, statSync });
  return { policy, trusted, access, disable: () => { enabled = false; } };
}
it("allows trusted exact roots without an external share; denies wider implicit scope", () => {
  const { access, trusted } = setup();
  expect(access.canAccess(facts(), facts(), "send")).toBe(true);
  mkdirSync(join(a, "nested"));
  trusted.add(realpathSync(join(a, "nested")));
  for (const target of [b, join(a, "nested")]) {
    expect(access.canAccess(facts(), facts(target), "list")).toBe(false);
  }
  // A sibling worktree has the same boundary as an unrelated directory.
  mkdirSync(join(b, ".git"));
  expect(access.canAccess(facts(), facts(b), "send")).toBe(false);
});
it("requires symmetric grants and both trust decisions; revoke applies immediately", () => {
  const { policy, access, trusted } = setup();
  expect(policy.setPairGrant(a, b, true)).toBe(true);
  for (const [from, to] of [[a, b], [b, a]]) {
    expect(access.canAccess(facts(from), facts(to), "send")).toBe(true);
    expect(access.canAccess(facts(from), facts(to), "who_edits")).toBe(false);
    expect(access.canAccess(facts(from), facts(to), "open")).toBe(false);
  }
  expect(access.canAccessWorkspace(facts(), b, b, "open", true)).toBe(true);
  expect(access.canAccess(facts(), facts(b), "open", true)).toBe(true);
  expect(access.canAccess(facts(), facts(b), "open", false)).toBe(false);
  trusted.delete(b);
  expect(access.canAccess(facts(), facts(b), "send")).toBe(false);
  trusted.add(b);
  expect(policy.setNativeEnabled(b, false)).toBe(true);
  expect(access.canAccess(facts(), facts(b), "send")).toBe(false);
  policy.setNativeEnabled(b, true);
  expect(policy.setPairGrant(b, a, false)).toBe(true);
  expect(access.canAccess(facts(), facts(b), "list")).toBe(false);
  expect(access.canAccess(facts(b), facts(), "send")).toBe(false);
});
it("checks global off, live/root facts and mutation restrictions on every call", () => {
  const { access, disable } = setup();
  for (const patch of [{ live: false }, { root: false }, { restricted: true }, { readOnly: true }]) {
    expect(access.canAccess({ ...facts(), ...patch }, facts(), "send")).toBe(false);
  }
  expect(access.canAccess(facts(), { ...facts(), live: false }, "send")).toBe(false);
  expect(access.canAccess({ ...facts(), readOnly: true }, facts(), "list")).toBe(true);
  disable();
  expect(access.canAccess(facts(), facts(), "list")).toBe(false);
});
it("fails closed for missing/EACCES paths, files, relative paths and symlink retarget", () => {
  const { access, policy } = setup();
  const caller = facts();
  expect(access.canAccess(caller, { ...caller, workspace: join(a, "missing") }, "send")).toBe(false);
  writeFileSync(join(a, "file"), "x");
  expect(access.canAccess(caller, { ...caller, workspace: join(a, "file") }, "send")).toBe(false);
  expect(access.canAccess(caller, { ...caller, workspace: "a" }, "send")).toBe(false);
  const denied = createSessionPeerAccess({ policy: setup().policy, enabled: () => true,
    isTrusted: () => true, realpathSync: () => { throw Object.assign(new Error(), { code: "EACCES" }); }, statSync });
  expect(denied.canAccess(caller, caller, "send")).toBe(false);
  const link = join(dir, "link"); symlinkSync(a, link);
  const pinned = facts(link);
  expect(access.canAccess(caller, pinned, "send")).toBe(true);
  policy.setPairGrant(a, b, true);
  unlinkSync(link); symlinkSync(b, link);
  expect(access.canAccess(caller, pinned, "send")).toBe(false);
  expect(access.canAccess(pinned, caller, "send")).toBe(false);
});
it("persists a separate strict codec and rolls back failed writes", () => {
  const { policy } = setup();
  policy.setPairGrant(a, b, true); policy.setNativeEnabled(a, false);
  const loaded = createSessionPeerPolicyStore({ file });
  expect(loaded.hasPairGrant(b, a)).toBe(true);
  expect(loaded.isNativeEnabled(a)).toBe(false);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const snapshot = readFileSync(file, "utf8");
  unlinkSync(file); mkdirSync(file);
  expect(policy.setPairGrant(a, b, false)).toBe(false);
  expect(policy.hasPairGrant(a, b)).toBe(true);
  expect(policy.setNativeEnabled(b, false)).toBe(false);
  expect(policy.isNativeEnabled(b)).toBe(true);
  rmSync(file, { recursive: true });
  for (const bad of ["{", JSON.stringify({ [a]: true }), snapshot.replace('"version":1', '"version":2')]) {
    writeFileSync(file, bad);
    const corrupt = createSessionPeerPolicyStore({ file });
    expect(corrupt.isNativeEnabled(b)).toBe(false);
    expect(corrupt.hasPairGrant(a, b)).toBe(false);
  }
});
it("model arguments cannot create consent", () => {
  const { access, policy } = setup();
  expect(parseSessionPeerRequest({ requestId: "r", operation: "open", input: { workspace: b, grant: true } })).toBeNull();
  expect(parseSessionPeerRequest({ requestId: "r", operation: "open", input: { workspace: b } })).not.toBeNull();
  expect(access.canAccessWorkspace(facts(), b, b, "open", true)).toBe(false);
  expect(policy.hasPairGrant(a, b)).toBe(false);
});
it("normalizes Windows drive/UNC case while rejecting ambiguous or device paths", () => {
  expect(normalizePeerWorkspaceKey("C:\\Work\\Repo\\", "win32")).toBe("c:\\work\\repo");
  expect(normalizePeerWorkspaceKey("//Server/Share/Repo", "win32")).toBe("\\\\server\\share\\repo");
  expect(normalizePeerWorkspaceKey("//Server.example/Share/Repo", "win32")).toBe("\\\\server.example\\share\\repo");
  for (const path of ["C:repo", "\\repo", "\\\\?\\C:\\repo", "C:\\repo:stream", "relative"]) {
    expect(normalizePeerWorkspaceKey(path, "win32")).toBeNull();
  }
  const policy = createSessionPeerPolicyStore({ file, platform: "win32" });
  const key = "c:\\work\\repo";
  const caller: PeerSessionFacts = { ...facts(), workspace: "C:\\Work\\Repo", workspaceKey: key };
  const access = createSessionPeerAccess({ policy, platform: "win32", enabled: () => true,
    isTrusted: p => p === key, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) });
  expect(access.canAccess(caller, { ...caller, workspace: "c:/WORK/repo/" }, "send")).toBe(true);
  expect(access.canAccess(caller, { ...caller, workspace: "C:\\Work\\Repo\\nested" }, "send")).toBe(false);
});
it("requires trust and native access even in one workspace; open stays independent", () => {
  const { access, trusted, policy } = setup();
  expect(access.canAccessWorkspace(facts(), a, a, "open")).toBe(true);
  trusted.clear();
  expect(access.canAccess(facts(), facts(), "list")).toBe(false);
  trusted.add(a);
  for (const patch of [{ root: false }, { restricted: true }]) {
    expect(access.canAccess(facts(), { ...facts(), ...patch }, "send")).toBe(false);
  }
  policy.setNativeEnabled(a, false);
  expect(access.canAccess(facts(), facts(), "send")).toBe(false);
});
it("never grants on a failed first persistence; unreadable and invalid policy disables defaults", () => {
  mkdirSync(file);
  const unreadable = createSessionPeerPolicyStore({ file });
  expect(unreadable.isNativeEnabled(a)).toBe(false);
  expect(unreadable.setPairGrant(a, b, true)).toBe(false);
  rmSync(file, { recursive: true });
  const policy = createSessionPeerPolicyStore({ file });
  mkdirSync(file);
  expect(policy.setPairGrant(a, b, true)).toBe(false);
  expect(policy.hasPairGrant(a, b)).toBe(false);
  rmSync(file, { recursive: true });
  for (const bad of [{ version: 1, off: [], grants: [[a, "relative"]] },
    { version: 1, off: [], grants: [], enabled: true }]) {
    writeFileSync(file, JSON.stringify(bad));
    expect(createSessionPeerPolicyStore({ file }).isNativeEnabled(a)).toBe(false);
  }
});
it("does not merge Windows drives or UNC shares without an exact pair grant", () => {
  const policy = createSessionPeerPolicyStore({ file, platform: "win32" });
  const from = "\\\\server\\share\\repo", to = "\\\\server\\other\\repo";
  const access = createSessionPeerAccess({ policy, platform: "win32", enabled: () => true,
    isTrusted: () => true, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) });
  const caller = { ...facts(), workspace: from, workspaceKey: from };
  const target = { ...caller, workspace: to, workspaceKey: to };
  expect(access.canAccess(caller, target, "send")).toBe(false);
  policy.setPairGrant(from, to, true);
  expect(access.canAccess(caller, target, "send")).toBe(true);
  expect(access.canAccess(caller, { ...target, workspace: "d:\\repo", workspaceKey: "d:\\repo" }, "send")).toBe(false);
  expect(normalizePeerWorkspaceKey("/repo\\", "darwin")).toBe("/repo\\");
});

it.each(["/nested", "-sibling"])("rejects a changed workspace sharing the pinned prefix: %s", suffix => {
  const { access, trusted, policy } = setup();
  const target = a + suffix;
  mkdirSync(target);
  const key = realpathSync(target);
  trusted.add(key);
  expect(policy.setPairGrant(a, key, true)).toBe(true);
  // Consent is present: only the generation's pinned path must deny access.
  expect(access.canAccess(facts(), facts(target), "send")).toBe(true);
  const moved = { ...facts(target), workspaceKey: a };
  for (const operation of ["list", "send"] as const) {
    expect(access.canAccess(facts(), moved, operation)).toBe(false);
    expect(access.canAccess(moved, facts(), operation)).toBe(false);
  }
});
it.each([
  "{",
  JSON.stringify({ version: 2, off: [], grants: [] }),
  JSON.stringify({ version: 1, off: [], grants: [], unknown: true }),
])("preserves invalid policy bytes when mutators are called: %s", contents => {
  writeFileSync(file, contents);
  const before = readFileSync(file);
  const policy = createSessionPeerPolicyStore({ file });
  expect(policy.setNativeEnabled(a, true)).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  expect(policy.setPairGrant(a, b, true)).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  // Repairing storage does not recover this instance; the UI must request restart.
  writeFileSync(file, JSON.stringify({ version: 1, off: [], grants: [] }));
  expect(policy.setNativeEnabled(a, true)).toBe(false);
  expect(policy.isNativeEnabled(a)).toBe(false);
  expect(createSessionPeerPolicyStore({ file }).isNativeEnabled(a)).toBe(true);
});
it("requires stable realpath case matching pinned and trusted keys on darwin", () => {
  const key = "/Work/Repo", alias = "/work/repo";
  const policy = createSessionPeerPolicyStore({ file, platform: "darwin" });
  const deps = { policy, platform: "darwin" as const, enabled: () => true,
    isTrusted: (p: string) => p === key, statSync: () => ({ isDirectory: () => true }) };
  const caller = { ...facts(), workspace: key, workspaceKey: key };
  const target = { ...caller, workspace: alias };
  const preserving = createSessionPeerAccess({ ...deps, realpathSync: p => p });
  expect(preserving.canAccess(caller, target, "send")).toBe(false);
  // The adapter may resolve verified aliases to the spelling shared by trust and pins.
  const stable = createSessionPeerAccess({ ...deps, realpathSync: p => p === alias ? key : p });
  expect(stable.canAccess(caller, target, "send")).toBe(true);
});
