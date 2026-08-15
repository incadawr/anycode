/**
 * Pure-logic tests for BinaryTrustDialog's exported helpers (TASK.103,
 * CUT-S4.md §6c BU1-BU2). Same `.test.ts`-only, no-jsdom rationale as every
 * other component test in this directory (vitest runs `environment: "node"`
 * — no jsdom, no testing-library): the dialog's own `<dialog>` JSX is never
 * rendered here, only the two exported pure functions it and both engine
 * panes read from.
 */
import { describe, expect, it } from "vitest";
import { binaryTrustRefusalOf, describeBinaryTrustGrant } from "./BinaryTrustDialog.js";

describe("binaryTrustRefusalOf", () => {
  it("BU1 a report carrying trustRefusal returns it verbatim", () => {
    const report = {
      status: "error",
      error: "world-writable",
      trustRefusal: { binaryPath: "/opt/codex", reason: "world-writable", staleConsent: false },
    };
    expect(binaryTrustRefusalOf(report)).toEqual({ binaryPath: "/opt/codex", reason: "world-writable", staleConsent: false });
  });

  it("BU1 a report without trustRefusal returns null (not_installed / ready / a plain error)", () => {
    // Realistic report shapes (extra fields beyond `trustRefusal`) — bound to
    // a variable first, not passed as an inline literal, so TS's excess-
    // property check doesn't reject the fields this narrow reader ignores.
    const notInstalled: { status: string; trustRefusal?: { binaryPath: string; reason: string } } = { status: "not_installed" };
    const ready: { status: string; trustRefusal?: { binaryPath: string; reason: string } } = { status: "ready" };
    const plainError: { status: string; error: string; trustRefusal?: { binaryPath: string; reason: string } } = {
      status: "error",
      error: "spawn ENOENT",
    };
    expect(binaryTrustRefusalOf(notInstalled)).toBeNull();
    expect(binaryTrustRefusalOf(ready)).toBeNull();
    expect(binaryTrustRefusalOf(plainError)).toBeNull();
  });

  it("BU1 an undefined report (no check has returned yet) returns null", () => {
    expect(binaryTrustRefusalOf(undefined)).toBeNull();
  });
});

describe("describeBinaryTrustGrant", () => {
  it("BU2 pins the §8 copy verbatim, with path and reason interpolated", () => {
    const copy = describeBinaryTrustGrant("/tmp/s4-trust/bin/codex", "Codex binary's directory (/tmp/s4-trust) is world-writable");
    expect(copy).toEqual({
      title: "Trust this binary?",
      refusalLine: "AnyCode refused to run /tmp/s4-trust/bin/codex: Codex binary's directory (/tmp/s4-trust) is world-writable",
      attackerLine:
        "Anyone who can write to that location can replace this binary, and AnyCode would run their code with your permissions.",
      pinLine:
        "If you trust it, AnyCode pins the binary exactly as it is right now (owner, permissions, size, modification time). If anything about it changes, AnyCode will ask again before running it.",
      acceptLabel: "Trust this binary",
      declineLabel: "Cancel",
      changedLine: null,
    });
  });

  it("BU2 a different path/reason changes only the interpolated line, not the fixed copy", () => {
    const copy = describeBinaryTrustGrant("/opt/claude", "Claude binary (/opt/claude) is world-writable");
    expect(copy.refusalLine).toBe("AnyCode refused to run /opt/claude: Claude binary (/opt/claude) is world-writable");
    expect(copy.title).toBe("Trust this binary?");
    expect(copy.acceptLabel).toBe("Trust this binary");
    expect(copy.declineLabel).toBe("Cancel");
  });

  it("BU8 staleConsent:true adds the §6 changedLine, verbatim, and every other string stays byte-identical", () => {
    const copy = describeBinaryTrustGrant("/opt/codex", "Codex binary (/opt/codex) is world-writable", true);
    expect(copy.changedLine).toBe(
      "You trusted this binary before, but it has changed since that grant. If you did not update it yourself, do not trust it again.",
    );
    expect(copy.title).toBe("Trust this binary?");
    expect(copy.refusalLine).toBe("AnyCode refused to run /opt/codex: Codex binary (/opt/codex) is world-writable");
    expect(copy.attackerLine).toBe(
      "Anyone who can write to that location can replace this binary, and AnyCode would run their code with your permissions.",
    );
    expect(copy.pinLine).toBe(
      "If you trust it, AnyCode pins the binary exactly as it is right now (owner, permissions, size, modification time). If anything about it changes, AnyCode will ask again before running it.",
    );
    expect(copy.acceptLabel).toBe("Trust this binary");
    expect(copy.declineLabel).toBe("Cancel");
  });

  it("BU8 staleConsent:false ⇒ changedLine is null, every other string stays byte-identical", () => {
    const copy = describeBinaryTrustGrant("/opt/codex", "Codex binary (/opt/codex) is world-writable", false);
    expect(copy.changedLine).toBeNull();
    expect(copy.title).toBe("Trust this binary?");
    expect(copy.refusalLine).toBe("AnyCode refused to run /opt/codex: Codex binary (/opt/codex) is world-writable");
    expect(copy.attackerLine).toBe(
      "Anyone who can write to that location can replace this binary, and AnyCode would run their code with your permissions.",
    );
    expect(copy.pinLine).toBe(
      "If you trust it, AnyCode pins the binary exactly as it is right now (owner, permissions, size, modification time). If anything about it changes, AnyCode will ask again before running it.",
    );
    expect(copy.acceptLabel).toBe("Trust this binary");
    expect(copy.declineLabel).toBe("Cancel");
  });
});

describe("binaryTrustRefusalOf — staleConsent tagging (BU9)", () => {
  it("BU9 a refusal tagged staleConsent:true passes it through", () => {
    const report = {
      status: "error",
      error: "world-writable",
      trustRefusal: { binaryPath: "/opt/codex", reason: "world-writable", staleConsent: true },
    };
    expect(binaryTrustRefusalOf(report)).toEqual({ binaryPath: "/opt/codex", reason: "world-writable", staleConsent: true });
  });

  it("BU9 a refusal WITHOUT the staleConsent field degrades to staleConsent:false (fail-safe direction, === true pin)", () => {
    const report = {
      status: "error",
      error: "world-writable",
      trustRefusal: { binaryPath: "/opt/codex", reason: "world-writable" },
    };
    expect(binaryTrustRefusalOf(report)).toEqual({ binaryPath: "/opt/codex", reason: "world-writable", staleConsent: false });
  });

  it("BU9 no trustRefusal at all still returns null", () => {
    const notInstalled: { status: string; trustRefusal?: { binaryPath: string; reason: string; staleConsent?: boolean } } = {
      status: "not_installed",
    };
    expect(binaryTrustRefusalOf(notInstalled)).toBeNull();
  });
});
