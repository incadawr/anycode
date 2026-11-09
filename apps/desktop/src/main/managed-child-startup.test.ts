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
import { CHILD_READY_TYPE, CHILD_RUN_CANCEL_TYPE, CHILD_RUN_EVENT_TYPE, CHILD_SPAWN_REQUEST_TYPE, CHILD_START_TYPE, CHILD_TERMINAL_TYPE, type ChildRunEvent, type ChildSpawnRequest } from "../shared/child-sessions.js";
import { ENV_ENGINE } from "../shared/engines.js";
import { WORKTREE_TRANSITION_MESSAGE_TYPE } from "../shared/worktrees.js";
import { ChildWorktreeResources } from "./child-worktree-resource.js";
import { TabHostManager, type HostForkFn, type TabHostManagerDeps, type WindowLike } from "./tabs.js";

vi.setConfig({ testTimeout: 30_000 });

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

function waitCi<T>(check: () => T): Promise<T> { return vi.waitFor(check, { timeout: 20_000, interval: 25 }); }
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
    await waitCi(() => expect(events(r.parent).some(e => e.kind === "accepted" || e.kind === "rejected")).toBe(true));
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
      const accepted = await waitCi(() => { const e = events(r.parent).find(x => x.kind === "accepted"); expect(e).toBeDefined(); return e!; });
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
      await waitCi(() => expect(r.manager.listChildRuns()).toHaveLength(0));
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

  describe("startup transition", () => {
    const elsewhere = () => { const dir = join(scratch, "elsewhere"); mkdirSync(dir, { recursive: true }); return dir; };
    const transition = (sessionId: string, from: string, to: string, projectRoot = to) =>
      ({ type: WORKTREE_TRANSITION_MESSAGE_TYPE, sessionId, fromWorkspace: from, toWorkspace: to, projectRoot });
    const childForks = (r: ReturnType<typeof rig>) => r.calls.filter(c => c.args.includes("--child-parent"));
    const terminals = (r: ReturnType<typeof rig>) => events(r.parent).filter(e => e.kind === "terminal");
    const startsTo = (host: FakeHost) => host.postMessage.mock.calls.filter(c => (c[0] as { type?: unknown }).type === CHILD_START_TYPE);

    /** The host posts the transition and then dies, as the real boot does when the stored workspace disagrees. */
    async function mismatch(r: ReturnType<typeof rig>, spawned: Awaited<ReturnType<typeof spawnManaged>>, to = spawned.receipt.path, from = elsewhere()) {
      spawned.host.emit("message", transition(spawned.tab.sessionId, from, to));
      spawned.host.emit("message", { type: CHILD_TERMINAL_TYPE, status: "error", finalText: "boot failure", truncated: false, turns: 0, toolCalls: 0, durationMs: 0 });
      spawned.host.emit("message", { type: CHILD_TERMINAL_TYPE });
      spawned.host.emit("exit", 1);
      await flush();
    }

    it("recovers once: one replacement resumes in the checkout, one prompt, one terminal, pin released once", async () => {
      const release = vi.fn();
      const r = rig({ prepareChildConnection: async () => ({ ok: true, release }), resolveChildConnection: id => id });
      const spawned = await spawnManaged(r, spawnRequest({ connectionId: "conn-b" }));
      await mismatch(r, spawned);
      await waitCi(() => expect(childForks(r)).toHaveLength(2));
      const replacement = childForks(r)[1]!;
      expect(replacement.cwd).toBe(spawned.receipt.path);
      expect(replacement.args).toEqual(expect.arrayContaining(["--resume", spawned.tab.sessionId, "--child-parent", "parent"]));
      expect(replacement.args).not.toContain("--session");
      expect(replacement.env.ANYCODE_MANAGED_CHILD_WORKTREE).toBe("1");
      expect(spawned.tab.proc).toBe(replacement.host);
      expect(spawned.tab.workspace).toBe(spawned.receipt.path);
      expect(runState(r, spawned.req)).toBe("starting");
      expect(terminals(r)).toHaveLength(0);
      expect(startsTo(spawned.host)).toHaveLength(0);
      expect(startsTo(replacement.host)).toHaveLength(0);
      // A late ready from the replaced host is ignored; only the replacement releases the prompt.
      spawned.host.emit("message", { type: CHILD_READY_TYPE });
      expect(runState(r, spawned.req)).toBe("starting");
      replacement.host.emit("message", { type: CHILD_READY_TYPE });
      replacement.host.emit("message", { type: CHILD_READY_TYPE });
      expect(startsTo(replacement.host)).toHaveLength(1);
      expect(startsTo(spawned.host)).toHaveLength(0);
      expect(runState(r, spawned.req)).toBe("running");
      expect(r.manager.listChildRuns()).toHaveLength(1);
      replacement.host.emit("message", { type: CHILD_TERMINAL_TYPE, status: "completed", finalText: "done", truncated: false, turns: 1, toolCalls: 0, durationMs: 5 });
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      replacement.host.emit("exit", 0);
      await waitCi(() => expect(r.manager.listChildRuns()).toHaveLength(0));
      expect(terminals(r)).toHaveLength(1);
      expect(release).toHaveBeenCalledOnce();
      expect(childForks(r)).toHaveLength(2);
    });

    it("fails a repeated mismatch with a reason, without another fork, and retains the checkout", async () => {
      const r = rig();
      const spawned = await spawnManaged(r);
      await mismatch(r, spawned);
      await waitCi(() => expect(childForks(r)).toHaveLength(2));
      const replacement = childForks(r)[1]!;
      replacement.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      replacement.host.emit("exit", 0);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      const terminal = terminals(r)[0]!;
      expect(terminal).toMatchObject({ status: "error", finalText: expect.stringContaining(spawned.receipt.path) });
      expect(terminal.kind === "terminal" && terminal.finalText).toContain("already used");
      await flush();
      expect(childForks(r)).toHaveLength(2);
      expect(r.manager.listChildRuns()).toHaveLength(0);
      expect(["retained", "unknown"]).toContain(spawned.receipt.phase);
      expect(git(repo, "rev-parse", "--verify", spawned.receipt.branch)).toHaveLength(40);
    });

    it.each([
      ["another existing directory", (receiptPath: string, other: string) => other],
      ["a missing directory", (receiptPath: string) => `${receiptPath}-missing`],
      ["a parent of the checkout", (receiptPath: string) => join(receiptPath, "..")],
    ])("refuses %s as a target without relocating", async (_name, pick) => {
      const r = rig();
      const spawned = await spawnManaged(r);
      const other = elsewhere();
      await mismatch(r, spawned, pick(spawned.receipt.path, other), other);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      expect(childForks(r)).toHaveLength(1);
      expect(spawned.tab.workspace).toBe(spawned.receipt.path);
      expect(terminals(r)[0]).toMatchObject({ status: "error" });
      expect(r.manager.listChildRuns()).toHaveLength(0);
    });

    it("refuses a project root that is neither the checkout nor the project", async () => {
      const r = rig();
      const spawned = await spawnManaged(r);
      const other = elsewhere();
      spawned.host.emit("message", transition(spawned.tab.sessionId, other, spawned.receipt.path, other));
      spawned.host.emit("exit", 1);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      expect(childForks(r)).toHaveLength(1);
    });

    it("refuses a transition naming another session", async () => {
      const r = rig();
      const spawned = await spawnManaged(r);
      spawned.host.emit("message", transition("someone-else", elsewhere(), spawned.receipt.path));
      spawned.host.emit("exit", 1);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      expect(childForks(r)).toHaveLength(1);
    });

    it("does not recover once the run has started", async () => {
      const r = rig();
      const spawned = await spawnManaged(r);
      spawned.host.emit("message", { type: CHILD_READY_TYPE });
      expect(runState(r, spawned.req)).toBe("running");
      spawned.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      await flush();
      expect(childForks(r)).toHaveLength(1);
      expect(spawned.tab.proc).toBe(spawned.host);
      expect(runState(r, spawned.req)).toBe("running");
      expect(terminals(r)).toHaveLength(0);
    });

    it("cancels safely while the old host is still shutting down", async () => {
      const r = rig({}, { respondToShutdown: false });
      const spawned = await spawnManaged(r);
      spawned.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      await flush();
      expect(runState(r, spawned.req)).toBe("starting");
      r.parent.emit("message", { type: CHILD_RUN_CANCEL_TYPE, requestId: spawned.req.requestId });
      await flush();
      spawned.host.emit("exit", 1);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      await flush();
      expect(terminals(r)[0]).toMatchObject({ status: "cancelled" });
      expect(childForks(r)).toHaveLength(1);
      expect(r.manager.listChildRuns()).toHaveLength(0);
    });

    it("does not fork when the start deadline fires during shutdown", async () => {
      const r = rig({}, { respondToShutdown: false });
      const spawned = await spawnManaged(r);
      spawned.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      (r.manager as unknown as { handleChildStartTimeout(id: string): void }).handleChildStartTimeout(spawned.req.requestId);
      spawned.host.emit("exit", 0);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      expect(childForks(r)).toHaveLength(1);
      expect(r.manager.listChildRuns()).toHaveLength(0);
    });

    it("cancels safely when the parent closes while the old host is shutting down", async () => {
      const r = rig({}, { respondToShutdown: false });
      expect(r.manager.createTab({ workspace: repo, projectRoot: repo, sessionId: "second-root", resume: false }).ok).toBe(true);
      const spawned = await spawnManaged(r);
      spawned.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      await flush();
      const closing = r.manager.closeTab(r.tab.tabId);
      await flush();
      spawned.host.emit("exit", 1);
      r.parent.emit("exit", 0);
      await closing;
      await waitCi(() => expect(r.manager.listChildRuns()).toHaveLength(0));
      expect(childForks(r)).toHaveLength(1);
      expect(startsTo(spawned.host)).toHaveLength(0);
    });

    it("never relocates a managed child that is not starting or has no receipt", async () => {
      const r = rig();
      const spawned = await spawnManaged(r);
      spawned.tab.childWorktree = undefined;
      spawned.host.emit("message", transition(spawned.tab.sessionId, elsewhere(), spawned.receipt.path));
      await flush();
      expect(childForks(r)).toHaveLength(1);
      expect(spawned.tab.workspace).toBe(spawned.receipt.path);
    });

    it("an ordinary child whose stored workspace changed is not relocated and fails without a second fork", async () => {
      const other = elsewhere();
      const r = rig();
      delete r.tab.childWorktreePolicy;
      r.parent.emit("message", spawnRequest());
      await waitCi(() => expect(childForks(r)).toHaveLength(1));
      const call = childForks(r)[0]!;
      const tab = [...r.manager.listTabs()].map(t => r.manager.getTab(t.tabId)!).find(t => t.childOf)!;
      expect(call.cwd).toBe(tab.workspace);
      call.host.emit("message", transition(tab.sessionId, tab.workspace, other, other));
      call.host.emit("exit", 1);
      await waitCi(() => expect(terminals(r)).toHaveLength(1));
      expect(childForks(r)).toHaveLength(1);
      expect(terminals(r)[0]).toMatchObject({ status: "error" });
      expect(r.manager.listChildRuns()).toHaveLength(0);
    });
  });
});
