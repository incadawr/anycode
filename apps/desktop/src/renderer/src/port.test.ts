/**
 * port.ts tests (TASK.102 CUT-S2 §2.5, slice S2c C2). Scoped narrowly to
 * `parseChildEnvelopeField`, the one pure function this slice adds here —
 * `onHostPort`/`onTerminalPort`/`onHostExited` themselves reach into
 * `window.addEventListener`, which does not exist under this package's
 * vitest config (`environment: "node"`, no jsdom — the desktop renderer
 * test-tsx pitfall's sibling constraint for plain `.ts` files that touch the
 * DOM directly). The full envelope->registry wiring (including this field
 * reaching `tab-registry.ts`'s classification branch) is exercised through
 * `createTabRegistry` directly in tab-registry.test.ts, which never goes
 * through `window`.
 */
import { describe, expect, it, vi } from "vitest";
import { startConnectionManager, parseChildEnvelopeField } from "./port.js";

describe("port — parseChildEnvelopeField (TASK.102 CUT-S2 §2.5)", () => {
  it("passes through a well-formed child field untouched", () => {
    const child = {
      parentTabId: "root-1",
      parentSessionId: "sess-root",
      spawnToolCallId: "call-1",
      childSessionId: "sess-child",
    };
    expect(parseChildEnvelopeField(child)).toEqual(child);
  });

  it("returns undefined for an absent field (every ordinary root-tab envelope)", () => {
    expect(parseChildEnvelopeField(undefined)).toBeUndefined();
  });

  it("drops a partially-shaped object instead of forwarding it with missing fields", () => {
    expect(parseChildEnvelopeField({ parentTabId: "root-1" })).toBeUndefined();
    expect(
      parseChildEnvelopeField({
        parentTabId: "root-1",
        parentSessionId: "sess-root",
        spawnToolCallId: "call-1",
        // childSessionId missing
      }),
    ).toBeUndefined();
  });

  it("drops an object whose sub-fields aren't all strings", () => {
    expect(
      parseChildEnvelopeField({
        parentTabId: 1,
        parentSessionId: "sess-root",
        spawnToolCallId: "call-1",
        childSessionId: "sess-child",
      }),
    ).toBeUndefined();
  });

  it("drops non-object values (a window.postMessage envelope is untrusted `unknown`)", () => {
    expect(parseChildEnvelopeField("not-an-object")).toBeUndefined();
    expect(parseChildEnvelopeField(null)).toBeUndefined();
    expect(parseChildEnvelopeField(42)).toBeUndefined();
  });
});


describe("main tab-close notification (Taskana 4880)", () => {
  it("disposes the renderer tab and forwards its pinned handle on port delivery", () => {
    const listeners = new Set<(event: unknown) => void>();
    vi.stubGlobal("window", {
      addEventListener: (_name: string, cb: (event: unknown) => void) => listeners.add(cb),
      removeEventListener: (_name: string, cb: (event: unknown) => void) => listeners.delete(cb),
    });
    const registry = { registerPort: vi.fn(() => true), registerTerminalPort: vi.fn(() => true), markHostExited: vi.fn(), disposeTab: vi.fn() };
    try {
      const stop = startConnectionManager(registry);
      const port = {} as MessagePort;
      for (const cb of listeners) cb({ data: { type: "anycode:port", tabId: "tab", workspace: "/ws", openedByAgent: true, agentTitle: "worker-1" }, ports: [port] });
      expect(registry.registerPort).toHaveBeenCalledWith("tab", "/ws", port, undefined, undefined, true, "worker-1");
      for (const cb of listeners) cb({ data: { type: "anycode:tab-closed", tabId: "tab" }, ports: [] });
      expect(registry.disposeTab).toHaveBeenCalledWith("tab");
      expect(registry.markHostExited).not.toHaveBeenCalled();
      stop();
      expect(listeners.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
