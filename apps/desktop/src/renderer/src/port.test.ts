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
import { describe, expect, it } from "vitest";
import { parseChildEnvelopeField } from "./port.js";

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
