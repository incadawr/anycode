import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { loadSettings, saveSettings } from "../settings/files.js";
import { createCommunicationController } from "./communication-controller.js";
import { createSessionAccessStore } from "./communication-sessions.js";
import { createAgentProjectsStore } from "./communication-agent-projects.js";
import { realpathSync, symlinkSync } from "node:fs";
import {
  buildCopyConfig,
  handleAddWorkspace,
  handleAgentProjectsGet,
  handleAgentProjectsList,
  handleAgentProjectsOff,
  handleAgentProjectsSet,
  handleCommunicationGet,
  handleCopyConfig,
  handleRegenerateToken,
  handleRemoveWorkspace,
  handleSetDefaultAccess,
  handleSetEnabled,
  handleSetPort,
  handleSetSessionAccess,
  handleSetSessionApprovals,
  handleSetSessionHandle,
  tomlString,
  type CommunicationIpcDeps,
} from "./communication-ipc.js";

const TOKEN = "a1b2c3d4".repeat(8); // 64 hex chars, must never appear in any payload
let dir: string;
let settingsPath: string;
let workspaceA: string;
let workspaceB: string;
let fileTarget: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-comm-ipc-"));
  settingsPath = join(dir, "settings.json");
  workspaceA = join(dir, "ws-a");
  workspaceB = join(dir, "ws-b");
  fileTarget = join(dir, "plain.txt");
  await saveSettings(settingsPath, cloneDefaults());
  await (await import("node:fs/promises")).mkdir(workspaceA);
  await (await import("node:fs/promises")).mkdir(workspaceB);
  await writeFile(fileTarget, "x");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A controller over a fake server whose discovery file DOES hold the token; results must never show it. */
function rig(over: { env?: string; picked?: string | undefined; script?: string | null } = {}) {
  const startServer = vi.fn(async (options: Record<string, unknown>) => {
    const discoveryFile = join(dir, "communication.json");
    await writeFile(discoveryFile, JSON.stringify({ url: "http://127.0.0.1:43123/mcp", token: TOKEN, workspaces: [] }), { mode: 0o600 });
    void options;
    return { url: "http://127.0.0.1:43123/mcp", discoveryFile, close: async () => {} };
  });
  const controller = createCommunicationController({
    manager: () => ({ listTabs: () => [], communicationRequest: vi.fn() }) as never,
    userData: dir,
    logger: { error: () => {} },
    startServer: startServer as never,
    env: () => over.env,
    isSessionExposed: (id) => sessions.isExposed(id),
    countExposed: () => sessions.exposedCount(),
  });
  const sessions = createSessionAccessStore({ file: join(dir, "sessions.json"), defaultOn: () => false });
  const approvals = createSessionAccessStore({ file: join(dir, "communication-approvals.json"), defaultOn: () => false });
  const agentProjects = createAgentProjectsStore({ file: join(dir, "communication-agent-projects.json"), realpathSync });
  const deps: CommunicationIpcDeps = {
    settingsPath,
    agentProjects,
    realpathSync,
    homedir: () => realpathSync(dir),
    logger: { warn: () => {}, error: () => {} },
    controller,
    sessions,
    approvals,
    tabs: () => [{ tabId: "tab-1", sessionId: "sess-1" }],
    env: () => over.env,
    pickFolder: vi.fn(async () => over.picked),
    stdioScriptPath: () => (over.script === undefined ? "/ud/agent-communication/stdio.mjs" : over.script),
    realpath: (p: string) => import("node:fs/promises").then((fs) => fs.realpath(p)),
    stat: (p: string) => import("node:fs/promises").then((fs) => fs.stat(p)),
  };
  return { deps, controller, sessions, approvals, agentProjects, startServer, pickFolder: deps.pickFolder as ReturnType<typeof vi.fn> };
}

describe("Sessions API IPC (Taskana 4747) — writes go through the dedicated channel", () => {
  it("get reflects the saved block and reports envControlled false", async () => {
    const { deps } = rig();
    const result = await handleCommunicationGet(deps, {});
    expect(result).toMatchObject({ ok: true, envControlled: false, view: { enabled: false, workspaces: [], port: null, defaultSessionAccess: "off" } });
  });

  it("get refuses a payload carrying unexpected keys", async () => {
    expect(await handleCommunicationGet(rig().deps, { path: "/etc" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("set-enabled persists the block and starts the server with the exact config", async () => {
    const { deps, startServer } = rig();
    const result = await handleSetEnabled(deps, { enabled: true });
    expect(result.ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.communication).toEqual({ enabled: true, workspaces: [], defaultSessionAccess: "off" });
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("set-enabled rejects a non-boolean and extra keys", async () => {
    const { deps } = rig();
    expect(await handleSetEnabled(deps, { enabled: "yes" })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleSetEnabled(deps, { enabled: true, extra: 1 })).toEqual({ ok: false, reason: "invalid" });
  });

  it("set-port accepts 0..65535 or null, rejects out of range, and null clears the port", async () => {
    const { deps } = rig();
    expect((await handleSetPort(deps, { port: 4310 })).ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.communication?.port).toBe(4310);
    expect(await handleSetPort(deps, { port: 70000 })).toEqual({ ok: false, reason: "invalid" });
    expect((await handleSetPort(deps, { port: null })).ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.communication?.port).toBeUndefined();
  });

  it("add-workspace refuses ANY path key in the payload (renderer never supplies a path)", async () => {
    const { deps, pickFolder } = rig({ picked: workspaceA });
    expect(await handleAddWorkspace(deps, { path: workspaceA })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleAddWorkspace(deps, { workspace: workspaceA })).toEqual({ ok: false, reason: "invalid" });
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("add-workspace stores the dialog pick (realpath) and applies live", async () => {
    const { deps, startServer, controller } = rig({ picked: workspaceA });
    await handleSetEnabled(deps, { enabled: true });
    expect(startServer).toHaveBeenCalledTimes(1);
    const result = await handleAddWorkspace(deps, {});
    expect(result.ok).toBe(true);
    const stored = (await loadSettings(settingsPath)).settings.communication?.workspaces;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toMatch(/ws-a$/);
    expect(startServer).toHaveBeenCalledTimes(2);
    expect(controller.status().workspaces).toBe(1);
  });

  it("add-workspace cancelled dialog changes nothing", async () => {
    const { deps } = rig({ picked: undefined });
    expect(await handleAddWorkspace(deps, {})).toEqual({ ok: false, reason: "cancelled" });
    expect((await loadSettings(settingsPath)).settings.communication).toBeUndefined();
  });

  it("add-workspace refuses a regular file", async () => {
    expect(await handleAddWorkspace(rig({ picked: fileTarget }).deps, {})).toEqual({ ok: false, reason: "not_a_directory" });
  });

  it("add-workspace refuses a relative pick and a missing folder as io_error", async () => {
    expect(await handleAddWorkspace(rig({ picked: "relative/dir" }).deps, {})).toEqual({ ok: false, reason: "invalid" });
    expect(await handleAddWorkspace(rig({ picked: join(dir, "does-not-exist") }).deps, {})).toEqual({ ok: false, reason: "io_error" });
  });

  it("add-workspace refuses a duplicate by realpath (a symlink to the same folder)", async () => {
    const link = join(dir, "link-to-a");
    await (await import("node:fs/promises")).symlink(workspaceA, link);
    const { deps } = rig({ picked: workspaceA });
    expect((await handleAddWorkspace(deps, {})).ok).toBe(true);
    (deps as { pickFolder: () => Promise<string> }).pickFolder = async () => link;
    expect(await handleAddWorkspace(deps, {})).toEqual({ ok: false, reason: "duplicate" });
  });

  it("add-workspace enforces the cap of 20 folders", async () => {
    const seeded = cloneDefaults();
    seeded.communication = { enabled: true, workspaces: Array.from({ length: 20 }, (_, i) => join(dir, `pre-${i}`)), defaultSessionAccess: "off" };
    await saveSettings(settingsPath, seeded);
    const { deps } = rig({ picked: workspaceB });
    expect(await handleAddWorkspace(deps, {})).toEqual({ ok: false, reason: "too_many" });
  });

  it("remove-workspace matches exactly; an unknown or prefix value is not_found and removes nothing", async () => {
    const { deps } = rig({ picked: workspaceA });
    await handleAddWorkspace(deps, {});
    const [stored] = (await loadSettings(settingsPath)).settings.communication!.workspaces;
    expect(await handleRemoveWorkspace(deps, { workspace: stored!.slice(0, -2) })).toEqual({ ok: false, reason: "not_found" });
    expect((await loadSettings(settingsPath)).settings.communication!.workspaces).toHaveLength(1);
    expect((await handleRemoveWorkspace(deps, { workspace: stored })).ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.communication!.workspaces).toEqual([]);
  });

  it("the view marks allowed folders that are missing on disk, and unmarks them once back", async () => {
    const gone = join(dir, "gone");
    const { deps } = rig({ picked: workspaceA });
    await handleAddWorkspace(deps, {});
    const seeded = (await loadSettings(settingsPath)).settings;
    seeded.communication = { ...seeded.communication!, workspaces: [...seeded.communication!.workspaces, gone] };
    await saveSettings(settingsPath, seeded);
    // The stored entries are realpaths of the temp dirs; the gone entry was stored verbatim.
    const first = await handleCommunicationGet(deps, {});
    expect(first).toMatchObject({ ok: true, view: { missingWorkspaces: [gone], workspaces: expect.any(Array) } });
    expect(first.ok && first.view.workspaces).toHaveLength(2);
    // The folder comes back: the next view (same server instance, no restart) has no mark.
    await (await import("node:fs/promises")).mkdir(gone);
    const again = await handleCommunicationGet(deps, {});
    expect(again).toMatchObject({ ok: true, view: { missingWorkspaces: [], workspaces: expect.any(Array) } });
    expect(again.ok && again.view.workspaces).toHaveLength(2);
  });

  it("set-default-access persists off/on and rejects other values", async () => {
    const { deps } = rig();
    expect((await handleSetDefaultAccess(deps, { access: "on" })).ok).toBe(true);
    expect((await loadSettings(settingsPath)).settings.communication?.defaultSessionAccess).toBe("on");
    expect(await handleSetDefaultAccess(deps, { access: "maybe" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("read_only settings refuse every write with read_only and write nothing", async () => {
    await writeFile(settingsPath, JSON.stringify({ ...cloneDefaults(), version: 999 }));
    const before = await readFile(settingsPath, "utf8");
    const { deps } = rig();
    expect(await handleSetEnabled(deps, { enabled: true })).toEqual({ ok: false, reason: "read_only" });
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("env override: every write is refused env_controlled and get says envControlled", async () => {
    const { deps } = rig({ env: "/abs/config.json" });
    expect(await handleSetEnabled(deps, { enabled: true })).toEqual({ ok: false, reason: "env_controlled" });
    expect(await handleAddWorkspace(deps, {})).toEqual({ ok: false, reason: "env_controlled" });
    expect(await handleRegenerateToken(deps, {})).toEqual({ ok: false, reason: "env_controlled" });
    expect(await handleCommunicationGet(deps, {})).toMatchObject({ ok: true, envControlled: true });
  });
});

describe("Sessions API IPC — per-session switch", () => {
  it("set-session-access toggles a live tab by tabId, and the renderer cannot toggle a non-existent tab", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    expect((await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true })).ok).toBe(true);
    expect(sessions.isExposed("sess-1")).toBe(true);
    expect(await handleSetSessionAccess(deps, { tabId: "ghost", enabled: true })).toEqual({ ok: false, reason: "not_found" });
  });

  it("set-session-access refuses a session path/sessionId smuggled into the payload", async () => {
    const { deps } = rig();
    expect(await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true, sessionId: "sess-1" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("view lists root tabs by tabId and enabled only (no session ids, no paths)", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" }); sessions.set("sess-1", true);
    const result = await handleCommunicationGet(deps, {});
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.tabs).toEqual([{ tabId: "tab-1", enabled: true, approvals: false }]);
    expect(JSON.stringify(result)).not.toContain("sess-1");
  });
});

describe("Sessions API IPC — regenerate and copy-config", () => {
  it("regenerate-token returns a listening view and never the token", async () => {
    const { deps, controller } = rig();
    await handleSetEnabled(deps, { enabled: true });
    const result = await handleRegenerateToken(deps, {});
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(controller.status().state).toBe("listening");
  });

  it("regenerate refuses when the server is not running", async () => {
    expect(await handleRegenerateToken(rig().deps, {})).toEqual({ ok: false, reason: "not_running" });
  });

  it("copy-config refuses when not listening", async () => {
    expect(await handleCopyConfig(rig().deps, { client: "claude-code" })).toEqual({ ok: false, reason: "not_running" });
  });

  it("copy-config reports no_adapter when the stdio adapter is not in this build", async () => {
    const { deps } = rig({ script: null });
    await handleSetEnabled(deps, { enabled: true });
    expect(await handleCopyConfig(deps, { client: "generic" })).toEqual({ ok: false, reason: "no_adapter" });
  });

  it("copy-config refuses an unknown client and extra keys", async () => {
    const { deps } = rig();
    expect(await handleCopyConfig(deps, { client: "vscode" })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleCopyConfig(deps, { client: "generic", discovery: "/x" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("copy-config for each client is valid JSON, points at the stdio adapter and the discovery file, and holds no token", async () => {
    const { deps } = rig();
    await handleSetEnabled(deps, { enabled: true });
    for (const client of ["claude-code", "codex", "generic"] as const) {
      const result = await handleCopyConfig(deps, { client });
      if (!result.ok) throw new Error(`expected ok for ${client}`);
      const parsed = JSON.parse(result.json);
      expect(parsed.mcpServers["anycode-sessions"].command).toBe("node");
      expect(parsed.mcpServers["anycode-sessions"].args).toEqual(["/ud/agent-communication/stdio.mjs", join(dir, "communication.json")]);
      expect(result.json).not.toMatch(/[0-9a-f]{32,}/);
      expect(result.json).not.toContain(TOKEN);
      expect(result.note).not.toContain(TOKEN);
    }
  });

  it("claude-code note carries the one-liner, codex note carries the TOML table, generic note is empty", () => {
    const claude = buildCopyConfig("claude-code", "/ud/stdio.mjs", "/ud/communication.json");
    expect(claude.note).toBe("Add it with: claude mcp add anycode-sessions -- node /ud/stdio.mjs /ud/communication.json");
    const codex = buildCopyConfig("codex", "/ud/stdio.mjs", "/ud/communication.json");
    expect(codex.note).toBe('[mcp_servers.anycode-sessions]\ncommand = "node"\nargs = ["/ud/stdio.mjs", "/ud/communication.json"]');
    expect(buildCopyConfig("generic", "/a", "/b").note).toBe("");
  });

  it("escapes quotes, backslashes and control characters in TOML strings", () => {
    expect(tomlString('C:\\Users\\"me"\tx')).toBe('"C:\\\\Users\\\\\\"me\\"\\tx"');
    expect(tomlString("a\u0001b")).toBe('"a\\u0001b"');
  });

  it("builds JSON with JSON.stringify so a path with quotes stays valid JSON", () => {
    const hostile = '/ud/with "quote" and \\backslash/stdio.mjs';
    const built = buildCopyConfig("generic", hostile, "/ud/communication.json");
    expect(JSON.parse(built.json).mcpServers["anycode-sessions"].args[0]).toBe(hostile);
  });

  it("quotes a path with spaces in the claude one-liner", () => {
    const built = buildCopyConfig("claude-code", "/ud dir/stdio.mjs", "/ud/c.json");
    expect(built.note).toContain("'/ud dir/stdio.mjs'");
  });
});

describe("Sessions API IPC — token absence over every result", () => {
  it("no handler result, serialised, contains the token (copy-config may carry the discovery PATH, never the token)", async () => {
    const { deps } = rig({ picked: workspaceA });
    const results: unknown[] = [];
    const copies: unknown[] = [];
    results.push(await handleCommunicationGet(deps, {}));
    results.push(await handleSetEnabled(deps, { enabled: true }));
    results.push(await handleSetPort(deps, { port: 0 }));
    results.push(await handleAddWorkspace(deps, {}));
    results.push(await handleSetDefaultAccess(deps, { access: "on" }));
    results.push(await handleRegenerateToken(deps, {}));
    for (const client of ["claude-code", "codex", "generic"] as const) copies.push(await handleCopyConfig(deps, { client }));
    results.push(await handleRemoveWorkspace(deps, { workspace: "/nope" }));
    results.push(await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true }));
    expect(JSON.stringify(results)).not.toContain("communication.json");
    expect(JSON.stringify([...results, ...copies])).not.toContain(TOKEN);
  });
});

describe("Sessions API IPC — persisted settings never carry the token", () => {
  it("settings.json holds no token after enabling and regenerating", async () => {
    const { deps } = rig({ picked: workspaceA });
    await handleSetEnabled(deps, { enabled: true });
    await handleRegenerateToken(deps, {});
    expect(await readFile(settingsPath, "utf8")).not.toContain(TOKEN);
  });
});

describe("session handles over IPC (Taskana 4750b)", () => {
  it("set-session-handle maps tabId to session and returns view with handle", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    const result = await handleSetSessionHandle(deps, { tabId: "tab-1", handle: "build-bot" });
    expect(result.ok).toBe(true);
    expect(sessions.getHandle("sess-1")).toBe("build-bot");
    if (result.ok) expect(result.view.tabs).toEqual([{ tabId: "tab-1", enabled: false, approvals: false, handle: "build-bot" }]);
    expect(JSON.stringify(result)).not.toContain("sess-1");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("invalid handle -> invalid", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    expect(await handleSetSessionHandle(deps, { tabId: "tab-1", handle: "Build Bot" })).toEqual({ ok: false, reason: "invalid" });
    expect(sessions.getHandle("sess-1")).toBeUndefined();
  });
  it("duplicate -> duplicate", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" }); sessions.register({ sessionId: "sess-2" });
    const live = [{ tabId: "tab-1", sessionId: "sess-1" }, { tabId: "tab-2", sessionId: "sess-2" }];
    const twoTabs = { ...deps, tabs: () => live };
    expect((await handleSetSessionHandle(twoTabs, { tabId: "tab-1", handle: "shared" })).ok).toBe(true);
    expect(await handleSetSessionHandle(twoTabs, { tabId: "tab-2", handle: "shared" })).toEqual({ ok: false, reason: "duplicate" });
  });
  it("unknown tab -> unknown_tab", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    expect(await handleSetSessionHandle(deps, { tabId: "ghost", handle: "x" })).toEqual({ ok: false, reason: "unknown_tab" });
  });
  it("extra key (sessionId/path) refused by .strict", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    expect(await handleSetSessionHandle(deps, { tabId: "tab-1", handle: "x", sessionId: "sess-1" })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleSetSessionHandle(deps, { tabId: "tab-1", handle: "x", path: "/etc" })).toEqual({ ok: false, reason: "invalid" });
    expect(sessions.getHandle("sess-1")).toBeUndefined();
  });
  it("null clears", async () => {
    const { deps, sessions } = rig();
    sessions.register({ sessionId: "sess-1" });
    await handleSetSessionHandle(deps, { tabId: "tab-1", handle: "x" });
    expect((await handleSetSessionHandle(deps, { tabId: "tab-1", handle: null })).ok).toBe(true);
    expect(sessions.getHandle("sess-1")).toBeUndefined();
  });
});

describe("Sessions API IPC — External approvals switch (Taskana 4763)", () => {
  it("T26 set-session-approvals: happy path only while shared; invalid payloads, unknown tab, env-controlled and access-off are refused", async () => {
    const { deps, sessions, approvals } = rig();
    sessions.register({ sessionId: "sess-1" });
    approvals.register({ sessionId: "sess-1" });
    expect(await handleSetSessionApprovals(deps, { tabId: "tab-1", enabled: true })).toEqual({ ok: false, reason: "not_found" });
    expect(approvals.isExposed("sess-1")).toBe(false);
    expect((await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true })).ok).toBe(true);
    const happy = await handleSetSessionApprovals(deps, { tabId: "tab-1", enabled: true });
    expect(happy.ok).toBe(true);
    expect(approvals.isExposed("sess-1")).toBe(true);
    if (happy.ok) expect(happy.view.tabs).toEqual([{ tabId: "tab-1", enabled: true, approvals: true }]);
    expect(await handleSetSessionApprovals(deps, { tabId: "tab-1", enabled: true, sessionId: "sess-1" })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleSetSessionApprovals(deps, { tabId: "", enabled: true })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleSetSessionApprovals(deps, { tabId: "ghost", enabled: true })).toEqual({ ok: false, reason: "not_found" });
    const envRig = rig({ env: "/abs/config.json" });
    envRig.sessions.register({ sessionId: "sess-1" }); envRig.approvals.register({ sessionId: "sess-1" });
    expect(await handleSetSessionApprovals(envRig.deps, { tabId: "tab-1", enabled: true })).toEqual({ ok: false, reason: "env_controlled" });
  });

  it("T27 turning sharing off also clears External approvals, so re-sharing comes back with approvals OFF; the view reports approvals", async () => {
    const { deps, sessions, approvals } = rig();
    sessions.register({ sessionId: "sess-1" }); approvals.register({ sessionId: "sess-1" });
    await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true });
    await handleSetSessionApprovals(deps, { tabId: "tab-1", enabled: true });
    const shown = await handleCommunicationGet(deps, {});
    if (!shown.ok) throw new Error("expected ok");
    expect(shown.view.tabs).toEqual([{ tabId: "tab-1", enabled: true, approvals: true }]);
    expect(await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: false })).toMatchObject({ ok: true });
    expect(approvals.isExposed("sess-1")).toBe(false);
    await handleSetSessionAccess(deps, { tabId: "tab-1", enabled: true });
    const again = await handleCommunicationGet(deps, {});
    if (!again.ok) throw new Error("expected ok");
    expect(again.view.tabs).toEqual([{ tabId: "tab-1", enabled: true, approvals: false }]);
  });
});

describe("External approvals — the only writer (Taskana 4763)", () => {
  it("T32 no main-process code except communication-ipc.ts sets the approvals store", () => {
    const mainDir = fileURLToPath(new URL(".", import.meta.url));
    const writers = readdirSync(mainDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /\.approvals\.set\(|communicationApprovals\??\.set\(/.test(readFileSync(join(mainDir, name), "utf8")));
    expect(writers).toEqual(["communication-ipc.ts"]);
  });
});


describe("Sessions API IPC — per-project agent-open switch (Taskana 4768)", () => {
  it("agent projects: get answers by canonical comparison; set stores canonically and refuses relative paths; off removes by exact stored key; env mode refuses every write; view carries agentProjects rows", async () => {
    const { deps, agentProjects } = rig();
    const link = join(dir, "link-a");
    symlinkSync(workspaceA, link);
    expect(await handleAgentProjectsGet(deps, { workspace: workspaceA })).toEqual({ ok: true, enabled: false });

    const set = await handleAgentProjectsSet(deps, { workspace: link, enabled: true });
    expect(set).toMatchObject({ ok: true, view: { agentProjects: [{ key: realpathSync(workspaceA), name: "ws-a" }] } });
    expect(agentProjects.allowedKeys()).toEqual([realpathSync(workspaceA)]);
    expect(await handleAgentProjectsGet(deps, { workspace: workspaceA })).toEqual({ ok: true, enabled: true });
    expect(await handleAgentProjectsGet(deps, { workspace: link })).toEqual({ ok: true, enabled: true });
    expect(await handleAgentProjectsGet(deps, { workspace: workspaceB })).toEqual({ ok: true, enabled: false });

    expect(await handleAgentProjectsSet(deps, { workspace: "relative/path", enabled: true })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleAgentProjectsSet(deps, { workspace: workspaceA, enabled: true, extra: 1 })).toEqual({ ok: false, reason: "invalid" });

    const listed = await handleAgentProjectsList(deps, {});
    expect(listed).toMatchObject({ ok: true, projects: [{ key: realpathSync(workspaceA), name: "ws-a" }] });
    if (listed.ok) expect(listed.projects[0]!.displayPath.startsWith("~")).toBe(true);

    expect(await handleAgentProjectsOff(deps, { key: link })).toEqual({ ok: false, reason: "not_found" });
    expect(agentProjects.isAllowed(workspaceA)).toBe(true);
    expect(await handleAgentProjectsOff(deps, { key: realpathSync(workspaceA) })).toMatchObject({ ok: true, view: { agentProjects: [] } });
    expect(agentProjects.isAllowed(workspaceA)).toBe(false);

    const env = rig({ env: "/abs/config.json" });
    expect(await handleAgentProjectsSet(env.deps, { workspace: workspaceA, enabled: true })).toEqual({ ok: false, reason: "env_controlled" });
    expect(await handleAgentProjectsOff(env.deps, { key: workspaceA })).toEqual({ ok: false, reason: "env_controlled" });
    expect(env.agentProjects.allowedKeys()).toEqual([]);
  });
});
