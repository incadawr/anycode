import { describe, expect, it, vi } from "vitest";
import { createCommunicationController, type CommunicationControllerDeps, type CommunicationServerHandle } from "./communication-controller.js";

const TOKEN = "f".repeat(64);
function fakeServer(log: string[], opts: { failWith?: Error; port?: number } = {}) {
  const starts: unknown[] = [];
  const start = vi.fn(async (options: Record<string, unknown>) => {
    log.push("start");
    starts.push(options);
    if (opts.failWith) throw opts.failWith;
    const port = opts.port ?? 43123;
    const handle: CommunicationServerHandle = {
      url: `http://127.0.0.1:${port}/mcp`,
      discoveryFile: "/abs/userData/communication.json",
      close: vi.fn(async () => { log.push("close"); }),
    };
    return handle;
  });
  return { start, starts };
}
function deps(over: Partial<CommunicationControllerDeps> & { log?: string[]; server?: ReturnType<typeof fakeServer> } = {}) {
  const log = over.log ?? [];
  const server = over.server ?? fakeServer(log);
  const errors: string[] = [];
  const d: CommunicationControllerDeps = {
    manager: () => ({ listTabs: () => [], communicationRequest: vi.fn() }) as never,
    userData: "/abs/userData",
    logger: { error: (m: string) => errors.push(m) },
    startServer: server.start as never,
    env: () => undefined,
    isSessionExposed: () => true,
    countExposed: () => 0,
    ...over,
  };
  return { d, server, log, errors };
}

describe("communication controller (Taskana 4747) — settings-driven live server", () => {
  it("stays off and never starts when the Sessions API is disabled", async () => {
    const { d, server } = deps();
    const c = createCommunicationController(d);
    const status = await c.apply({ enabled: false, workspaces: [] });
    expect(server.start).not.toHaveBeenCalled();
    expect(status.state).toBe("off");
  });

  it("starts with the exact workspaces and port when enabled, with no folder yet allowed", async () => {
    const { d, server } = deps();
    const c = createCommunicationController(d);
    const status = await c.apply({ enabled: true, workspaces: ["/abs/one"], port: 4310 });
    expect(server.start).toHaveBeenCalledTimes(1);
    const arg = server.starts[0] as { config: unknown; userData: string; configFile?: string };
    expect(arg.config).toEqual({ workspaces: ["/abs/one"], port: 4310 });
    expect(arg.configFile).toBeUndefined();
    expect(status).toMatchObject({ state: "listening", url: "http://127.0.0.1:43123/mcp", port: 43123, workspaces: 1 });
  });

  it("enabled with zero folders still starts (sessions gate on their own switch)", async () => {
    const { d, server } = deps();
    const c = createCommunicationController(d);
    const status = await c.apply({ enabled: true, workspaces: [] });
    expect(server.start).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("listening");
    expect(status.workspaces).toBe(0);
  });

  it("a settings change closes the previous server before starting the new one", async () => {
    const { d, log } = deps();
    const c = createCommunicationController(d);
    await c.apply({ enabled: true, workspaces: ["/abs/one"], port: 0 });
    await c.apply({ enabled: true, workspaces: ["/abs/two"], port: 0 });
    expect(log).toEqual(["start", "close", "start"]);
  });

  it("disabling stops the running server", async () => {
    const { d, log } = deps();
    const c = createCommunicationController(d);
    await c.apply({ enabled: true, workspaces: [], port: 0 });
    const status = await c.apply({ enabled: false, workspaces: [] });
    expect(log).toEqual(["start", "close"]);
    expect(status.state).toBe("off");
  });

  it("a start failure yields error/start_failed with a fixed detail, never throws, never leaks the path", async () => {
    const err = Object.assign(new Error("listen EADDRINUSE: 127.0.0.1:4310 /secret/path"), { code: "EADDRINUSE" });
    const { d, errors } = deps({ server: fakeServer([], { failWith: err }) });
    const c = createCommunicationController(d);
    const status = await c.apply({ enabled: true, workspaces: [], port: 4310 });
    expect(status).toMatchObject({ state: "error", reason: "start_failed", detail: "port in use" });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(errors.join("\n")).not.toContain("secret");
  });

  it("an unknown start failure reports a generic detail", async () => {
    const { d } = deps({ server: fakeServer([], { failWith: new Error("boom /x/y") }) });
    const status = await createCommunicationController(d).apply({ enabled: true, workspaces: [] });
    expect(status).toMatchObject({ state: "error", reason: "start_failed", detail: "could not start" });
  });

  it("regenerate is stop then start with the same config, returning a new listening status", async () => {
    const { d, log, server } = deps();
    const c = createCommunicationController(d);
    await c.apply({ enabled: true, workspaces: ["/abs/one"], port: 0 });
    const result = await c.regenerateToken();
    expect(log).toEqual(["start", "close", "start"]);
    expect((server.starts[1] as { config: unknown }).config).toEqual((server.starts[0] as { config: unknown }).config);
    expect(result).toMatchObject({ ok: true, status: { state: "listening" } });
  });

  it("regenerate refuses when the server is not running", async () => {
    const { d } = deps();
    expect(await createCommunicationController(d).regenerateToken()).toEqual({ ok: false, reason: "not_running" });
  });

  it("env mode ignores settings, starts from the env config file and refuses regenerate", async () => {
    const { d, server } = deps({ env: () => "/abs/config.json" });
    const c = createCommunicationController(d);
    const status = await c.apply({ enabled: true, workspaces: ["/abs/settings"], port: 9 });
    expect(server.starts).toEqual([{ manager: expect.anything(), userData: "/abs/userData", configFile: "/abs/config.json" }]);
    expect(status.state).toBe("env");
    expect(await c.regenerateToken()).toEqual({ ok: false, reason: "env_controlled" });
  });

  it("env mode does not pass a per-session predicate (env keeps folder-wide semantics)", async () => {
    const { d, server } = deps({ env: () => "/abs/config.json" });
    await createCommunicationController(d).apply({ enabled: false, workspaces: [] });
    expect((server.starts[0] as Record<string, unknown>).isSessionExposed).toBeUndefined();
  });

  it("passes the live per-session predicate in settings mode", async () => {
    const exposed = vi.fn((id: string) => id === "tab-session");
    const { d, server } = deps({ isSessionExposed: exposed });
    await createCommunicationController(d).apply({ enabled: true, workspaces: [], port: 0 });
    const options = server.starts[0] as { isSessionExposed: (id: string) => boolean };
    expect(options.isSessionExposed("tab-session")).toBe(true);
    expect(options.isSessionExposed("other")).toBe(false);
  });

  it("serialises rapid applies: concurrent calls end with the last one running, never two servers", async () => {
    const { d, server, log } = deps();
    const c = createCommunicationController(d);
    await Promise.all([
      c.apply({ enabled: true, workspaces: ["/abs/a"], port: 0 }),
      c.apply({ enabled: true, workspaces: ["/abs/b"], port: 0 }),
      c.apply({ enabled: true, workspaces: ["/abs/c"], port: 0 }),
    ]);
    expect(log).toEqual(["start", "close", "start", "close", "start"]);
    expect((server.starts[2] as { config: { workspaces: string[] } }).config.workspaces).toEqual(["/abs/c"]);
    expect(c.status().state).toBe("listening");
  });

  it("status never contains the token or the discovery file contents", async () => {
    const { d } = deps();
    const c = createCommunicationController(d);
    await c.apply({ enabled: true, workspaces: ["/abs/one"], port: 0 });
    const text = JSON.stringify(c.status());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("discovery");
    expect(text).not.toContain("communication.json");
  });

  it("dispose closes a running server and leaves the controller off", async () => {
    const { d, log } = deps();
    const c = createCommunicationController(d);
    await c.apply({ enabled: true, workspaces: [], port: 0 });
    await c.dispose();
    expect(log).toEqual(["start", "close"]);
    expect(c.status().state).toBe("off");
  });

  it("exposes the discovery file path only through the discoveryFile accessor, never through status", async () => {
    const { d } = deps();
    const c = createCommunicationController(d);
    expect(c.discoveryFile()).toBeUndefined();
    await c.apply({ enabled: true, workspaces: [], port: 0 });
    expect(c.discoveryFile()).toBe("/abs/userData/communication.json");
    expect(JSON.stringify(c.status())).not.toContain("communication.json");
  });
});
