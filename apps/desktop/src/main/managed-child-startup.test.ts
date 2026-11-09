import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqlitePersistenceAdapter } from "@anycode/core";
import type { MessagePortMain, UtilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHostArgs, resolveBootSession } from "../host/boot.js";
import { CHILD_READY_TYPE, CHILD_RUN_EVENT_TYPE, CHILD_SPAWN_REQUEST_TYPE, CHILD_START_TYPE, CHILD_TERMINAL_TYPE, type ChildRunEvent, type ChildSpawnRequest } from "../shared/child-sessions.js";
import { ENV_ENGINE } from "../shared/engines.js";
import { WORKTREE_TRANSITION_MESSAGE_TYPE } from "../shared/worktrees.js";
import { ChildWorktreeResources } from "./child-worktree-resource.js";
import { TabHostManager, type HostForkFn, type TabHostManagerDeps, type WindowLike } from "./tabs.js";

class FakeHost extends EventEmitter {
  static seq = 9000;
  readonly pid = ++FakeHost.seq;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

interface ForkCall { args: string[]; cwd: string | undefined; env: Record<string, string | undefined>; host: FakeHost }

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test",
} }).trim();

async function flush(): Promise<void> { await new Promise(r => setTimeout(r, 25)); }
const deferred = <T,>() => { let resolveFn!: (v: T) => void; const promise = new Promise<T>(r => { resolveFn = r; }); return { promise, resolve: resolveFn }; };

let seq = 0;
function spawnRequest(overrides: Partial<ChildSpawnRequest> = {}): ChildSpawnRequest {
  seq += 1;
  return { type: CHILD_SPAWN_REQUEST_TYPE, requestId: `req-${seq}`, spawnToolCallId: `call-${seq}`, agentType: "general-purpose",
    description: "child", prompt: "do something", permissionMode: "build", ...overrides };
}

function events(host: FakeHost): ChildRunEvent[] {
  return host.postMessage.mock.calls.map(c => c[0] as { type?: unknown }).filter((m): m is ChildRunEvent => m.type === CHILD_RUN_EVENT_TYPE);
}

/** What the real host does at boot: its cwd is the forked cwd, and the row is created or loaded by session id. */
async function hostBoot(persistence: SqlitePersistenceAdapter, call: ForkCall) {
  const args = parseHostArgs(call.args);
  const hostCwd = realpathSync(call.cwd!);
  const boot = await resolveBootSession(persistence, { args, workspace: hostCwd, model: "m" });
  const canonical = async (value: string) => { try { return await realpath(value); } catch { return resolve(value); } };
  return {
    persisted: boot.sessionMeta.workspace,
    requiresRehost: await canonical(boot.sessionMeta.workspace) !== await canonical(hostCwd),
  };
}

describe("managed child startup", () => {
  let scratch: string;
  let repo: string;
  let persistence: SqlitePersistenceAdapter;
  const managers: TabHostManager[] = [];

  beforeEach(() => {
    // A symlinked spelling of the repository root is the realistic platform case (/var -> /private/var).
    const real = mkdtempSync(join(tmpdir(), "managed-startup-"));
    scratch = join(real, "link");
    symlinkSync(real, scratch);
    repo = join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "commit", "--allow-empty", "-m", "Initial");
    persistence = new SqlitePersistenceAdapter(":memory:");
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdownAllTabHosts().catch(() => {});
    await persistence.close();
    vi.useRealTimers();
    rmSync(realpathSync(scratch), { recursive: true, force: true });
  });

  function rig(overrides: Partial<TabHostManagerDeps> = {}, opts: { respondToShutdown?: boolean } = {}) {
    const calls: ForkCall[] = [];
    const fork: HostForkFn = (_entry, args, forkOpts) => {
      const host = new FakeHost();
      calls.push({ args: [...args], cwd: forkOpts.cwd, env: { ...(forkOpts.env as Record<string, string | undefined>) }, host });
      queueMicrotask(() => host.emit("spawn"));
      if (opts.respondToShutdown !== false) {
        host.postMessage.mockImplementation((msg: unknown) => {
          if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
        });
      }
      return host as unknown as UtilityProcess;
    };
    const window: WindowLike = { isDestroyed: () => false, webContents: { postMessage: () => {}, send: () => {} } };
    const resources = new ChildWorktreeResources({ userData: join(scratch, "data"), appRunId: "run" });
    const manager = new TabHostManager({
      fork, hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as unknown as MessagePortMain, port2: {} as unknown as MessagePortMain }),
      getWindow: () => window, env: () => ({ PATH: "/base" }), engineEnv: engine => ({ [ENV_ENGINE]: engine }),
      logger: { log() {}, warn() {}, error() {} }, limits: {}, childWorktrees: resources, engineReady: () => true,
      ...overrides,
    });
    managers.push(manager);
    const root = manager.createTab({ workspace: repo, projectRoot: repo, sessionId: "parent", resume: false });
    if (!root.ok) throw new Error("fixture root refused");
    root.tab.childWorktreePolicy = true;
    return { manager, tab: root.tab, parent: calls[0]!.host, calls, resources };
  }

  /** Spawns one managed child and returns its tab, fork call and run state. */
  async function spawnManaged(r: ReturnType<typeof rig>, req = spawnRequest()) {
    r.parent.emit("message", req);
    await vi.waitFor(() => expect(events(r.parent).some(e => e.kind === "accepted" || e.kind === "rejected")).toBe(true));
    const accepted = events(r.parent).find(e => e.kind === "accepted");
    if (accepted?.kind !== "accepted") throw new Error(`child not accepted: ${JSON.stringify(events(r.parent))}`);
    const tab = r.manager.getTab(accepted.childTabId)!;
    const call = r.calls.find(c => c.host === (tab.proc as unknown as FakeHost))!;
    return { tab, call, req, host: call.host, receipt: tab.childWorktree! };
  }
  const runState = (r: ReturnType<typeof rig>, req: ChildSpawnRequest) => r.manager.listChildRuns().find(run => run.requestId === req.requestId)?.state ?? "gone";

  describe("fork tuple", () => {
    it("fresh managed child forks and boots in the allocated checkout", async () => {
      const r = rig();
      const { tab, call, receipt, req } = await spawnManaged(r);
      const boot = await hostBoot(persistence, call);
      const tuple = { receiptPath: receipt.path, tabWorkspace: tab.workspace, persisted: boot.persisted, cwd: call.cwd, runState: runState(r, req) };
      expect(tuple).toEqual({ receiptPath: receipt.path, tabWorkspace: receipt.path, persisted: realpathSync(receipt.path), cwd: receipt.path, runState: "starting" });
      expect(boot.requiresRehost).toBe(false);
      expect(call.args).toEqual(expect.arrayContaining(["--session", tab.sessionId, "--child-parent", "parent"]));
      expect(call.args).not.toContain("--resume");
      expect(call.env.ANYCODE_MANAGED_CHILD_WORKTREE).toBe("1");
      expect(r.calls.filter(c => c.args.includes(tab.sessionId))).toHaveLength(1);
    });

    it("keeps the allocated cwd when allocation is slow and the connection is prepared late", async () => {
      const gate = deferred<void>();
      const prepared = deferred<{ ok: true; release: () => void }>();
      const release = vi.fn();
      const r = rig({
        prepareChildConnection: () => prepared.promise,
        resolveChildConnection: id => id,
      });
      const allocate = r.resources.allocate.bind(r.resources);
      vi.spyOn(r.resources, "allocate").mockImplementation(async (...a) => { await gate.promise; return allocate(...a); });
      const req = spawnRequest({ connectionId: "conn-b" });
      r.parent.emit("message", req);
      await flush();
      expect(r.calls).toHaveLength(1);
      expect(runState(r, req)).toBe("starting");
      gate.resolve();
      await flush();
      expect(r.calls).toHaveLength(1);
      prepared.resolve({ ok: true, release });
      const accepted = await vi.waitFor(() => { const e = events(r.parent).find(x => x.kind === "accepted"); expect(e).toBeDefined(); return e!; });
      if (accepted.kind !== "accepted") throw new Error("unreachable");
      const tab = r.manager.getTab(accepted.childTabId)!;
      const call = r.calls[1]!;
      expect(call.cwd).toBe(tab.childWorktree!.path);
      expect(tab.workspace).toBe(tab.childWorktree!.path);
      expect((await hostBoot(persistence, call)).requiresRehost).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    });

    it("never forks a child when the parent closes during allocation", async () => {
      const gate = deferred<void>();
      const r = rig();
      const allocate = r.resources.allocate.bind(r.resources);
      vi.spyOn(r.resources, "allocate").mockImplementation(async (...a) => { await gate.promise; return allocate(...a); });
      expect(r.manager.createTab({ workspace: repo, projectRoot: repo, sessionId: "second-root", resume: false }).ok).toBe(true);
      const req = spawnRequest();
      r.parent.emit("message", req);
      await flush();
      const closing = r.manager.closeTab(r.tab.tabId);
      gate.resolve();
      expect(await closing).toEqual({ ok: true });
      await flush();
      expect(r.calls.filter(c => c.args.includes("--child-parent"))).toHaveLength(0);
      await vi.waitFor(() => expect(r.manager.listChildRuns()).toHaveLength(0), { timeout: 5000 });
    });

    it("forks a resumed ordinary child at its own workspace and reports a stored workspace that moved", async () => {
      const other = join(scratch, "elsewhere");
      mkdirSync(other);
      const r = rig();
      const resumed = r.manager.createTab({ workspace: repo, projectRoot: repo, sessionId: "ordinary-child", resume: true });
      if (!resumed.ok) throw new Error("fixture resume refused");
      const call = r.calls.at(-1)!;
      expect(call.args).toEqual(expect.arrayContaining(["--resume", "ordinary-child"]));
      await persistence.createSession({ id: "ordinary-child", workspace: other, model: "m", mode: "build" });
      const boot = await hostBoot(persistence, call);
      expect({ tabWorkspace: resumed.tab.workspace, persisted: boot.persisted, cwd: call.cwd })
        .toEqual({ tabWorkspace: realpathSync(repo), persisted: other, cwd: realpathSync(repo) });
      expect(boot.requiresRehost).toBe(true);
    });
  });
});
