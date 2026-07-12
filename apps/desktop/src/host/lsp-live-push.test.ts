/**
 * lsp-live-push (slice P7.25/F3 W1): the ui_ready-gated live-push seam between
 * the host Session and the LSP status source. A fake `lsp` seam captures the
 * Session's onStatusChange subscription so a test can drive a transition and
 * assert the three seam invariants:
 *

 *       push must never race a not-yet-proven-ready renderer; 5.7-hostfix).
 *   (2) live push — a transition AFTER ui_ready emits a fresh `lsp_status`
 *       carrying the seam's current snapshot (would fail on a pull-only build).
 *   (3) teardown — after shutdown the subscription is released and a later
 *       transition pushes nothing (no leaked listener, no push-after-dispose).
 *
 * No real LspManager here — the manager's own notify/coalescing is covered by
 * packages/core lsp/manager.test.ts; this isolates the Session wiring.
 */

import { describe, expect, it } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import type { LspServerStatus } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { createHarness, nodeWirePort } from "./test-harness.js";

const isHostReady = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "host_ready" }> =>
  m.type === "host_ready";

function lspStatusPushes(received: HostToUiMessage[]): Extract<HostToUiMessage, { type: "lsp_status" }>[] {
  return received.filter((m): m is Extract<HostToUiMessage, { type: "lsp_status" }> => m.type === "lsp_status");
}

/** Fake `lsp` session seam: captures the registered listener and lets a test fire it + swap the snapshot. */
function makeFakeLspSeam(): {
  seam: { status(): LspServerStatus[]; onStatusChange(listener: () => void): () => void };
  fire: () => void;
  setServers: (servers: LspServerStatus[]) => void;
  unsubscribed: () => boolean;
} {
  let servers: LspServerStatus[] = [{ name: "tsserver", state: "not_started", extensions: [".ts"], stderrTail: "" }];
  let listener: (() => void) | null = null;
  let unsubscribed = false;
  return {
    seam: {
      status: () => servers,
      onStatusChange: (l: () => void): (() => void) => {
        listener = l;
        return () => {
          listener = null;
          unsubscribed = true;
        };
      },
    },
    fire: () => listener?.(),
    setServers: (s) => {
      servers = s;
    },
    unsubscribed: () => unsubscribed,
  };
}

describe("lsp live-push seam (P7.25/F3)", () => {
  it("does NOT push lsp_status on a transition BEFORE ui_ready (R3 gate)", async () => {
    const fake = makeFakeLspSeam();
    const h = createHarness({ steps: [], lspSeam: fake.seam });
    try {
      // No ui_ready yet — the renderer is not proven ready. A transition fires...
      fake.setServers([{ name: "tsserver", state: "ready", extensions: [".ts"], stderrTail: "" }]);
      fake.fire();
      await h.flush();
      // ...and nothing was pushed.
      expect(lspStatusPushes(h.received)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("pushes a fresh lsp_status on a transition AFTER ui_ready", async () => {
    const fake = makeFakeLspSeam();
    const h = createHarness({ steps: [], lspSeam: fake.seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.flush(); // drain the full ui_ready cascade (lsp_status rides after host_ready)
      // ui_ready itself pushed the current (not_started) snapshot once.
      const baseline = lspStatusPushes(h.received).length;
      expect(baseline).toBe(1);

      // A real transition: the server reached ready.
      fake.setServers([{ name: "tsserver", state: "ready", extensions: [".ts"], stderrTail: "" }]);
      fake.fire();
      await h.flush();

      const pushes = lspStatusPushes(h.received);
      expect(pushes).toHaveLength(baseline + 1);
      expect(pushes[pushes.length - 1]!.servers[0]!.state).toBe("ready");
    } finally {
      h.close();
    }
  });

  it("releases the subscription on shutdown — no push after dispose", async () => {
    const fake = makeFakeLspSeam();
    const h = createHarness({ steps: [], lspSeam: fake.seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.flush(); // drain the ui_ready cascade before measuring the baseline

      await h.session.shutdown();
      expect(fake.unsubscribed()).toBe(true);

      const before = lspStatusPushes(h.received).length;
      fake.setServers([{ name: "tsserver", state: "disposed", extensions: [".ts"], stderrTail: "" }]);
      fake.fire(); // listener was unsubscribed AND uiReady flipped false
      await h.flush();
      expect(lspStatusPushes(h.received)).toHaveLength(before);
    } finally {
      h.close();
    }
  });

  it("resets uiReady on a renderer reconnect (bindPort) — no push races the not-yet-mounted new port (W1-FIX)", async () => {
    const fake = makeFakeLspSeam();
    const h = createHarness({ steps: [], lspSeam: fake.seam });
    // The UI-side end of a SECOND channel, standing in for a reconnected renderer
    // (reload/crash) rebinding a new port before it has sent its own ui_ready.
    const channel2 = new MessageChannel();
    const uiPort2: NodeMessagePort = channel2.port1;
    const hostPort2: NodeMessagePort = channel2.port2;
    const received2: HostToUiMessage[] = [];
    uiPort2.on("message", (value: unknown) => {
      received2.push(value as HostToUiMessage);
    });
    uiPort2.start();
    try {
      // Renderer A proves ready; a push works on its port (h.received).
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.flush();
      expect(lspStatusPushes(h.received)).toHaveLength(1);

      // Renderer B reconnects: bindPort attaches the new port BEFORE B sends its
      // own ui_ready. Without the W1-FIX reset, uiReady would still read true
      // (set by renderer A above) and the transition below would race a push
      // onto the not-yet-mounted new port.
      h.session.bindPort(nodeWirePort(hostPort2));

      fake.setServers([{ name: "tsserver", state: "ready", extensions: [".ts"], stderrTail: "" }]);
      fake.fire();
      await h.flush();
      expect(lspStatusPushes(received2)).toHaveLength(0);

      // Once B sends its own ui_ready, the cascade pushes the current snapshot...
      uiPort2.postMessage({ type: "ui_ready" });
      await h.flush();
      await h.flush();
      expect(lspStatusPushes(received2).length).toBeGreaterThanOrEqual(1);
      const baselineB = lspStatusPushes(received2).length;

      // ...and a transition AFTER B's ui_ready pushes again.
      fake.setServers([{ name: "tsserver", state: "crashed", extensions: [".ts"], stderrTail: "" }]);
      fake.fire();
      await h.flush();
      expect(lspStatusPushes(received2)).toHaveLength(baselineB + 1);
    } finally {
      uiPort2.close();
      hostPort2.close();
      h.close();
    }
  });
});
