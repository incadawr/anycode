/**
 * Pure-logic test for App.tsx's Welcome-screen gate (slice 2.2, ruling
 * reviews/slice-2.2-forks-ruling.md §2). `.test.ts`-only, same rationale as
 * every other renderer component test in this wave: no jsdom in this
 * package's vitest config, so `App` itself (a full React tree touching
 * `startConnectionManager`/`window.anycode`) isn't rendered here — only the
 * exported pure gating function, which carries the actual decision logic, is
 * exercised directly.
 */
import { describe, expect, it } from "vitest";
import type { SettingsSnapshot } from "../../shared/settings.js";
import type { UiToHostMessage } from "../../shared/protocol.js";
import {
  computeGitPanelOpen,
  dispatchTryAgain,
  selectMainPaneView,
  shouldShowWelcome,
  shouldSuppressEscForDraft,
} from "./App.js";
import { createDesktopStore, type RetryOffer } from "./store.js";

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: {
      version: 2,
      provider: { connections: [] },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    },
    secrets: [{ key: "provider.apiKey", set: false, source: "none", tier: "unavailable" }],
    providerReady: false,
    envOverrides: [],
    readOnly: false,
    ...overrides,
  };
}

function withConnections(count: number, overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  const base = snapshot(overrides);
  return {
    ...base,
    settings: {
      ...base.settings,
      provider: {
        activeConnectionId: `conn-${count - 1}`,
        connections: Array.from({ length: count }, (_, i) => ({ id: `conn-${i}`, providerId: "z-ai" })),
      },
    },
  };
}

describe("shouldShowWelcome (ruling §2)", () => {
  it("shows Welcome once the snapshot has loaded, the provider isn't ready, and no tab is open", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0)).toBe(true);
  });

  it("does not show Welcome before the first snapshot has loaded — avoids flashing Welcome during the unknown-readiness window right after mount", () => {
    expect(shouldShowWelcome(null, 0)).toBe(false);
  });

  it("does not show Welcome once ready, even with zero tabs — the shell lets the user open a session explicitly", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: true }), 0)).toBe(false);
  });

  it("does not show Welcome when a main-validated external engine is available without Core credentials", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0, true)).toBe(false);
  });

  it("waits for the external-engine verdict rather than flashing provider-only Welcome", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 0, null)).toBe(false);
  });

  it("does not show Welcome once any tab is open, even if not ready — Welcome yields to the tab UI by tab count, not by providerReady flipping back", () => {
    expect(shouldShowWelcome(snapshot({ providerReady: false }), 1)).toBe(false);
    expect(shouldShowWelcome(snapshot({ providerReady: true }), 2)).toBe(false);
  });

  // Dogfood 16.07 lockout: a user with several configured connections
  // activated a keyless custom connection (providerReady -> false, no tabs
  // open) and was dumped into first-run onboarding with no path back — the
  // Welcome form binds `connections[0]`, not the failing active connection.
  // Reverting the gate to ignore connection count turns this red.
  it("does not show Welcome for a configured user (≥2 connections), even when the active one isn't ready — the shell keeps Settings reachable", () => {
    expect(shouldShowWelcome(withConnections(2, { providerReady: false }), 0)).toBe(false);
    expect(shouldShowWelcome(withConnections(4, { providerReady: false }), 0)).toBe(false);
  });

  it("still shows Welcome mid-setup — exactly one connection, not ready yet (metadata saved, credential pending): its form edits that same connection", () => {
    expect(shouldShowWelcome(withConnections(1, { providerReady: false }), 0)).toBe(true);
  });
});

describe("selectMainPaneView (slice P7.12 §4.6)", () => {
  it("the start screen wins over an active tab", () => {
    expect(selectMainPaneView(true, true)).toBe("start");
  });

  it("an active tab renders when the draft is not active", () => {
    expect(selectMainPaneView(false, true)).toBe("active");
  });

  it("falls back to the empty shell with no draft and no active tab", () => {
    expect(selectMainPaneView(false, false)).toBe("empty");
  });

  it("the start screen wins even with no active tab", () => {
    expect(selectMainPaneView(true, false)).toBe("start");
  });
});

describe("shouldSuppressEscForDraft (slice P7.12 §4.6)", () => {
  it("suppresses Esc while the start screen is active — must not cancel a background tab's turn", () => {
    expect(shouldSuppressEscForDraft(true)).toBe(true);
  });

  it("does not suppress Esc when there is no active draft", () => {
    expect(shouldSuppressEscForDraft(false)).toBe(false);
  });
});

describe("computeGitPanelOpen (design TASK.40 §2(f)) — shell-owned, not engine.capabilities.supportsGitMutations", () => {
  it("stays closed when the user never opened it, regardless of shell capability", () => {
    expect(computeGitPanelOpen(false, true)).toBe(false);
    expect(computeGitPanelOpen(false, false)).toBe(false);
    expect(computeGitPanelOpen(false, undefined)).toBe(false);
  });

  it("opens when requested and shell.gitReadOnly is explicitly true (a Codex session in a git workspace)", () => {
    expect(computeGitPanelOpen(true, true)).toBe(true);
  });

  it("stays closed when requested but shell.gitReadOnly is explicitly false (a Codex session with no git workspace)", () => {
    expect(computeGitPanelOpen(true, false)).toBe(false);
  });

  it("defaults to open when requested and shell is undefined — byte-identical to core's pre-TASK.40 behavior (no engine gating at all)", () => {
    expect(computeGitPanelOpen(true, undefined)).toBe(true);
  });
});

describe("dispatchTryAgain (TASK.33 W8 one-shot Try-again — normal send/queue/busy path)", () => {
  // An offer only ever arms while connected (the loop_end reducer that sets
  // `retry` runs on a live `host_ready`-derived turn) — `connection: "ready"`
  // is the realistic precondition every case here starts from.
  function armRetry(store: ReturnType<typeof createDesktopStore>, offer: RetryOffer): void {
    store.setState({ retry: offer, connection: "ready" });
  }

  it("no-op when nothing is armed (stale/double click) — sendToHost never called", () => {
    const store = createDesktopStore();
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toEqual([]);
  });

  it("idle, no queue-in-flight ⇒ direct-sends through the SAME path as Composer.handleSend: echoes user_text, records the resend, puts user_message on the wire, and consumes the offer", () => {
    const store = createDesktopStore();
    armRetry(store, { loopEndBlockId: "loop_end:t1", text: "hello", images: [] });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "user_message", text: "hello" });
    expect(store.getState().transcript.some((b) => b.kind === "user_text" && b.text === "hello")).toBe(true);
    expect(store.getState().lastSentMessage).toEqual({ text: "hello", images: [] });
    expect(store.getState().retry).toBeNull();
  });

  it("carries the offer's images through onto the wire message", () => {
    const store = createDesktopStore();
    const image = { name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png" as const, data: "AA==" } };
    armRetry(store, { loopEndBlockId: "loop_end:t1", text: "hello", images: [image] });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent[0]).toMatchObject({ type: "user_message", text: "hello", images: [image.attachment] });
  });

  it("a turn already running ⇒ enqueues instead of direct-sending — busy is honored exactly like any other send", () => {
    const store = createDesktopStore();
    store.setState({ turn: { status: "running", turnId: "t1", requestId: "r1" } });
    armRetry(store, { loopEndBlockId: "loop_end:t0", text: "hello", images: [] });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toEqual([]);
    expect(store.getState().promptQueue).toHaveLength(1);
    expect(store.getState().promptQueue[0]).toMatchObject({ text: "hello" });
    // Consumed regardless of which branch ends up replaying it — still one-shot.
    expect(store.getState().retry).toBeNull();
  });

  it("a drained queue item still in flight (turn momentarily idle) ⇒ also enqueues, matching Composer's own in-flight-window guard", () => {
    const store = createDesktopStore();
    store.setState({ queueInFlight: { requestId: "in-flight", item: { id: "q1", text: "other", images: [] } } });
    armRetry(store, { loopEndBlockId: "loop_end:t0", text: "hello", images: [] });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toEqual([]);
    expect(store.getState().promptQueue).toHaveLength(1);
  });

  it("one-shot: a second click right after the first finds nothing armed and sends nothing further", () => {
    const store = createDesktopStore();
    armRetry(store, { loopEndBlockId: "loop_end:t1", text: "hello", images: [] });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));
    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toHaveLength(1);
  });

  it("connection not ready (host exited after the offer armed) ⇒ the offer survives UNCONSUMED and nothing reaches the wire — a stale click on a button that should have been hidden must not silently drop the resend", () => {
    const store = createDesktopStore();
    const offer: RetryOffer = { loopEndBlockId: "loop_end:t1", text: "hello", images: [] };
    armRetry(store, offer);
    store.setState({ connection: "host_exited" });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toEqual([]);
    expect(store.getState().retry).toEqual(offer);
    expect(store.getState().transcript.some((b) => b.kind === "user_text")).toBe(false);
  });
});

// TASK.56 W3-FIX (fable-task56-w3-codex-ruling.md finding 2): `dispatchTryAgain`
// was the one W3-gated send site the cut missed — a click on an armed
// image-bearing offer, after the live model verdict swings to non-vision,
// used to consume the offer and lose the images with no restore path (the
// direct-send branch has no `queueInFlight` to key a `turn_rejected` restore
// off). §(d)'s tests T1-T5 close that gap; T6 (tab-registry.test.ts) PINs
// finding 1's NOT-A-BUG ruling (the drainer keeps sending, by design).
describe("dispatchTryAgain — TASK.56 W3-FIX entry gate against the live model image verdict (fable-task56-w3-codex-ruling.md finding 2 §(c))", () => {
  const IMAGE = { name: "shot.png", sizeBytes: 42, attachment: { mediaType: "image/png" as const, data: "AA==" } };

  /**
   * Arms a real retry offer through the actual production path (not a manual
   * `setState`): a turn starts, the given text+images are recorded via
   * `recordSentMessage` — the same call every send site makes — then the
   * turn ends in a retryable, no-model-output error, which the `loop_end`
   * reducer reads to arm `state.retry` (store.ts:1582-1594).
   */
  function armRetryViaRealPath(store: ReturnType<typeof createDesktopStore>, text: string, images: RetryOffer["images"]): void {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId: "t1" });
    store.getState().recordSentMessage(text, images);
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId: "t1",
      event: {
        type: "error",
        error: { name: "AI_APICallError", message: "Cannot connect to API: Connect Timeout Error" },
        retry: { attemptsMade: 3, maxAttempts: 3, retryable: true, hadModelOutput: false, code: "connect_timeout" },
      },
    });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "error", turns: 1 } });
  }

  it("T1 — App-dispatch-layer PIN: retry-with-images + imageInput:false ⇒ click does not reach the wire, does not consume the offer, and raises a retry_blocked notice", () => {
    const store = createDesktopStore();
    armRetryViaRealPath(store, "look at this", [IMAGE]);
    store.getState().applyHostMessage({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", imageInput: false });
    const sent: UiToHostMessage[] = [];

    const outcome = dispatchTryAgain(store, (m) => sent.push(m));

    expect(outcome).toBe("blocked_images");
    expect(sent).toEqual([]);
    expect(store.getState().retry).toMatchObject({ text: "look at this", images: [IMAGE] });
    expect(store.getState().notice?.kind).toBe("retry_blocked");
  });

  it("T2 — default-contract pin: imageInput undefined (legacy host / engine session with no seam) does not gate a retry-with-images offer", () => {
    const store = createDesktopStore();
    armRetryViaRealPath(store, "look at this", [IMAGE]);
    expect(store.getState().imageInput).toBeUndefined();
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "user_message", text: "look at this", images: [IMAGE.attachment] });
    expect(store.getState().retry).toBeNull();
  });

  it("T3 — narrowness pin: a retry WITHOUT images sends normally even when imageInput:false", () => {
    const store = createDesktopStore();
    armRetryViaRealPath(store, "no pictures here", []);
    store.getState().applyHostMessage({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", imageInput: false });
    const sent: UiToHostMessage[] = [];

    dispatchTryAgain(store, (m) => sent.push(m));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "user_message", text: "no pictures here" });
    expect(store.getState().retry).toBeNull();
  });

  it("T4 — the entry gate covers the enqueue branch too: busy (queueInFlight) + retry-with-images + imageInput:false does not enqueue and leaves the offer armed", () => {
    const store = createDesktopStore();
    armRetryViaRealPath(store, "look at this", [IMAGE]);
    store.getState().applyHostMessage({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", imageInput: false });
    // Busy precondition (same manual-setState convention the normal
    // send/queue/busy suite above uses for this exact state) — a
    // non-gated click would otherwise take the enqueue branch.
    store.setState({ queueInFlight: { requestId: "in-flight", item: { id: "q1", text: "other", images: [] } } });
    const sent: UiToHostMessage[] = [];

    const outcome = dispatchTryAgain(store, (m) => sent.push(m));

    expect(outcome).toBe("blocked_images");
    expect(sent).toEqual([]);
    expect(store.getState().promptQueue).toEqual([]);
    expect(store.getState().retry).toMatchObject({ text: "look at this", images: [IMAGE] });
    expect(store.getState().notice?.kind).toBe("retry_blocked");
  });

  it("T7 — recovery pin: peek semantics (NOT consume) let a blocked click's offer survive intact to be replayed once the live model verdict swings back to vision", () => {
    const store = createDesktopStore();
    armRetryViaRealPath(store, "look at this", [IMAGE]);
    store.getState().applyHostMessage({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", imageInput: false });
    const sent: UiToHostMessage[] = [];

    const first = dispatchTryAgain(store, (m) => sent.push(m));

    expect(first).toBe("blocked_images");
    expect(sent).toEqual([]);

    store.getState().applyHostMessage({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", imageInput: true });
    const second = dispatchTryAgain(store, (m) => sent.push(m));

    expect(second).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "user_message", text: "look at this", images: [IMAGE.attachment] });
    expect(store.getState().retry).toBeNull();
  });
});
