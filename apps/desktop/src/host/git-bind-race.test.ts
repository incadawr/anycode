/**
 * git bind-time delivery regression (slice 5.7-hostfix, design
 * slice-5.7-hostfix-cut.md §4.1): the per-connect `git_status` snapshot must be
 * delivered to a freshly-mounted renderer, reliably.
 *
 * The shared harness (`test-harness.ts`) wires the UI-side listener over a
 * worker_threads MessageChannel that QUEUES pre-listener messages — an always-
 * ready renderer that structurally cannot lose a bind-time post. This suite
 * models the empirically-lossy Electron port handoff with a `lossyRenderer()`
 * whose `WirePort.post` DROPS everything until `mount()` — the timing the old
 * harness elided. Test A is the reproducer: RED on the pre-fix tree (the
 * bind-time snapshot is dropped and nothing re-fires after `ui_ready`), GREEN
 * once the snapshot is triggered from the `ui_ready` route handler instead.
 */

import { describe, expect, it } from "vitest";
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitHead,
  GitOpResult,
  GitPort,
  GitStatusSummary,
} from "@anycode/core";
import type { HostToUiMessage, WirePort } from "../shared/protocol.js";
import { GitBridge } from "./git-bridge.js";
import { createHarness } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isGitStatus = (m: HostToUiMessage): m is Of<"git_status"> => m.type === "git_status";

function head(): GitHead {
  return { branch: "main", detached: false, sha: "abc123", ahead: null, behind: null };
}
function cleanSummary(): GitStatusSummary {
  return { head: head(), staged: [], unstaged: [], untracked: [] };
}

/** Minimal GitPort (8 mandatory methods) recording every status() spawn. */
class RecordingGitPort implements GitPort {
  statusCalls = 0;
  async status(): Promise<GitOpResult<GitStatusSummary>> {
    this.statusCalls += 1;
    return { ok: true, value: cleanSummary() };
  }
  async listBranches(): Promise<GitOpResult<GitBranchInfo[]>> {
    return { ok: true, value: [] };
  }
  async log(): Promise<GitOpResult<GitCommitInfo[]>> {
    return { ok: true, value: [] };
  }
  async diff(): Promise<GitOpResult<string>> {
    return { ok: true, value: "" };
  }
  async switchBranch(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async createBranch(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async stageAll(): Promise<GitOpResult<null>> {
    return { ok: true, value: null };
  }
  async commit(): Promise<GitOpResult<{ sha: string }>> {
    return { ok: true, value: { sha: "x" } };
  }
}

/** A GitPort whose status() fails transiently (index.lock race); other ops no-op. */
class FailingGitPort extends RecordingGitPort {
  override async status(): Promise<GitOpResult<GitStatusSummary>> {
    this.statusCalls += 1;
    return { ok: false, reason: "index.lock" };
  }
}

/**
 * A GitPort whose status() stays PENDING until `resolveAll()` — lets a test hold
 * a snapshot in flight across a port rebind (the renderer-reload race, §5#2).
 */
class GatedGitPort extends RecordingGitPort {
  private resolvers: Array<(r: GitOpResult<GitStatusSummary>) => void> = [];
  override status(): Promise<GitOpResult<GitStatusSummary>> {
    this.statusCalls += 1;
    return new Promise<GitOpResult<GitStatusSummary>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
  get pending(): number {
    return this.resolvers.length;
  }
  resolveAll(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) {
      r({ ok: true, value: cleanSummary() });
    }
  }
}

/**
 * Models the lossy Electron port handoff: `post` DROPS every message until
 * `mount()` is called, then delivers. `send()` feeds an inbound message to the
 * host-registered listener (the renderer emitting `ui_ready`).
 */
function lossyRenderer(): {
  wire: WirePort;
  delivered: HostToUiMessage[];
  dropped: HostToUiMessage[];
  mount: () => void;
  send: (m: unknown) => void;
} {
  const delivered: HostToUiMessage[] = [];
  const dropped: HostToUiMessage[] = [];
  let mounted = false;
  let inbound: ((m: unknown) => void) | null = null;
  const wire: WirePort = {
    post(m: unknown): void {
      (mounted ? delivered : dropped).push(m as HostToUiMessage);
    },
    onMessage(cb: (m: unknown) => void): void {
      inbound = cb;
    },
    onClose(): void {
      // no-op: nothing to tear down in this model.
    },
  };
  return {
    wire,
    delivered,
    dropped,
    mount: () => {
      mounted = true;
    },
    send: (m: unknown) => inbound?.(m),
  };
}

/** Poll helper: the harness's waitFor/waitUntil listen on their OWN channel, unusable after a rebind. */
async function until(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("until: timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("git bind-time delivery — lossy renderer handoff (slice 5.7-hostfix §4.1)", () => {
  it("A — a bind-time snapshot is lost, but ui_ready re-delivers a fresh git_status post-mount", async () => {
    const port = new RecordingGitPort();
    let bridgeRef!: GitBridge;
    const h = createHarness({
      steps: [],
      git: (outbound) => {
        bridgeRef = new GitBridge({ git: port, outbound });
        return bridgeRef;
      },
    });
    const r = lossyRenderer();
    try {
      // 1) Physical bind while the renderer is NOT mounted (production ordering).
      h.session.bindPort(r.wire);

      // 2) Fire the PRE-FIX bind-time trigger as the adversarial stray, and prove
      //    the loss window is real: the snapshot fully resolves and is DROPPED
      //    before mount (deterministic — no lucky late-resolve delivery).
      bridgeRef.pushSnapshot();
      await until(() => r.dropped.some(isGitStatus));

      // 3) Renderer mounts and announces readiness.
      r.mount();
      r.send({ type: "ui_ready" });

      // 4) host_ready always lands post-mount; the git_status snapshot must too.
      //    PRE-FIX: nothing re-fires a snapshot after ui_ready ⇒ this times out.
      await until(() => r.delivered.some(isHostReady));
      await until(() => r.delivered.some((m) => isGitStatus(m) && m.status !== null));

      // 5) Post-fix invariants: exactly one snapshot delivered (no double), and
      //    two total status spawns (stray + ui_ready, none coalesced — the stray
      //    settled fully in step 2 before ui_ready fired the second).
      expect(r.delivered.filter(isGitStatus).length).toBe(1);
      expect(port.statusCalls).toBe(2);
    } finally {
      h.close();
    }
  });

  it("B — R6: N ui_readys deliver exactly N git_status (sendDirect never accumulates in the replay ring)", async () => {
    const port = new RecordingGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: port, outbound }) });
    try {
      for (let k = 1; k <= 3; k += 1) {
        h.send({ type: "ui_ready" });
        // Await the k-th git_status before the next connect so counts are stable.
        await h.waitUntil(() => h.received.filter(isGitStatus).length === k);
      }
      // Buffered snapshots would replay-compound to 6 (1+2+3); sendDirect stays 3.
      expect(h.received.filter(isGitStatus).length).toBe(3);
    } finally {
      h.close();
    }
  });

  it("C — R8: git:null emits exactly one honest status:null per connect, zero spawns", async () => {
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: null, outbound }) });
    const r = lossyRenderer();
    try {
      h.session.bindPort(r.wire);
      r.mount();

      r.send({ type: "ui_ready" });
      await until(() => r.delivered.some(isGitStatus));
      const first = r.delivered.filter(isGitStatus);
      expect(first.length).toBe(1);
      expect(first[0]?.status).toBeNull();

      r.send({ type: "ui_ready" });
      await until(() => r.delivered.filter(isGitStatus).length === 2);
      const second = r.delivered.filter(isGitStatus);
      expect(second.length).toBe(2);
      expect(second[1]?.status).toBeNull();
    } finally {
      h.close();
    }
  });

  it("D — R9 (per-connect half): a transient status() failure delivers status:null (honest unknown)", async () => {

    // is already pinned by git-bridge.test.ts ("stale pill left standing"); not
    // duplicated here.
    const port = new FailingGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: port, outbound }) });
    const r = lossyRenderer();
    try {
      h.session.bindPort(r.wire);
      r.mount();
      r.send({ type: "ui_ready" });

      await until(() => r.delivered.some(isGitStatus));
      const statuses = r.delivered.filter(isGitStatus);
      expect(statuses.length).toBe(1);
      expect(statuses[0]?.status).toBeNull();
      expect(port.statusCalls).toBe(1);
    } finally {
      h.close();
    }
  });

  it("E — mid-flight rebind (reload race, §5#2): an in-flight snapshot targets the CURRENT port at resolve-time (lands on B, never the discarded A); the two ui_readys coalesce into ONE spawn", async () => {
    const port = new GatedGitPort();
    const h = createHarness({ steps: [], git: (outbound) => new GitBridge({ git: port, outbound }) });
    const a = lossyRenderer();
    const b = lossyRenderer();
    try {
      // Renderer A binds + mounts + announces ready → ui_ready snapshot spawns
      // status(), which is GATED (held in flight).
      a.mount();
      h.session.bindPort(a.wire);
      a.send({ type: "ui_ready" });
      await until(() => a.delivered.some(isHostReady));
      await until(() => port.statusCalls === 1);
      expect(port.pending).toBe(1); // A's snapshot is genuinely in flight

      // Renderer A reloads: the host retargets outbound to port B BEFORE A's
      // status resolves.
      h.session.bindPort(b.wire);
      b.mount();
      b.send({ type: "ui_ready" });
      await until(() => b.delivered.some(isHostReady));
      // B's ui_ready snapshot COALESCES onto A's still-in-flight status
      // (single-flight): NO second spawn.
      expect(port.statusCalls).toBe(1);
      expect(port.pending).toBe(1);

      // The single in-flight status resolves → every subscriber's sendDirect
      // targets the port attached NOW = B.
      port.resolveAll();
      await until(() => b.delivered.filter(isGitStatus).length >= 1);
      // Let any straggler post settle so a wrong-port delivery would surface.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      // A (the discarded renderer) got host_ready but ZERO git_status after the
      // rebind — nothing raced onto the dead port; nothing dropped either.
      expect(a.delivered.filter(isGitStatus).length).toBe(0);
      expect(a.dropped.length).toBe(0);

      // B received the snapshot(s), all non-null, all on a live mounted port
      // (no void/lost delivery). The coalesced single spawn feeds both
      // ui_ready subscribers ⇒ exactly 2 non-null git_status on B.
      const bStatuses = b.delivered.filter(isGitStatus);
      expect(bStatuses.length).toBe(2);
      expect(bStatuses.every((m) => m.status !== null)).toBe(true);
      expect(port.statusCalls).toBe(1); // one spawn served BOTH ui_readys
    } finally {
      h.close();
    }
  });
});
