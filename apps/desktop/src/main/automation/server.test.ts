/**
 * Server perimeter tests (design/phase-2-smoke-channel.md §5, task S3
 * criterion). Boots the real `node:http` server on an ephemeral loopback port
 * with an injected token/info-path and fakes for window/manager/app, then
 * drives it over `fetch`. Covers the fail-closed auth perimeter (401 with
 * no/wrong token, constant-time compare, loopback gate), the 256 KB body cap,
 * the 0600 discovery file + its unlink on close, JSON/route error mapping, and
 * that a routed request reaches the handler layer (new-tab, facade 503).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isLoopback,
  startAutomationServer,
  tokenMatches,
  type AutomationServerDeps,
  type AutomationServerHandle,
} from "./server.js";
import type { AutomationWindow, ManagerLike } from "./handlers.js";
import type { CreateTabResult, TabHost, TabSummary } from "../tabs.js";

const TOKEN = "0".repeat(64); // deterministic 64-hex-char token for the tests

let handle: AutomationServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

function fakeManager(overrides: Partial<ManagerLike> = {}): ManagerLike {
  return {
    createTab: vi.fn(
      (params): CreateTabResult => ({
        ok: true,
        tab: {
          tabId: "tab-new",
          workspace: params.workspace,
          sessionId: params.sessionId,
          proc: null,
          spawnedAt: 0,
          rapidRespawns: 0,
          state: "running",
          initialResume: params.resume,
        } as TabHost,
      }),
    ),
    deliverTabPort: vi.fn(),
    listTabs: vi.fn((): ReadonlyArray<TabSummary> => []),
    ...overrides,
  };
}

function fakeWindow(): AutomationWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: vi.fn(async () => ({ __facade: "ok", value: { tabs: [], activeTabId: null, states: {} } })),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("PNG") })),
    },
  };
}

/**
 * A fake window whose `executeJavaScript` (the facade call channel — see
 * `buildFacadeExpr`) always resolves to an ok-envelope wrapping `value`, and
 * records every executed source string so a test can assert which facade
 * method/args were embedded (same substring-assertion idiom as
 * handlers.test.ts's "builds an expression that names the method...").
 */
function fakeWindowCapture(value: unknown = { ok: true }): { window: AutomationWindow; calls: string[] } {
  const calls: string[] = [];
  const window: AutomationWindow = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: vi.fn(async (code: string) => {
        calls.push(code);
        return { __facade: "ok", value };
      }),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("PNG") })),
    },
  };
  return { window, calls };
}

async function boot(overrides: Partial<AutomationServerDeps> = {}): Promise<AutomationServerHandle> {
  const infoPath = join(tmpdir(), `automation-test-${randomUUID()}.json`);
  handle = await startAutomationServer({
    getWindow: () => fakeWindow(),
    manager: fakeManager(),
    app: { quit: vi.fn(), getVersion: () => "1.2.3", on: vi.fn() } as AutomationServerDeps["app"],
    token: TOKEN,
    port: 0,
    infoPath,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
  return handle;
}

function url(h: AutomationServerHandle, path: string): string {
  return `http://127.0.0.1:${h.port}${path}`;
}

function auth(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("auth perimeter (§5)", () => {
  it("401 with no Authorization header", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/health"));
    expect(res.status).toBe(401);
  });

  it("401 with a wrong token of the same length (exercises the constant-time compare)", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/health"), { headers: auth("1".repeat(64)) });
    expect(res.status).toBe(401);
  });

  it("401 with a malformed (non-Bearer) header", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/health"), { headers: { Authorization: TOKEN } });
    expect(res.status).toBe(401);
  });

  it("200 /health with the correct token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/health"), { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, version: "1.2.3", tabs: 0 });
    expect(typeof body.pid).toBe("number");
  });

  it("tokenMatches is length-safe and correct", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false); // different length -> false, no throw
    expect(tokenMatches("", "")).toBe(true);
  });

  it("isLoopback accepts only loopback addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe("body limits + error mapping (§4/§5)", () => {
  it("413 when the body exceeds 256 KB", async () => {
    const h = await boot();
    const big = "x".repeat(300 * 1024);
    const res = await fetch(url(h, "/tabs"), { method: "POST", headers: auth(), body: big });
    expect(res.status).toBe(413);
  });

  it("400 on invalid JSON", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs"), { method: "POST", headers: auth(), body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("400 on a well-formed JSON body that fails the schema", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs"), { method: "POST", headers: auth(), body: JSON.stringify({ kind: "bogus" }) });
    expect(res.status).toBe(400);
  });

  it("404 on an unknown route", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/nope"), { headers: auth() });
    expect(res.status).toBe(404);
  });
});

describe("discovery file (§5)", () => {
  it("writes {pid,port,token,startedAt} with mode 0600 and unlinks it on close", async () => {
    const h = await boot();
    const mode = statSync(h.infoPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const info = JSON.parse(readFileSync(h.infoPath, "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.port).toBe(h.port);
    expect(info.token).toBe(TOKEN);
    expect(typeof info.startedAt).toBe("number");

    await h.close();
    handle = null;
    expect(existsSync(h.infoPath)).toBe(false);
  });

  it("honors ANYCODE_AUTOMATION_INFO when no explicit infoPath is injected (design slice-P7.H-cut.md §4.3)", async () => {
    const envInfoPath = join(tmpdir(), `automation-test-env-${randomUUID()}.json`);
    const prior = process.env["ANYCODE_AUTOMATION_INFO"];
    process.env["ANYCODE_AUTOMATION_INFO"] = envInfoPath;
    try {
      handle = await startAutomationServer({
        getWindow: () => fakeWindow(),
        manager: fakeManager(),
        app: { quit: vi.fn(), getVersion: () => "1.2.3", on: vi.fn() } as AutomationServerDeps["app"],
        token: TOKEN,
        port: 0,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(handle.infoPath).toBe(envInfoPath);
      expect(existsSync(envInfoPath)).toBe(true);
    } finally {
      if (prior === undefined) {
        delete process.env["ANYCODE_AUTOMATION_INFO"];
      } else {
        process.env["ANYCODE_AUTOMATION_INFO"] = prior;
      }
    }
  });

  it("an explicit infoPath wins over ANYCODE_AUTOMATION_INFO", async () => {
    const envInfoPath = join(tmpdir(), `automation-test-env-losing-${randomUUID()}.json`);
    const explicitInfoPath = join(tmpdir(), `automation-test-explicit-${randomUUID()}.json`);
    const prior = process.env["ANYCODE_AUTOMATION_INFO"];
    process.env["ANYCODE_AUTOMATION_INFO"] = envInfoPath;
    try {
      handle = await boot({ infoPath: explicitInfoPath });
      expect(handle.infoPath).toBe(explicitInfoPath);
      expect(existsSync(envInfoPath)).toBe(false);
    } finally {
      if (prior === undefined) {
        delete process.env["ANYCODE_AUTOMATION_INFO"];
      } else {
        process.env["ANYCODE_AUTOMATION_INFO"] = prior;
      }
    }
  });
});

describe("discovery-file ownership guard (codex finding P7.H-1)", () => {
  it("close() does NOT unlink a discovery file a second server has since overwritten", async () => {
    const infoPath = join(tmpdir(), `automation-test-shared-${randomUUID()}.json`);
    // Server 1 boots and writes infoPath.
    const h1 = await boot({ infoPath, token: "1".repeat(64) });
    expect(existsSync(infoPath)).toBe(true);

    // Server 2 "shares" the same discovery path (e.g. a stale/duplicated env
    // var pointing two dev launches at the same file) and overwrites it with
    // its own {port,token} — simulated directly since spinning up a second
    // real listener on the SAME infoPath is exactly what would happen in the
    // wild once server 2 calls writeInfoFile.
    const server2Info = { pid: process.pid + 1, port: 65432, token: "2".repeat(64), startedAt: Date.now() };
    writeFileSync(infoPath, JSON.stringify(server2Info, null, 2), { mode: 0o600 });

    // Server 1 closes. Its OWN close() must see the file no longer describes
    // it (port/token mismatch) and leave server 2's file alone.
    await h1.close();
    handle = null;

    expect(existsSync(infoPath)).toBe(true);
    const survivor = JSON.parse(readFileSync(infoPath, "utf8"));
    expect(survivor).toEqual(server2Info);
  });

  it("close() DOES unlink the discovery file when it still describes this server", async () => {
    const infoPath = join(tmpdir(), `automation-test-owned-${randomUUID()}.json`);
    const h = await boot({ infoPath, token: "3".repeat(64) });
    expect(existsSync(infoPath)).toBe(true);
    await h.close();
    handle = null;
    expect(existsSync(infoPath)).toBe(false);
  });

  it("close() tolerates a missing/garbage discovery file (never throws)", async () => {
    const infoPath = join(tmpdir(), `automation-test-garbage-${randomUUID()}.json`);
    const h = await boot({ infoPath });
    writeFileSync(infoPath, "not json at all");
    await expect(h.close()).resolves.toBeUndefined();
    handle = null;
    // The garbage content is left untouched (not confidently "ours").
    expect(readFileSync(infoPath, "utf8")).toBe("not json at all");
  });
});

describe("ANYCODE_AUTOMATION_INFO trimming + absolute-path guard (codex finding P7.H-3)", () => {
  it("trims a leading/trailing-whitespace env value before using it", async () => {
    const target = join(tmpdir(), `automation-test-trim-${randomUUID()}.json`);
    const prior = process.env["ANYCODE_AUTOMATION_INFO"];
    process.env["ANYCODE_AUTOMATION_INFO"] = ` ${target} `;
    try {
      handle = await startAutomationServer({
        getWindow: () => fakeWindow(),
        manager: fakeManager(),
        app: { quit: vi.fn(), getVersion: () => "1.2.3", on: vi.fn() } as AutomationServerDeps["app"],
        token: TOKEN,
        port: 0,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(handle.infoPath).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      if (prior === undefined) {
        delete process.env["ANYCODE_AUTOMATION_INFO"];
      } else {
        process.env["ANYCODE_AUTOMATION_INFO"] = prior;
      }
    }
  });

  it("ignores a relative env value (falls back to the default path) and warns once", async () => {
    const prior = process.env["ANYCODE_AUTOMATION_INFO"];
    process.env["ANYCODE_AUTOMATION_INFO"] = " relative/path.json";
    const warn = vi.fn();
    try {
      handle = await startAutomationServer({
        getWindow: () => fakeWindow(),
        manager: fakeManager(),
        app: { quit: vi.fn(), getVersion: () => "1.2.3", on: vi.fn() } as AutomationServerDeps["app"],
        token: TOKEN,
        port: 0,
        logger: { log: vi.fn(), warn, error: vi.fn() },
      });
      expect(handle.infoPath).not.toBe("relative/path.json");
      expect(handle.infoPath.endsWith(join(".anycode", "automation.json"))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("ANYCODE_AUTOMATION_INFO");
    } finally {
      if (prior === undefined) {
        delete process.env["ANYCODE_AUTOMATION_INFO"];
      } else {
        process.env["ANYCODE_AUTOMATION_INFO"] = prior;
      }
    }
  });
});

describe("routing reaches the handler layer", () => {
  it("POST /tabs {kind:'new'} passes the workspace to manager.createTab and returns tabId/sessionId", async () => {
    const manager = fakeManager();
    const h = await boot({ manager });
    const res = await fetch(url(h, "/tabs"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ kind: "new", workspace: "/tmp/ws-2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, tabId: "tab-new", sessionId: expect.any(String), workspace: "/tmp/ws-2" });
    expect(manager.createTab).toHaveBeenCalledWith(expect.objectContaining({ workspace: "/tmp/ws-2", resume: false }));
    expect(manager.deliverTabPort).toHaveBeenCalledTimes(1);
  });

  it("503 facade_unavailable when there is no window (GET /state)", async () => {
    const h = await boot({ getWindow: () => null });
    const res = await fetch(url(h, "/state"), { headers: auth() });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("facade_unavailable");
  });

  it("GET /state returns the facade snapshot beside the main-plane tab list", async () => {
    const manager = fakeManager({
      listTabs: () => [{ tabId: "t1", workspace: "/a", sessionId: "s1", state: "running", pid: 4242 }],
    });
    const h = await boot({ manager });
    const res = await fetch(url(h, "/state"), { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.snapshot).toEqual({ tabs: [], activeTabId: null, states: {} });
    expect(body.tabs).toEqual([{ tabId: "t1", workspace: "/a", sessionId: "s1", state: "running", pid: 4242 }]);
  });
});

describe("git routes (slice-5.8-R8-cut.md §2.3)", () => {
  const GIT_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/tabs/tab-a/git", body: { command: { op: "refresh" } } },
    { path: "/tabs/tab-a/git/confirm", body: { intent: { op: "stash_pop" } } },
    { path: "/tabs/tab-a/git/confirm/accept", body: {} },
    { path: "/tabs/tab-a/git/confirm/cancel", body: {} },
    { path: "/tabs/tab-a/git/panel", body: { open: true } },
    { path: "/tabs/tab-a/git/view", body: { view: "history" } },
  ];

  it("401s every git route without a token", async () => {
    const h = await boot();
    for (const route of GIT_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  describe("zod fail-closed on git bodies (§6#5) — callFacade never reached", () => {
    it("discard without confirmed -> 400 (reuses the host's own gitCommandSchema)", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ command: { op: "discard", paths: ["a"] } }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("reset confirmed:false -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ command: { op: "reset", mode: "hard", confirmed: false } }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("git/confirm intent with an out-of-enum mode -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/confirm"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ intent: { op: "reset", mode: "soft" } }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("git/view with an unknown view -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/view"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ view: "pixels" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("git/panel with a non-boolean open -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/panel"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ open: "yes" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON on a git route -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git"), {
        method: "POST",
        headers: auth(),
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /tabs/:tabId/git -> gitCommand", async () => {
      const facadeResult = { ok: true, requestId: "req-1" };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ command: { op: "refresh" } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitCommand"');
      expect(calls[0]).toContain('["tab-a",{"op":"refresh"}]');
    });

    it("POST /tabs/:tabId/git/confirm -> gitStageConfirm", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/confirm"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ intent: { op: "discard", paths: ["a.txt"] } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitStageConfirm"');
      expect(calls[0]).toContain('["tab-a",{"op":"discard","paths":["a.txt"]}]');
    });

    it("POST /tabs/:tabId/git/confirm/accept -> gitConfirm", async () => {
      const facadeResult = { ok: true, requestId: "req-2" };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/confirm/accept"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitConfirm"');
      expect(calls[0]).toContain('["tab-a"]');
    });

    it("POST /tabs/:tabId/git/confirm/cancel -> gitCancelConfirm", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/confirm/cancel"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitCancelConfirm"');
      expect(calls[0]).toContain('["tab-a"]');
    });

    it("POST /tabs/:tabId/git/panel -> gitSetPanelOpen", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/panel"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ open: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitSetPanelOpen"');
      expect(calls[0]).toContain('["tab-a",true]');
    });

    it("POST /tabs/:tabId/git/view -> gitSetView", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/git/view"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ view: "history" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"gitSetView"');
      expect(calls[0]).toContain('["tab-a","history"]');
    });
  });

  it("destructive bypass probe: confirmed:true through /git parses but is refused BY THE FACADE (server doesn't special-case it)", async () => {

    // just forwards whatever the facade returns for a schema-valid body.
    const facadeResult = { ok: false, reason: "destructive_requires_confirm" };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/git"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ command: { op: "reset", mode: "hard", confirmed: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('"gitCommand"');
  });
});

describe("project routes (design/slice-GUI-P1-cut.md §2F.5)", () => {
  const PROJECT_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/projects/new", body: { workspace: "/tmp/proj-b" } },
    { path: "/projects/hide", body: { workspace: "/tmp/proj-b" } },
  ];

  it("401s every project route without a token", async () => {
    const h = await boot();
    for (const route of PROJECT_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  it("401 with a garbage Bearer token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/projects/new"), {
      method: "POST",
      headers: { Authorization: "Bearer garbage", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp/proj-b" }),
    });
    expect(res.status).toBe(401);
  });

  describe("zod fail-closed on /projects/* bodies (§6#5) — callFacade never reached", () => {
    const BAD_BODIES: ReadonlyArray<{ label: string; body: unknown }> = [
      { label: "empty object", body: {} },
      { label: "empty workspace string", body: { workspace: "" } },
      { label: "non-string workspace", body: { workspace: 123 } },
      { label: "4097-char workspace", body: { workspace: "x".repeat(4097) } },
    ];

    for (const route of PROJECT_ROUTES) {
      for (const bad of BAD_BODIES) {
        it(`${route.path} — ${bad.label} -> 400, facade never invoked`, async () => {
          const { window, calls } = fakeWindowCapture();
          const h = await boot({ getWindow: () => window });
          const res = await fetch(url(h, route.path), {
            method: "POST",
            headers: auth(),
            body: JSON.stringify(bad.body),
          });
          expect(res.status).toBe(400);
          expect(calls).toHaveLength(0);
        });
      }

      it(`${route.path} — junk JSON -> 400, facade never invoked`, async () => {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, route.path), {
          method: "POST",
          headers: auth(),
          body: "{not json",
        });
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
      });
    }
  });

  it("unknown action /projects/bogus -> 404", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/projects/bogus"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ workspace: "/tmp/proj-b" }),
    });
    expect(res.status).toBe(404);
  });

  it("unknown deeper path /projects/x/y -> 404", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/projects/x/y"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ workspace: "/tmp/proj-b" }),
    });
    expect(res.status).toBe(404);
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /projects/new -> projectNewSession", async () => {
      const facadeResult = { ok: true, tabId: "t-new", workspace: "/tmp/proj-b" };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/projects/new"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ workspace: "/tmp/proj-b" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"projectNewSession"');
      expect(calls[0]).toContain('["/tmp/proj-b"]');
    });

    it("POST /projects/hide -> projectHide", async () => {
      const facadeResult = { ok: false, reason: "project_has_open_tabs" };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/projects/hide"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ workspace: "/tmp/proj-b" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"projectHide"');
      expect(calls[0]).toContain('["/tmp/proj-b"]');
    });
  });
});

describe("transcript-scroll routes (design/slice-P7.3-cut.md §3.3)", () => {
  it("401s GET /transcript/scroll without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/transcript/scroll?tabId=tab-a"));
    expect(res.status).toBe(401);
  });

  it("401s POST /transcript/scroll without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/transcript/scroll"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: "tab-a", to: "top" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /transcript/scroll -> transcriptScrollState", async () => {
    const facadeResult = {
      ok: true,
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 400,
      atBottom: false,
      jumpVisible: true,
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/transcript/scroll?tabId=tab-a"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"transcriptScrollState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("GET /transcript/scroll without a tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/transcript/scroll"), { headers: auth() });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("GET /transcript/scroll with an empty tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/transcript/scroll?tabId="), { headers: auth() });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /transcript/scroll -> transcriptScrollTo", async () => {
    const facadeResult = { ok: true };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/transcript/scroll"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a", to: "bottom" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"transcriptScrollTo"');
    expect(calls[0]).toContain('["tab-a","bottom"]');
  });

  describe("zod fail-closed on POST /transcript/scroll bodies — callFacade never reached", () => {
    const BAD_BODIES: ReadonlyArray<{ label: string; body: unknown }> = [
      { label: "empty object", body: {} },
      { label: "missing tabId", body: { to: "top" } },
      { label: "empty tabId", body: { tabId: "", to: "top" } },
      { label: "junk to value", body: { tabId: "tab-a", to: "sideways" } },
      { label: "non-string to value", body: { tabId: "tab-a", to: 1 } },
    ];

    for (const bad of BAD_BODIES) {
      it(`${bad.label} -> 400`, async () => {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, "/transcript/scroll"), {
          method: "POST",
          headers: auth(),
          body: JSON.stringify(bad.body),
        });
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
      });
    }

    it("junk JSON -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/transcript/scroll"), {
        method: "POST",
        headers: auth(),
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("todo-panel route (design/slice-P7.11-cut.md §3 W2)", () => {
  it("401s GET /tabs/:tabId/todo-panel without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/todo-panel"));
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/todo-panel -> todoPanelState", async () => {
    const facadeResult = {
      ok: true,
      visible: true,
      header: "Progress 1/3",
      panelCollapsed: false,
      completedRow: null,
      items: [{ glyph: "active", content: "item two" }],
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/todo-panel"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"todoPanelState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("GET /tabs/:tabId/todo-panel decodes a URL-encoded tabId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true, visible: false });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, `/tabs/${encodeURIComponent("tab a")}/todo-panel`), { headers: auth() });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a"]');
  });
});

describe("agent-card route (design/slice-P7.18-cut.md §4 W4)", () => {
  it("401s GET /tabs/:tabId/agent-card/:toolCallId without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/agent-card/call-1"));
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/agent-card/:toolCallId -> agentCardState", async () => {
    const facadeResult = { ok: true, expanded: true, promptCollapsed: true, feedRowCount: 3, resultRendered: true };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/agent-card/call-1"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"agentCardState"');
    expect(calls[0]).toContain('["tab-a","call-1"]');
  });

  it("GET /tabs/:tabId/agent-card/:toolCallId decodes URL-encoded tabId AND toolCallId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true, expanded: false, promptCollapsed: true, feedRowCount: 0, resultRendered: false });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(
      url(h, `/tabs/${encodeURIComponent("tab a")}/agent-card/${encodeURIComponent("call 1")}`),
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a","call 1"]');
  });
});

describe("agent-card expand route (design/slice-P7.18-cut.md §4 W4)", () => {
  it("401s POST /tabs/:tabId/agent-card/:toolCallId/expand without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/agent-card/call-1/expand"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /tabs/:tabId/agent-card/:toolCallId/expand -> agentCardExpand", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/agent-card/call-1/expand"), { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]).toContain('"agentCardExpand"');
    expect(calls[0]).toContain('["tab-a","call-1"]');
  });

  it("POST /tabs/:tabId/agent-card/:toolCallId/expand decodes URL-encoded tabId AND toolCallId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(
      url(h, `/tabs/${encodeURIComponent("tab a")}/agent-card/${encodeURIComponent("call 1")}/expand`),
      { method: "POST", headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a","call 1"]');
  });
});

describe("try-again-button route (TASK.33 W8-FIX #2)", () => {
  it("401s GET /tabs/:tabId/try-again-button/:blockId without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/try-again-button/loop_end%3At1"));
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/try-again-button/:blockId -> tryAgainButtonState", async () => {
    const facadeResult = { ok: true, count: 1, visible: true, enabled: true };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/try-again-button/loop_end%3At1"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"tryAgainButtonState"');
    expect(calls[0]).toContain('["tab-a","loop_end:t1"]');
  });

  it("GET /tabs/:tabId/try-again-button/:blockId decodes URL-encoded tabId AND blockId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true, count: 0, visible: false, enabled: false });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(
      url(h, `/tabs/${encodeURIComponent("tab a")}/try-again-button/${encodeURIComponent("loop_end:t 1")}`),
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a","loop_end:t 1"]');
  });
});

describe("try-again-button click route (TASK.33 W8-FIX #2)", () => {
  it("401s POST /tabs/:tabId/try-again-button/:blockId/click without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/try-again-button/loop_end%3At1/click"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /tabs/:tabId/try-again-button/:blockId/click -> tryAgainButtonClick", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/try-again-button/loop_end%3At1/click"), {
      method: "POST",
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]).toContain('"tryAgainButtonClick"');
    expect(calls[0]).toContain('["tab-a","loop_end:t1"]');
  });

  it("POST /tabs/:tabId/try-again-button/:blockId/click decodes URL-encoded tabId AND blockId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(
      url(h, `/tabs/${encodeURIComponent("tab a")}/try-again-button/${encodeURIComponent("loop_end:t 1")}/click`),
      { method: "POST", headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a","loop_end:t 1"]');
  });
});

describe("start-screen routes (design/slice-P7.12-cut.md §5 W2)", () => {
  it("401s GET /start-screen without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/start-screen"));
    expect(res.status).toBe(401);
  });

  it("401s POST /start-screen/open without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/start-screen/open"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("GET /start-screen -> startScreenState", async () => {
    const facadeResult = {
      ok: true,
      active: true,
      rendered: true,
      workspace: null,
      prompt: "",
      model: null,
      sendEnabled: false,
      recentCount: 2,
      projectMenuOpen: false,
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"startScreenState"');
    expect(calls[0]).toContain("[]");
  });

  it("POST /start-screen/open with an empty body -> startScreenOpen with no args", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/open"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenOpen"');
    expect(calls[0]).toContain("[]");
  });

  it("POST /start-screen/open with a workspace -> startScreenOpen([workspace])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/open"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ workspace: "/tmp/ws-preset" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenOpen"');
    expect(calls[0]).toContain('["/tmp/ws-preset"]');
  });

  it("POST /start-screen/workspace -> startScreenSetWorkspace([workspace])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/workspace"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ workspace: "/tmp/ws-c" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenSetWorkspace"');
    expect(calls[0]).toContain('["/tmp/ws-c"]');
  });

  it("POST /start-screen/workspace with a missing workspace -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/workspace"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/prompt -> startScreenSetPrompt([text])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/prompt"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenSetPrompt"');
    expect(calls[0]).toContain('["hello"]');
  });

  it("POST /start-screen/prompt with a missing text -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/prompt"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/submit -> startScreenSubmit", async () => {
    const facadeResult = { ok: true, tabId: "new-tab" };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/submit"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"startScreenSubmit"');
    expect(calls[0]).toContain("[]");
  });

  it("POST /start-screen/model with a model id -> startScreenSetModel([model])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/model"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ model: "claude-opus-4" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenSetModel"');
    expect(calls[0]).toContain('["claude-opus-4"]');
  });

  it("POST /start-screen/model with null -> startScreenSetModel([null]) (clears back to provider default)", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/model"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ model: null }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenSetModel"');
    expect(calls[0]).toContain("[null]");
  });

  it("POST /start-screen/model with a missing model field -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/model"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/model with an unknown extra field -> 400 (strict body)", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/model"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ model: "claude-opus-4", extra: true }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/engine with an engine id -> startScreenSetEngine([engineId]) (codex-fixes TASK.42, cut §3.7)", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/engine"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ engineId: "codex" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenSetEngine"');
    expect(calls[0]).toContain('["codex"]');
  });

  it("POST /start-screen/engine with a missing engineId field -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/engine"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/engine with an unknown extra field -> 400 (strict body)", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/engine"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ engineId: "codex", extra: true }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /start-screen/project-menu with {open:true} -> startScreenToggleProjectMenu([true])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/project-menu"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ open: true }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenToggleProjectMenu"');
    expect(calls[0]).toContain("[true]");
  });

  it("POST /start-screen/project-menu with {open:false} -> startScreenToggleProjectMenu([false])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/project-menu"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ open: false }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"startScreenToggleProjectMenu"');
    expect(calls[0]).toContain("[false]");
  });

  it("POST /start-screen/project-menu with a non-boolean open -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/start-screen/project-menu"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ open: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("prompt-queue routes (design/slice-P7.14-cut.md §5 W3)", () => {
  it("401s POST /queue/prompt without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/queue/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: "tab-a", text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /queue/prompt -> queuePrompt([tabId, text])", async () => {
    const facadeResult = { ok: true, id: "prompt-1" };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/prompt"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a", text: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"queuePrompt"');
    expect(calls[0]).toContain('["tab-a","hello"]');
  });

  it("POST /queue/prompt with a missing tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/prompt"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /queue/edit -> queueEdit([tabId, id, text])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/edit"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a", id: "prompt-1", text: "edited" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"queueEdit"');
    expect(calls[0]).toContain('["tab-a","prompt-1","edited"]');
  });

  it("POST /queue/edit with a missing id -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/edit"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a", text: "edited" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /queue/delete -> queueDelete([tabId, id])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/delete"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a", id: "prompt-1" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"queueDelete"');
    expect(calls[0]).toContain('["tab-a","prompt-1"]');
  });

  it("POST /queue/delete with a missing id -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/delete"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /queue/resume -> queueResume([tabId])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/resume"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"queueResume"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("POST /queue/resume with a missing tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/resume"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /queue/clear -> queueClear([tabId])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/clear"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"queueClear"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("POST /queue/clear with a missing tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/queue/clear"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("LSP / Hooks panel routes (design/slice-P7.25-cut.md §3 W3)", () => {
  it("401s GET /panels/lsp without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/panels/lsp?tabId=tab-a"));
    expect(res.status).toBe(401);
  });

  it("401s GET /panels/hooks without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/panels/hooks?tabId=tab-a"));
    expect(res.status).toBe(401);
  });

  it("401s POST /panels/lsp/toggle without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/panels/lsp/toggle"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /panels/lsp -> lspPanelState", async () => {
    const facadeResult = { ok: true, open: true, counts: "1 ready", servers: [{ name: "fake", state: "ready" }] };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/lsp?tabId=tab-a"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"lspPanelState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("GET /panels/lsp without a tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/lsp"), { headers: auth() });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("GET /panels/lsp with an empty tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/lsp?tabId="), { headers: auth() });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("GET /panels/hooks -> hooksPanelState", async () => {
    const facadeResult = { ok: true, open: true, configError: null, groups: [{ event: "PostToolUse", count: 1 }] };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/hooks?tabId=tab-a"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"hooksPanelState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("GET /panels/hooks without a tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/hooks"), { headers: auth() });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /panels/lsp/toggle -> lspPanelToggle([tabId])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/lsp/toggle"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"lspPanelToggle"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("POST /panels/lsp/toggle with a missing tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/lsp/toggle"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST /panels/hooks/toggle -> hooksPanelToggle([tabId])", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/hooks/toggle"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ tabId: "tab-a" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"hooksPanelToggle"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("POST /panels/hooks/toggle with a missing tabId -> 400, facade never invoked", async () => {
    const { window, calls } = fakeWindowCapture();
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/panels/hooks/toggle"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("Checkpoint timeline / rewind routes (design slice-P7.26-R2-ratification.md §1 W3)", () => {
  it("401s GET /tabs/tab-a/checkpoints without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/checkpoints"));
    expect(res.status).toBe(401);
  });

  it("401s POST /tabs/tab-a/rewind without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkpointId: "cp-1", scope: "both" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/checkpoints -> checkpointPanelState", async () => {
    const facadeResult = { ok: true, visible: true, items: [{ label: "Write file A", age: "2m", reason: "Auto" }] };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/checkpoints"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"checkpointPanelState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("401s GET /tabs/tab-a/rewind without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/rewind"));
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/rewind -> rewindState", async () => {
    const facadeResult = { ok: true, lastResult: null, transcriptBlockCount: 4 };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/rewind"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"rewindState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("POST /tabs/:tabId/rewind with an explicit checkpointId -> checkpointRewind", async () => {
    const facadeResult = { ok: true, lastResult: { conversationRestored: true, restoredPaths: 1, safetyId: "safety-1" }, transcriptBlockCount: 2 };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ checkpointId: "cp-1", scope: "both" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"checkpointRewind"');
    expect(calls[0]).toContain('["tab-a",{"checkpointId":"cp-1","scope":"both"}]');
  });

  it("POST /tabs/:tabId/rewind with an index -> checkpointRewind forwards it unchanged", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true, lastResult: null, transcriptBlockCount: 0 });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ index: 0, scope: "files" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('"checkpointRewind"');
    expect(calls[0]).toContain('["tab-a",{"index":0,"scope":"files"}]');
  });

  describe("zod fail-closed on the rewind body — callFacade never reached", () => {
    it("missing scope -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "cp-1" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("out-of-enum scope -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "cp-1", scope: "everything" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("negative index -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ index: -1, scope: "both" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("an unknown extra field -> 400 (strict body)", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "cp-1", scope: "both", extra: true }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("a 129-char checkpointId -> 400 (W3-FIX codex #2: mirrors the wire rewindRequestSchema's .max(128) so an over-length id can never pass HTTP and hang the host's settle deadline)", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "x".repeat(129), scope: "both" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("a 128-char checkpointId is still accepted (boundary)", async () => {
      const { window, calls } = fakeWindowCapture({ ok: true, lastResult: null, transcriptBlockCount: 0 });
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "x".repeat(128), scope: "both" }),
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("both checkpointId and index given -> 400 (W3-FIX codex #3: exactly one selector, fail-closed rather than silently preferring checkpointId)", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ checkpointId: "cp-1", index: 0, scope: "both" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("neither checkpointId nor index given -> 400 (W3-FIX codex #3)", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ scope: "both" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/rewind"), {
        method: "POST",
        headers: auth(),
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("model-pill routes (design/slice-P7.15-cut.md §2.6 W4)", () => {
  it("401s GET /tabs/:tabId/model-pill without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/model-pill"));
    expect(res.status).toBe(401);
  });

  it("GET /tabs/:tabId/model-pill -> modelPillState", async () => {
    const facadeResult = {
      ok: true,
      present: true,
      label: "GLM-5.2 · High",
      menuOpen: false,
      page: "root",
      effortRowVisible: true,
      modelItems: [{ id: "glm-5.2", name: "GLM-5.2" }],
      effortItems: ["off", "high", "max"],
      currentModel: "glm-5.2",
      currentEffort: "high",
      modelPickDisabled: false,
      manageModelsDisabled: true,
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/model-pill"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"modelPillState"');
    expect(calls[0]).toContain('["tab-a"]');
  });

  it("GET /tabs/:tabId/model-pill decodes a URL-encoded tabId", async () => {
    const { window, calls } = fakeWindowCapture({ ok: true, present: false });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, `/tabs/${encodeURIComponent("tab a")}/model-pill`), { headers: auth() });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab a"]');
  });

  it("401s POST /tabs/:tabId/model-pill/pick without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "open" }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /tabs/:tabId/model-pill/pick {kind:"open"} -> modelPillPick(tabId, {kind:"open"})', async () => {
    const facadeResult = { ok: true };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ kind: "open" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"modelPillPick"');
    expect(calls[0]).toContain('["tab-a",{"kind":"open"}]');
  });

  it('POST /tabs/:tabId/model-pill/pick {kind:"model",value} -> modelPillPick(tabId, {kind:"model",value})', async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ kind: "model", value: "glm-4.6" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab-a",{"kind":"model","value":"glm-4.6"}]');
  });

  it('POST /tabs/:tabId/model-pill/pick {kind:"effort",value} -> modelPillPick(tabId, {kind:"effort",value})', async () => {
    const { window, calls } = fakeWindowCapture({ ok: true });
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ kind: "effort", value: "high" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('["tab-a",{"kind":"effort","value":"high"}]');
  });

  describe("zod fail-closed on POST /tabs/:tabId/model-pill/pick bodies — callFacade never reached", () => {
    const BAD_BODIES: ReadonlyArray<{ label: string; body: unknown }> = [
      { label: "empty object (no kind)", body: {} },
      { label: "unknown kind", body: { kind: "sideways" } },
      { label: "model kind missing value", body: { kind: "model" } },
      { label: "model kind empty value", body: { kind: "model", value: "" } },
      { label: "effort kind missing value", body: { kind: "effort" } },
      { label: "effort kind junk value", body: { kind: "effort", value: "extreme" } },
      { label: "open kind with an extra value field (strict)", body: { kind: "open", value: "glm-4.6" } },
    ];

    for (const bad of BAD_BODIES) {
      it(`${bad.label} -> 400`, async () => {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
          method: "POST",
          headers: auth(),
          body: JSON.stringify(bad.body),
        });
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
      });
    }

    it("junk JSON -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/tabs/tab-a/model-pill/pick"), {
        method: "POST",
        headers: auth(),
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("settings routes (design/slice-P7.16-cut.md §5 W4)", () => {
  const SETTINGS_POST_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/settings/open", body: {} },
    { path: "/settings/close", body: {} },
    { path: "/settings/pane", body: { paneId: "permissions" } },
    { path: "/settings/permissions/add", body: { toolName: "Bash", pattern: "node *" } },
    { path: "/settings/permissions/remove", body: { toolName: "Bash", pattern: "node *" } },
  ];

  it("401s GET /settings without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings"));
    expect(res.status).toBe(401);
  });

  it("401s every POST /settings/* route without a token", async () => {
    const h = await boot();
    for (const route of SETTINGS_POST_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  it("401 GET /settings with a garbage Bearer token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings"), { headers: { Authorization: "Bearer garbage" } });
    expect(res.status).toBe(401);
  });

  it("GET /settings -> settingsState", async () => {
    const facadeResult = {
      open: true,
      activePane: "permissions",
      panesVisible: ["provider", "permissions", "tools", "mcp", "environment", "appearance", "about"],
      searchQuery: "",
      permissions: { groups: [{ toolName: "Bash", rules: [{ pattern: "git *", display: "git *" }] }] },
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/settings"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"settingsState"');
    expect(calls[0]).toContain("[]");
  });

  it("unknown /settings/bogus -> 404", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings/bogus"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  describe("zod fail-closed on POST /settings/* bodies — callFacade never reached", () => {
    it("POST /settings/pane — empty object -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/pane"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/pane — empty paneId string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/pane"), { method: "POST", headers: auth(), body: JSON.stringify({ paneId: "" }) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/pane — non-string paneId -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/pane"), { method: "POST", headers: auth(), body: JSON.stringify({ paneId: 5 }) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/permissions/add — empty object (missing toolName) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/add"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/permissions/add — empty toolName string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/add"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ toolName: "" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/permissions/add — non-string pattern -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/add"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ toolName: "Bash", pattern: 42 }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/permissions/remove — empty object (missing toolName) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/remove"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON on every POST /settings/* route -> 400, facade never invoked", async () => {
      for (const route of SETTINGS_POST_ROUTES) {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, route.path), { method: "POST", headers: auth(), body: "{not json" });
        expect(res.status, `${route.path} should 400 on junk JSON`).toBe(400);
        expect(calls).toHaveLength(0);
      }
    });
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /settings/open -> settingsOpen", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/open"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"settingsOpen"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/close -> settingsClose", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/close"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"settingsClose"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/pane -> settingsSelectPane([paneId])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/pane"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ paneId: "permissions" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"settingsSelectPane"');
      expect(calls[0]).toContain('["permissions"]');
    });

    it("POST /settings/permissions/add with a pattern -> settingsPermissionAdd([{toolName, pattern}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/add"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ toolName: "Bash", pattern: 'OUT="/tmp/o" node *' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"settingsPermissionAdd"');
      expect(calls[0]).toContain('[{"toolName":"Bash","pattern":"OUT=\\"/tmp/o\\" node *"}]');
    });

    it("POST /settings/permissions/add with no pattern -> settingsPermissionAdd([{toolName}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/add"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ toolName: "WebFetch" }),
      });
      expect(res.status).toBe(200);
      expect(calls[0]).toContain('"settingsPermissionAdd"');
      expect(calls[0]).toContain('[{"toolName":"WebFetch"}]');
    });

    it("POST /settings/permissions/remove -> settingsPermissionRemove([{toolName, pattern}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/permissions/remove"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ toolName: "Bash", pattern: "node *" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"settingsPermissionRemove"');
      expect(calls[0]).toContain('[{"toolName":"Bash","pattern":"node *"}]');
    });
  });
});

describe("MCP pane routes (design/slice-P7.19-cut.md §4 W4)", () => {
  const MCP_POST_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/settings/mcp/toggle", body: { name: "my-server" } },
    { path: "/settings/mcp/import/open", body: {} },
    { path: "/settings/mcp/import/apply", body: { consent: false } },
  ];

  it("401s GET /settings/mcp without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings/mcp"));
    expect(res.status).toBe(401);
  });

  it("401s every POST /settings/mcp/* route without a token", async () => {
    const h = await boot();
    for (const route of MCP_POST_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  it("GET /settings/mcp -> mcpPaneState (dedicated route, distinct from GET /settings)", async () => {
    const facadeResult = {
      rows: [{ name: "srv-a", source: "project", enabled: true, dotKind: "completed", toolsBadge: "3 tools", commandLine: "node fixture.mjs" }],
      problems: 0,
      importOpen: false,
      importCandidates: [],
      consentChecked: false,
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/settings/mcp"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"mcpPaneState"');
    expect(calls[0]).toContain("[]");
  });

  describe("zod fail-closed on POST /settings/mcp/* bodies — callFacade never reached", () => {
    it("POST /settings/mcp/toggle — empty object (missing name) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/toggle"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/mcp/toggle — empty name string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/toggle"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "" }) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/mcp/import/apply — missing consent -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/import/apply"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/mcp/import/apply — non-array names -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ consent: true, names: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON on every POST /settings/mcp/* route -> 400, facade never invoked", async () => {
      for (const route of MCP_POST_ROUTES) {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, route.path), { method: "POST", headers: auth(), body: "{not json" });
        expect(res.status, `${route.path} should 400 on junk JSON`).toBe(400);
        expect(calls).toHaveLength(0);
      }
    });
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /settings/mcp/toggle -> mcpToggle([name])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/toggle"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "my-server" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"mcpToggle"');
      expect(calls[0]).toContain('["my-server"]');
    });

    it("POST /settings/mcp/import/open -> mcpImportOpen()", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/import/open"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"mcpImportOpen"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/mcp/import/apply -> mcpImportApply([{consent, names}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ consent: true, names: ["a", "b"] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"mcpImportApply"');
      expect(calls[0]).toContain('[{"consent":true,"names":["a","b"]}]');
    });

    it("POST /settings/mcp/import/apply with no names -> mcpImportApply([{consent}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/mcp/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ consent: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"mcpImportApply"');
      expect(calls[0]).toContain('[{"consent":false}]');
    });
  });
});

describe("Skills pane routes (design/slice-P7.20-cut.md §5 W4)", () => {
  const SKILLS_POST_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/settings/skills/toggle", body: { name: "alpha" } },
    { path: "/settings/skills/delete", body: { name: "alpha" } },
    { path: "/settings/skills/import/open", body: {} },
    { path: "/settings/skills/import/apply", body: { scope: "user" } },
  ];

  it("401s GET /settings/skills without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings/skills"));
    expect(res.status).toBe(401);
  });

  it("401s every POST /settings/skills/* route without a token", async () => {
    const h = await boot();
    for (const route of SKILLS_POST_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  it("GET /settings/skills -> skillsPaneState (dedicated route, distinct from GET /settings and GET /settings/mcp)", async () => {
    const facadeResult = {
      rows: [{ name: "alpha", sourceKind: "project", enabled: true, hasToggle: true }],
      problems: 1,
      importOpen: false,
      importCandidates: [],
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/settings/skills"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"skillsPaneState"');
    expect(calls[0]).toContain("[]");
  });

  describe("zod fail-closed on POST /settings/skills/* bodies — callFacade never reached", () => {
    it("POST /settings/skills/toggle — empty object (missing name) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/toggle"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/skills/toggle — empty name string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/toggle"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "" }) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/skills/delete — empty object (missing name) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/delete"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/skills/import/apply — missing scope -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/apply"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/skills/import/apply — invalid scope literal -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ scope: "plugin" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/skills/import/apply — non-array ids -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ scope: "user", ids: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON on every POST /settings/skills/* route -> 400, facade never invoked", async () => {
      for (const route of SKILLS_POST_ROUTES) {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, route.path), { method: "POST", headers: auth(), body: "{not json" });
        expect(res.status, `${route.path} should 400 on junk JSON`).toBe(400);
        expect(calls).toHaveLength(0);
      }
    });
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /settings/skills/toggle -> skillsToggle([name])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/toggle"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "alpha" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"skillsToggle"');
      expect(calls[0]).toContain('["alpha"]');
    });

    it("POST /settings/skills/delete -> skillsDelete([name])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/delete"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "alpha" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"skillsDelete"');
      expect(calls[0]).toContain('["alpha"]');
    });

    it("POST /settings/skills/import/open -> skillsImportOpen()", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/open"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"skillsImportOpen"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/skills/import/apply -> skillsImportApply([{scope, ids}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ scope: "project", ids: ["a", "b"] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"skillsImportApply"');
      expect(calls[0]).toContain('[{"scope":"project","ids":["a","b"]}]');
    });

    it("POST /settings/skills/import/apply with no ids -> skillsImportApply([{scope}])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/skills/import/apply"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ scope: "user" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"skillsImportApply"');
      expect(calls[0]).toContain('[{"scope":"user"}]');
    });
  });
});

describe("Subagents pane routes (design/slice-P7.21-cut.md §4 W4)", () => {
  const SUBAGENTS_POST_ROUTES: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: "/settings/subagents/editor/open", body: {} },
    { path: "/settings/subagents/editor/set", body: { name: "alpha" } },
    { path: "/settings/subagents/editor/preview", body: {} },
    { path: "/settings/subagents/editor/save", body: {} },
    { path: "/settings/subagents/delete", body: { name: "alpha" } },
  ];

  it("401s GET /settings/subagents without a token", async () => {
    const h = await boot();
    const res = await fetch(url(h, "/settings/subagents"));
    expect(res.status).toBe(401);
  });

  it("401s every POST /settings/subagents/* route without a token", async () => {
    const h = await boot();
    for (const route of SUBAGENTS_POST_ROUTES) {
      const res = await fetch(url(h, route.path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `${route.path} should 401 without a token`).toBe(401);
    }
  });

  it("GET /settings/subagents -> subagentsPaneState (dedicated route, distinct from GET /settings, /settings/mcp, /settings/skills)", async () => {
    const facadeResult = {
      rows: [{ name: "alpha", sourceKind: "project", toolsBadge: "3 tools", description: "desc", editable: true }],
      problems: 1,
      editor: {
        open: false,
        mode: null,
        tab: null,
        name: "",
        description: "",
        tools: [],
        body: "",
        canSave: false,
        error: null,
        issues: [],
        previewLoading: false,
        previewSystemPrompt: null,
        previewEffectiveTools: null,
      },
    };
    const { window, calls } = fakeWindowCapture(facadeResult);
    const h = await boot({ getWindow: () => window });
    const res = await fetch(url(h, "/settings/subagents"), { headers: auth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(facadeResult);
    expect(calls[0]).toContain('"subagentsPaneState"');
    expect(calls[0]).toContain("[]");
  });

  describe("zod fail-closed on POST /settings/subagents/* bodies — callFacade never reached", () => {
    it("POST /settings/subagents/editor/open — non-string name -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/open"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: 5 }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/subagents/editor/open — empty name string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/open"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/subagents/editor/set — non-array tools -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/set"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ tools: "Read" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/subagents/delete — empty object (missing name) -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/delete"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("POST /settings/subagents/delete — empty name string -> 400", async () => {
      const { window, calls } = fakeWindowCapture();
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/delete"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "" }),
      });
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("junk JSON on every POST /settings/subagents/* route -> 400, facade never invoked", async () => {
      for (const route of SUBAGENTS_POST_ROUTES) {
        const { window, calls } = fakeWindowCapture();
        const h = await boot({ getWindow: () => window });
        const res = await fetch(url(h, route.path), { method: "POST", headers: auth(), body: "{not json" });
        expect(res.status, `${route.path} should 400 on junk JSON`).toBe(400);
        expect(calls).toHaveLength(0);
      }
    });
  });

  describe("happy path — each route forwards to its facade method and returns the facade result", () => {
    it("POST /settings/subagents/editor/open with no name -> subagentsOpenEditor([])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/open"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsOpenEditor"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/subagents/editor/open with a name -> subagentsOpenEditor([name])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/open"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "researcher" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsOpenEditor"');
      expect(calls[0]).toContain('["researcher"]');
    });

    it("POST /settings/subagents/editor/set -> subagentsEditorSet([args])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/set"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "summarizer", description: "Summarizes code.", tools: ["Read", "Grep"], body: "prompt body" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsEditorSet"');
      expect(calls[0]).toContain('[{"name":"summarizer","description":"Summarizes code.","tools":["Read","Grep"],"body":"prompt body"}]');
    });

    it("POST /settings/subagents/editor/preview -> subagentsEditorPreview()", async () => {
      const facadeResult = { ok: true, systemPrompt: "You are...", effectiveTools: ["Read"] };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/preview"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsEditorPreview"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/subagents/editor/save -> subagentsEditorSave()", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/editor/save"), { method: "POST", headers: auth(), body: JSON.stringify({}) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsEditorSave"');
      expect(calls[0]).toContain("[]");
    });

    it("POST /settings/subagents/delete -> subagentsDelete([name])", async () => {
      const facadeResult = { ok: true };
      const { window, calls } = fakeWindowCapture(facadeResult);
      const h = await boot({ getWindow: () => window });
      const res = await fetch(url(h, "/settings/subagents/delete"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "summarizer" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(facadeResult);
      expect(calls[0]).toContain('"subagentsDelete"');
      expect(calls[0]).toContain('["summarizer"]');
    });
  });
});
