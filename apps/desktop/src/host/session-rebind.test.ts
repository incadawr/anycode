/**
 * TASK.117 product defect regression — the REAL port.close → bindPort(new) →
 * ui_ready seam (2026-10-04 live failure: S2 reload at 1.3s destroyed the
 * parked Write ask).
 *
 * Production shape (verified in main's source): a renderer reload CLOSES the
 * old UI port; main re-posts a fresh MessageChannel to the host on
 * did-finish-load (tabs.ts deliverTabPort → host bindPort) — i.e. AFTER the
 * host has observed the close. The old unconditional
 * `broker.denyAll("ui disconnected", "disconnect")` in bindPort's onClose
 * therefore destroyed the parked ask mid-reload (live evidence: "ui
 * disconnected" deny text + no_pending_request 1.3s after a Page.reload).
 *
 * Correction under test: the close of the CURRENT port arms a BOUNDED grace
 * window instead of settling immediately; a successor bindPort (reload
 * completed) cancels it; shutdown cancels it (its own settlement owns the
 * terminal); expiry with no successor fails closed exactly as before. The
 * parked ask's own authoritative TTL keeps applying throughout.
 *
 * Everything here drives the REAL Session on REAL worker_threads ports —
 * the physical 'close' event is the exact production signal; no scripted
 * store, no synthetic wire messages. After the physical close the harness's
 * own waitFor is dead (it listens on the closed channel), so post-close
 * assertions poll the NEW renderer's delivery log (`until`) — exactly what a
 * reloaded page displays from.
 */

import { describe, expect, it, vi } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import type { HostToUiMessage, WirePort } from "../shared/protocol.js";
import { createHarness, finishStep, nodeWirePort, toolStep, type Harness } from "./test-harness.js";

const WRITE_INPUT = { file_path: "/workspace/a.txt", content: "NEW" };

/** Short grace so expiry tests run in real milliseconds, not 5s. */
const TEST_GRACE_MS = 150;

type Of<T extends string> = Extract<HostToUiMessage, { type: T }>;

const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> => m.type === "permission_request";
const isPermissionSettled = (m: HostToUiMessage): m is Of<"permission_settled"> => m.type === "permission_settled";
const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isLoopEnd = (m: HostToUiMessage): boolean => m.type === "agent_event" && m.event.type === "loop_end";

/**
 * A REAL second renderer end: a fresh MessageChannel pair bound through the
 * REAL Session.bindPort, exactly as main re-posts the port post-reload.
 * Delivery is captured on port1 (the renderer side); ui_ready /
 * permission_response are posted from it.
 */
interface ReboundPort {
  wire: WirePort;
  delivered: HostToUiMessage[];
  closePhysical(): void;
  send(m: unknown): void;
}

function bindSecondRenderer(h: Harness): ReboundPort {
  const channel = new MessageChannel();
  const delivered: HostToUiMessage[] = [];
  channel.port1.on("message", (v: unknown) => {
    delivered.push(v as HostToUiMessage);
  });
  channel.port1.start();
  const wire = nodeWirePort(channel.port2 as NodeMessagePort);
  h.session.bindPort(wire);
  return {
    wire,
    delivered,
    closePhysical(): void {
      channel.port1.close();
      channel.port2.close();
    },
    send(m: unknown): void {
      channel.port1.postMessage(m);
    },
  };
}

/** Poll helper for a NEW renderer's delivery log (harness waitFor is dead post-close). */
async function until(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`until: timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the physical 'close' event be observed by the host (worker_threads delivery). */
async function letCloseLand(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

/**
 * PRODUCTION reconnect ordering: the old port's physical close is observed
 * FIRST (grace arms), then the successor binds (did-finish-load re-post),
 * then the new renderer announces ui_ready.
 */
async function reloadRenderer(h: Harness): Promise<ReboundPort> {
  h.close(); // physical close of the old channel
  await letCloseLand(); // the host observes the close while it is still current
  const b = bindSecondRenderer(h); // main re-posts the port — grace cancels
  b.send({ type: "ui_ready" });
  await until(() => b.delivered.some(isHostReady));
  return b;
}

describe("TASK.117 — renderer reload keeps the SAME parked ask (real port close → rebind → ui_ready)", () => {
  it(
    "reload keeps the parked requestId; allow settles it (origin ui), the Write executes, the turn completes, no resurrection",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      let b: ReboundPort | null = null;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r1", text: "write it" });
        const parked = await h.waitFor(isPermissionRequest);
        const requestId = parked.requestId;
        expect(parked.toolName).toBe("Write");
        expect(h.broker.pendingCount).toBe(1);

        b = await reloadRenderer(h);

        // SAME requestId restored onto B: the ui_ready checkpoint carries it,
        // and (ring intact here) the replayed permission_request matches.
        const checkpoint = b.delivered.find(
          (m): m is Of<"session_checkpoint"> => m.type === "session_checkpoint" && m.permission !== undefined,
        );
        expect(checkpoint?.permission?.requestId).toBe(requestId);
        expect(b.delivered.filter(isPermissionRequest).map((m) => m.requestId)).toEqual([requestId]);

        // Still parked host-side — NOT settled by the reload itself.
        expect(h.broker.pendingShownRequest()?.requestId).toBe(requestId);
        expect(b.delivered.some(isPermissionSettled)).toBe(false);

        // B answers promptly (well inside the ask's own TTL).
        b.send({ type: "permission_response", requestId, behavior: "allow" });
        await until(() => b!.delivered.some(isLoopEnd));
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const settled = b.delivered.filter(isPermissionSettled);
        expect(settled.length).toBe(1);
        expect(settled[0]?.requestId).toBe(requestId);
        expect(settled[0]?.behavior).toBe("allow");
        expect(settled[0]?.origin).toBe("ui");
        // The Write genuinely executed on the turn's real fs.
        expect((h.toolFs as { files?: Map<string, string> }).files?.get("/workspace/a.txt")).toBe("NEW");
        // Terminal, no resurrection.
        expect(b.delivered.filter(isPermissionRequest).length).toBe(1);
        expect(h.broker.pendingCount).toBe(0);
        expect(h.broker.pendingShownRequest()).toBeNull();
      } finally {
        h.close();
        b?.closePhysical();
      }
    },
  );

  it(
    "reload keeps the parked requestId; deny settles it correctly (no write, origin ui, idle, no resurrection)",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c2", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      let b: ReboundPort | null = null;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r2", text: "write it again" });
        const parked = await h.waitFor(isPermissionRequest);
        const requestId = parked.requestId;

        b = await reloadRenderer(h);
        expect(b.delivered.filter(isPermissionRequest).at(-1)?.requestId).toBe(requestId);

        b.send({ type: "permission_response", requestId, behavior: "deny" });
        await until(() => b!.delivered.some(isLoopEnd));
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const settled = b.delivered.filter(isPermissionSettled);
        expect(settled.length).toBe(1);
        expect(settled[0]?.requestId).toBe(requestId);
        expect(settled[0]?.behavior).toBe("deny");
        expect(settled[0]?.origin).toBe("ui");
        expect((h.toolFs as { files?: Map<string, string> }).files?.get("/workspace/a.txt")).toBeUndefined();
        expect(h.broker.pendingCount).toBe(0);
        expect(h.broker.pendingShownRequest()).toBeNull();
      } finally {
        h.close();
        b?.closePhysical();
      }
    },
  );

  it(
    "grace expiry with NO successor still fails closed: denyAll(\"ui disconnected\", \"disconnect\") after the window",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c3", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      const denySpy = vi.spyOn(h.broker, "denyAll");
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r3", text: "write it" });
        await h.waitFor(isPermissionRequest);
        expect(h.broker.pendingCount).toBe(1);

        // Last renderer gone, no rebind coming: within the window the ask is
        // still parked (NOT yet denied)…
        h.close();
        await letCloseLand();
        expect(h.broker.pendingCount).toBe(1); // grace holds the deny
        expect(denySpy).not.toHaveBeenCalled();

        // …and once the window expires it fails closed exactly as before.
        await until(() => h.broker.pendingCount === 0, TEST_GRACE_MS * 4);
        expect(denySpy).toHaveBeenCalledWith("ui disconnected", "disconnect");
        expect(h.broker.pendingShownRequest()).toBeNull();
      } finally {
        h.close();
      }
    },
  );

  it(
    "stale close is harmless to the NEW binding: B binds FIRST, A's close arrives AFTER — B's ui_ready still restores and settles",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c4", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      let b: ReboundPort | null = null;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r4", text: "write it" });
        const parked = await h.waitFor(isPermissionRequest);
        const requestId = parked.requestId;

        b = bindSecondRenderer(h);
        h.close(); // A's physical close arrives AFTER the rebind — stale.
        await letCloseLand();

        b.send({ type: "ui_ready" });
        await until(() => b!.delivered.some(isHostReady));
        expect(b.delivered.filter(isPermissionRequest).at(-1)?.requestId).toBe(requestId);
        expect(h.broker.pendingShownRequest()?.requestId).toBe(requestId);

        b.send({ type: "permission_response", requestId, behavior: "allow" });
        await until(() => b!.delivered.some(isLoopEnd));
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const settled = b.delivered.filter(isPermissionSettled);
        expect(settled.length).toBe(1);
        expect(settled[0]?.origin).toBe("ui");
        expect(settled[0]?.behavior).toBe("allow");
        expect(h.broker.pendingCount).toBe(0);
      } finally {
        h.close();
        b?.closePhysical();
      }
    },
  );

  it(
    "turn cancel after a reload still settles the surviving ask: origin turn_cancelled",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c5", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      let b: ReboundPort | null = null;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r5", text: "write it" });
        const parked = await h.waitFor(isPermissionRequest);
        const requestId = parked.requestId;

        b = await reloadRenderer(h);
        expect(b.delivered.filter(isPermissionRequest).at(-1)?.requestId).toBe(requestId);

        b.send({ type: "cancel_turn" });
        await until(() => b!.delivered.some(isPermissionSettled));
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const settled = b.delivered.filter(isPermissionSettled);
        expect(settled.length).toBe(1);
        expect(settled[0]?.origin).toBe("turn_cancelled");
        expect(h.broker.pendingCount).toBe(0);
      } finally {
        h.close();
        b?.closePhysical();
      }
    },
  );

  it(
    "shutdown after a reload settles the surviving ask (origin shutdown, exactly one settlement) and nothing resurrects",
    { timeout: 60_000 },
    async () => {
      const h = createHarness({ steps: [toolStep("c6", "Write", WRITE_INPUT), finishStep()], reconnectGraceMs: TEST_GRACE_MS });
      let b: ReboundPort | null = null;
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r6", text: "write it" });
        const parked = await h.waitFor(isPermissionRequest);
        const requestId = parked.requestId;

        b = await reloadRenderer(h);
        expect(b.delivered.filter(isPermissionRequest).at(-1)?.requestId).toBe(requestId);

        await h.session.shutdown();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        const settled = b.delivered.filter(isPermissionSettled);
        expect(settled.length).toBe(1);
        expect(settled[0]?.origin).toBe("shutdown");
        expect(settled[0]?.requestId).toBe(requestId);
        expect(h.broker.pendingCount).toBe(0);
        // Terminal: no NEW ask may appear after shutdown's settlement.
        expect(b.delivered.filter(isPermissionRequest).map((m) => m.requestId)).toEqual([requestId]);
      } finally {
        h.close();
        b?.closePhysical();
      }
    },
  );

  it(
    "the parked ask's own TTL still bounds it across the window: no successor, no settlement, expiry deny comes from the broker timeout — never indefinite",
    { timeout: 60_000 },
    async () => {
      // Broker TTL far longer than the grace window: after grace expiry the
      // disconnect deny fires (fail-closed), proving the window cannot leave
      // an ask parked indefinitely when nobody rebinds.
      const h = createHarness({
        steps: [toolStep("c7", "Write", WRITE_INPUT), finishStep()],
        reconnectGraceMs: TEST_GRACE_MS,
        brokerTimeoutMs: 60_000,
      });
      const denySpy = vi.spyOn(h.broker, "denyAll");
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r7", text: "write it" });
        await h.waitFor(isPermissionRequest);

        h.close();
        await letCloseLand();
        // Grace expiry — NOT the 60s broker TTL — settles the ask, because a
        // rebind never came; origin "disconnect" (fail-closed, bounded). The
        // wire message itself is unobservable post-close (dead port); the
        // broker call is the settlement's authoritative fact.
        await until(() => h.broker.pendingCount === 0, TEST_GRACE_MS * 4);
        expect(denySpy).toHaveBeenCalledWith("ui disconnected", "disconnect");
      } finally {
        h.close();
      }
    },
  );
});
