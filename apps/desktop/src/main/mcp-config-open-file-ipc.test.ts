import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } }));
import { NodeMcpConfigFs, type McpConfigIpcDeps } from "./mcp-config-ipc.js";
import { handleMcpConfigOpenFile, registerMcpConfigOpenFileIpc } from "./mcp-config-open-file-ipc.js";
import { checkConfigFilePath } from "./config-file-path.js";
import { addIpcGuardTrustedWindow, resetIpcGuardForTests, setIpcGuardMainWindow } from "./ipc-guard.js";
import { MCP_CONFIG_OPEN_FILE_CHANNEL } from "../shared/mcp-config.js";

let root: string;
let deps: McpConfigIpcDeps;
let project: string;
let user: string;
const request = { tabId: "a", source: "project" };
const refuse = (reason: string) => ({ ok: false, reason });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "config-open-")));
  project = join(root, "project");
  user = join(root, "user");
  for (const base of [project, user]) {
    await mkdir(join(base, ".anycode"), { recursive: true });
    await writeFile(join(base, ".anycode/config.json"), '{"secret":"private"}');
    await writeFile(join(base, ".mcp.json"), "{}");
  }
  deps = {
    fs: new NodeMcpConfigFs(), home: vi.fn(() => user),
    workspaceForTab: vi.fn((id) => id === "a" ? project : id === "b" ? user : undefined),
    openPath: vi.fn(async () => ""), reveal: vi.fn(),
  };
});
afterEach(async () => { resetIpcGuardForTests(); await rm(root, { recursive: true, force: true }); });

describe("configuration file custody", () => {
  it.each(["project", "user", "compat"] as const)("opens the fixed %s source without reading contents", async (source) => {
    const read = vi.spyOn(deps.fs, "readFile");
    const result = await handleMcpConfigOpenFile(deps, { ...request, source });
    expect(result).toEqual({ ok: true });
    expect(deps.openPath).toHaveBeenCalledWith(join(source === "user" ? user : project, source === "compat" ? ".mcp.json" : ".anycode/config.json"));
    expect(read).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });
  it("resolves tabs independently and supports user-only access", async () => {
    expect(await handleMcpConfigOpenFile(deps, { ...request, tabId: "b" })).toEqual({ ok: true });
    expect(deps.openPath).toHaveBeenCalledWith(join(user, ".anycode/config.json"));
    expect(await handleMcpConfigOpenFile(deps, { source: "user" })).toEqual({ ok: true });
    for (const tabId of [undefined, "closed"]) {
      for (const source of ["project", "compat"]) {
        expect(await handleMcpConfigOpenFile(deps, { tabId, source })).toEqual(refuse("no_workspace"));
      }
    }
  });
  it.each([null, {}, { ...request, path: "/etc/passwd" }, { ...request, url: "file:///tmp/a" }, { ...request, command: "open" }, { ...request, action: "execute" }, { ...request, source: "plugin" }, { ...request, tabId: 3 }])("refuses invalid input %j", async (raw) => {
    expect(await handleMcpConfigOpenFile(deps, raw)).toEqual(refuse("invalid"));
    expect(deps.workspaceForTab).not.toHaveBeenCalled();
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it.each(["open", "reveal"])("refuses missing, directory and special files for %s", async (action) => {
    const target = join(project, ".anycode/config.json");
    await rm(target);
    expect(await handleMcpConfigOpenFile(deps, { ...request, action })).toEqual(refuse("not_found"));
    await mkdir(target);
    expect(await handleMcpConfigOpenFile(deps, { ...request, action })).toEqual(refuse("unsafe_path"));
    const lstat = deps.fs.lstat!.bind(deps.fs);
    vi.spyOn(deps.fs, "lstat").mockImplementation(async (path) => path === target
      ? { size: 0, mtimeMs: 0, isFile: false, isDirectory: false, isSymbolicLink: false }
      : lstat(path));
    expect(await handleMcpConfigOpenFile(deps, { ...request, action })).toEqual(refuse("unsafe_path"));
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });
  it.each(["open", "reveal"])("refuses leaf, intermediate, internal and dangling symlinks for %s", async (action) => {
    const folder = join(project, ".anycode");
    const target = join(folder, "config.json");
    await rm(target);
    for (const destination of [join(user, ".mcp.json"), join(project, ".mcp.json"), join(root, "missing")]) {
      await symlink(destination, target);
      expect(await handleMcpConfigOpenFile(deps, { ...request, action })).toEqual(refuse("unsafe_path"));
      await rm(target);
    }
    await rm(folder, { recursive: true });
    for (const destination of [join(user, ".anycode"), project, join(root, "missing")]) {
      await symlink(destination, folder);
      expect(await handleMcpConfigOpenFile(deps, { ...request, action })).toEqual(refuse("unsafe_path"));
      await rm(folder);
    }
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });
  it("permits a symlinked workspace base and dispatches its canonical path", async () => {
    const alias = join(root, "alias");
    await symlink(project, alias);
    deps.workspaceForTab = () => alias;
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual({ ok: true });
    expect(deps.openPath).toHaveBeenCalledWith(join(project, ".anycode/config.json"));
  });
  it("fails closed without filesystem capabilities or on permission errors", async () => {
    const lstat = deps.fs.lstat;
    deps.fs.lstat = undefined;
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    deps.fs.lstat = lstat;
    vi.spyOn(deps.fs, "realpath").mockRejectedValue({ code: "EACCES" });
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it("refuses unprovable leaf metadata and canonical containment escapes", async () => {
    const target = join(project, ".anycode/config.json");
    const lstat = deps.fs.lstat!.bind(deps.fs);
    const spy = vi.spyOn(deps.fs, "lstat").mockImplementation(async (path) => {
      const st = await lstat(path);
      return path === target ? { ...st, isSymbolicLink: undefined } : st;
    });
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    spy.mockRestore();
    const real = deps.fs.realpath!.bind(deps.fs);
    vi.spyOn(deps.fs, "realpath").mockImplementation((path) => path === target ? Promise.resolve(join(user, ".mcp.json")) : real(path));
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it("applies symlink refusal to user and compatibility sources", async () => {
    await rm(join(user, ".anycode"), { recursive: true });
    await symlink(join(project, ".anycode"), join(user, ".anycode"));
    await rm(join(project, ".mcp.json"));
    await symlink(join(user, ".mcp.json"), join(project, ".mcp.json"));
    for (const action of ["open", "reveal"]) {
      for (const source of ["user", "compat"]) {
        expect(await handleMcpConfigOpenFile(deps, { ...request, action, source })).toEqual(refuse("unsafe_path"));
      }
    }
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  });
  it("limits the helper to fixed JSON leaves", async () => {
    for (const leaf of ["other.json", "../user/.mcp.json", ".anycode/config.sh"]) {
      expect(await checkConfigFilePath(deps.fs, project, join(project, leaf))).toEqual(refuse("unsafe_path"));
    }
  });
  it("rechecks filesystem and workspace custody before dispatch", async () => {
    const original = deps.fs.realpath!.bind(deps.fs);
    let calls = 0;
    vi.spyOn(deps.fs, "realpath").mockImplementation(async (path) => {
      const result = await original(path);
      if (++calls === 2) {
        await rm(join(project, ".anycode/config.json"));
        await symlink(join(user, ".mcp.json"), join(project, ".anycode/config.json"));
      }
      return result;
    });
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    deps.workspaceForTab = vi.fn().mockReturnValueOnce(project).mockReturnValue(undefined);
    expect(await handleMcpConfigOpenFile(deps, { ...request, source: "compat" })).toEqual(refuse("no_workspace"));
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it("refuses a base symlink retargeted between custody checks", async () => {
    const alias = join(root, "alias");
    await symlink(project, alias);
    deps.workspaceForTab = () => alias;
    const real = deps.fs.realpath!.bind(deps.fs);
    let calls = 0;
    vi.spyOn(deps.fs, "realpath").mockImplementation(async (path) => {
      const result = await real(path);
      if (++calls === 2) { await rm(alias); await symlink(user, alias); }
      return result;
    });
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("unsafe_path"));
    expect(deps.openPath).not.toHaveBeenCalled();
  });
  it("handles OS error strings and throws without leaking or logging raw errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.openPath = vi.fn(async () => "private path and OS error");
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("open_failed"));
    deps.openPath = vi.fn(async () => { throw new Error("private"); });
    expect(await handleMcpConfigOpenFile(deps, request)).toEqual(refuse("open_failed"));
    expect(deps.reveal).not.toHaveBeenCalled();
    expect(await handleMcpConfigOpenFile(deps, { ...request, action: "reveal" })).toEqual({ ok: true });
    expect(deps.reveal).toHaveBeenCalledWith(join(project, ".anycode/config.json"));
    deps.reveal = () => { throw new Error("private"); };
    expect(await handleMcpConfigOpenFile(deps, { ...request, action: "reveal" })).toEqual(refuse("open_failed"));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("guards the registered channel against foreign frames and restricted popouts", async () => {
    const main = { mainFrame: {} };
    const popout = { mainFrame: {} };
    setIpcGuardMainWindow(() => main);
    addIpcGuardTrustedWindow(popout, ["anycode:md-preview-read"]);
    registerMcpConfigOpenFileIpc(deps);
    const handler = handlers.get(MCP_CONFIG_OPEN_FILE_CHANNEL)!;
    for (const event of [undefined, { sender: {}, senderFrame: {} }, { sender: main, senderFrame: {} }, { sender: popout, senderFrame: popout.mainFrame }]) {
      expect(() => handler(event, request)).toThrow(/refused/);
    }
    addIpcGuardTrustedWindow(popout);
    expect(() => handler({ sender: popout, senderFrame: popout.mainFrame }, request)).toThrow(/refused/);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(await handler({ sender: main, senderFrame: main.mainFrame }, request)).toEqual({ ok: true });
  });
});
