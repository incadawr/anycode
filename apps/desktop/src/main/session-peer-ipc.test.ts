import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => handlers.set(key, fn) } }));
import { createSessionPeerPolicyStore } from "./session-peer-policy.js";
import { createSessionPeerAccess } from "./session-peer-access.js";
import { createSessionPeerIpc, registerSessionPeerIpc } from "./session-peer-ipc.js";
import { addIpcGuardTrustedWindow, setIpcGuardMainWindow, resetIpcGuardForTests } from "./ipc-guard.js";
import { SESSION_PEER_VIEW_CHANNEL, SESSION_PEER_SET_CHANNEL } from "../shared/session-peer-view.js";
const roots: string[] = [];
afterEach(() => { roots.forEach(p => rmSync(p, { recursive: true, force: true })); roots.length = 0; resetIpcGuardForTests(); handlers.clear(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-access-")); roots.push(root);
  const policy = createSessionPeerPolicyStore({ file: join(root, "policy.json") });
  const deps = { policy, enabled: () => true, tabs: () => [{ tabId: "a", workspace: "/alpha" }, { tabId: "b", workspace: "/beta" }], realpath: (p: string) => p, isDirectory: () => true, isTrusted: async () => true };
  return { root, policy, deps, ipc: createSessionPeerIpc(deps) };
}
it("default, project Off and exact symmetric grant change the access policy", async () => {
  const { policy, ipc } = fixture();
  const access = createSessionPeerAccess({ policy, enabled: () => true, isTrusted: () => true, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) });
  const caller = { workspace: "/alpha", workspaceKey: "/alpha", live: true, root: true, restricted: false, readOnly: false };
  const allowed = () => access.canAccessWorkspace(caller, "/beta", "/beta", "send");
  expect(policy.isNativeEnabled("/alpha")).toBe(true); expect(allowed()).toBe(false);
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: true })).ok).toBe(true);
  expect(allowed()).toBe(true); expect(policy.hasPairGrant("/beta", "/alpha")).toBe(true);
  await ipc.set({ tabId: "a", projectKey: "/alpha", enabled: false }); expect(allowed()).toBe(false);
  await ipc.set({ tabId: "a", projectKey: "/alpha", enabled: true });
  await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: false }); expect(allowed()).toBe(false);
});
it("persisted peers remain visible and revocable after their tab closes", async () => {
  const { ipc, deps, policy } = fixture();
  await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: true });
  deps.tabs = () => [{ tabId: "a", workspace: "/alpha" }];
  expect(await ipc.get({ tabId: "a" })).toMatchObject({ ok: true, view: { peers: [{ key: "/beta", granted: true }] } });
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: false })).ok).toBe(true);
  expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
});
it("refuses unknown keys, forged fields, untrusted and disabled feature writes", async () => {
  const { ipc, deps, policy } = fixture();
  for (const raw of [{ tabId: "a", projectKey: "/moved", enabled: true }, { tabId: "a", projectKey: "/alpha", enabled: true, peerKey: "/unknown" }, { tabId: "a", projectKey: "/alpha", enabled: true, sender: "owner" }, { tabId: "missing", enabled: true }]) expect((await ipc.set(raw)).ok).toBe(false);
  deps.isTrusted = async () => false;
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: true })).ok).toBe(false);
  deps.enabled = () => false;
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", enabled: false })).ok).toBe(false);
  expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
});
it("failed persistence retains the previous grant", async () => {
  const { root, ipc, policy } = fixture();
  await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: true });
  rmSync(join(root, "policy.json")); mkdirSync(join(root, "policy.json"));
  expect(await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: false })).toEqual({ ok: false, reason: "io_error" });
  expect(policy.hasPairGrant("/alpha", "/beta")).toBe(true);
});
it("registered IPC refuses forged senders and subframes before writes", async () => {
  const { deps, policy } = fixture(); const main = { mainFrame: {} }; setIpcGuardMainWindow(() => main);
  registerSessionPeerIpc(deps); const invoke = handlers.get(SESSION_PEER_SET_CHANNEL)!;
  const other = { mainFrame: {} };
  addIpcGuardTrustedWindow(other, [SESSION_PEER_VIEW_CHANNEL, SESSION_PEER_SET_CHANNEL]);
  for (const channel of [SESSION_PEER_VIEW_CHANNEL, SESSION_PEER_SET_CHANNEL]) {
    expect(() => handlers.get(channel)!({ sender: other, senderFrame: other.mainFrame }, { tabId: "a", projectKey: "/alpha", enabled: false })).toThrow("refused");
  }
  const raw = { tabId: "a", projectKey: "/alpha", enabled: false };
  expect(() => invoke({ sender: { mainFrame: {} }, senderFrame: main.mainFrame }, raw)).toThrow("refused");
  expect(() => invoke({ sender: main, senderFrame: {} }, raw)).toThrow("refused");
  expect(policy.isNativeEnabled("/alpha")).toBe(true);
  expect((await invoke({ sender: main, senderFrame: main.mainFrame }, raw)).ok).toBe(true);
  expect(policy.isNativeEnabled("/alpha")).toBe(false);
});
it("a changing folder or trust error cannot persist a grant", async () => {
  const { deps, policy, ipc } = fixture();
  deps.isTrusted = async () => { deps.realpath = p => p === "/beta" ? "/moved" : p; return true; };
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", peerKey: "/beta", enabled: true })).ok).toBe(false);
  expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
  deps.isTrusted = async () => { throw new Error("unreadable"); };
  expect((await ipc.set({ tabId: "a", projectKey: "/alpha", enabled: true })).ok).toBe(false);
});
it("the external approvals handler never creates a native grant", async () => {
  const { handleSetSessionApprovals } = await import("./communication-ipc.js");
  const { createSessionAccessStore } = await import("./communication-sessions.js");
  const { createAgentProjectsStore } = await import("./communication-agent-projects.js");
  const { root, policy } = fixture();
  expect(policy.setNativeEnabled("/alpha", false)).toBe(true);
  const before = readFileSync(join(root, "policy.json"), "utf8");
  const sessions = createSessionAccessStore({ file: join(root, "sessions.json"), defaultOn: () => true });
  const approvals = createSessionAccessStore({ file: join(root, "approvals.json"), defaultOn: () => false });
  sessions.register({ sessionId: "session" }); approvals.register({ sessionId: "session" });
  const status = () => ({ state: "off" as const, workspaces: 0, sessions: 1 });
  const result = await handleSetSessionApprovals({
    settingsPath: join(root, "settings.json"), logger: { warn() {}, error() {} }, sessions, approvals,
    tabs: () => [{ tabId: "a", sessionId: "session" }], env: () => undefined,
    controller: { status, discoveryFile: () => undefined, apply: async () => status(), regenerateToken: async () => ({ ok: false, reason: "not_running" }) },
    agentProjects: createAgentProjectsStore({ file: join(root, "projects.json"), realpathSync: p => p }),
    pickFolder: async () => undefined, stdioScriptPath: () => null, realpath: async p => p, realpathSync: p => p,
    homedir: () => root, offerEmptyFolderTrust: async folder => ({ folder }), stat: async () => ({ isDirectory: () => true }),
  }, { tabId: "a", enabled: true });
  expect(result.ok).toBe(true); expect(approvals.isExposed("session")).toBe(true);
  expect(readFileSync(join(root, "policy.json"), "utf8")).toBe(before);
  expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
});
