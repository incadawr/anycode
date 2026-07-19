/**
 * Pure-logic tests for ClaudeEnginePane's exported helpers (SLICE-CC A4).
 * Same `.test.ts`-only, no-jsdom rationale as CodexEnginePane.test.ts: this
 * package's vitest config runs `environment: "node"`.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClaudeDoctorReport } from "../../../shared/claude-doctor.js";
import {
  CLAUDE_LOGIN_IN_PROGRESS_COPY,
  CLAUDE_PROFILE_LOGIN_COMMAND,
  CLAUDE_READY_QUOTA_TRACE,
  CLAUDE_SUBSCRIPTION_RISK_NOTE,
  canShowReadyTrace,
  canShowSignInButton,
  cancelClaudeSignIn,
  describeClaudeReportStatus,
  formatClaudeBinarySourceLabel,
  loginFailureMessage,
  pickClaudeBinaryFailureMessage,
  runClaudeSignIn,
  signInButtonDisabled,
  subscribeToClaudeSnapshotPush,
  type ClaudeBridge,
  type ClaudeLoginStartResult,
  type ClaudeOnboardingSnapshot,
} from "./ClaudeEnginePane.js";

// Doctor-spawn-loop fix (owner-reproduced live): an unconditional
// `engines-changed` push led every subscriber back to a recheck, whose own
// `onSnapshot` fired another `engines-changed` push — an infinite doctor
// probe loop that kept `loginStart`'s busy-gate permanently refusing. The
// pane now applies every subsequent snapshot from the dedicated
// `onSnapshotChanged` push instead of reacting to `engines-changed` at all.
describe("subscribeToClaudeSnapshotPush (SLICE-CC A4 loop-fix)", () => {
  function fakeBridgeWithCapturedPush(): {
    bridge: Pick<ClaudeBridge, "onSnapshotChanged" | "recheck">;
    fire: (snapshot: ClaudeOnboardingSnapshot) => void;
    recheck: ReturnType<typeof vi.fn>;
  } {
    let handler: ((snapshot: ClaudeOnboardingSnapshot) => void) | undefined;
    const recheck = vi.fn(async () => fakeSnapshot());
    const bridge: Pick<ClaudeBridge, "onSnapshotChanged" | "recheck"> = {
      recheck,
      onSnapshotChanged: (cb) => {
        handler = cb;
        return () => {};
      },
    };
    return {
      bridge,
      recheck,
      fire: (snapshot) => handler?.(snapshot),
    };
  }

  it("an engines-changed-style push must not invoke bridge.recheck — regression test for the CC doctor-spawn loop", () => {
    const { bridge, recheck, fire } = fakeBridgeWithCapturedPush();
    subscribeToClaudeSnapshotPush(bridge, vi.fn());
    fire(fakeSnapshot());
    fire(fakeSnapshot({ report: { status: "signed_out", version: "2.1.212" } }));
    expect(recheck).not.toHaveBeenCalled();
  });

  it("a snapshot-payload push updates the pane's snapshot directly, with zero bridge.recheck calls", () => {
    const { bridge, recheck, fire } = fakeBridgeWithCapturedPush();
    const setSnapshot = vi.fn();
    const unsubscribe = subscribeToClaudeSnapshotPush(bridge, setSnapshot);
    const snapshot = fakeSnapshot();
    fire(snapshot);
    expect(setSnapshot).toHaveBeenCalledWith(snapshot);
    expect(recheck).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("describeClaudeReportStatus", () => {
  it("renders a checking placeholder when no report has arrived yet", () => {
    expect(describeClaudeReportStatus(undefined)).toEqual({ headline: "Checking…", detail: "Diagnosing the Claude Code CLI.", tone: "muted" });
  });

  it("ready", () => {
    const report: ClaudeDoctorReport = { status: "ready", version: "2.1.212" };
    expect(describeClaudeReportStatus(report)).toEqual({ headline: "Ready", detail: "Claude Code 2.1.212", tone: "ok" });
  });

  it("signed_out never leaks any account fact — it isn't on the type at all", () => {
    const report: ClaudeDoctorReport = { status: "signed_out", version: "2.1.212" };
    const result = describeClaudeReportStatus(report);
    expect(result.tone).toBe("warn");
    expect(result.detail).toContain("not signed in");
    expect(JSON.stringify(result)).not.toMatch(/@|subscription|email/i);
  });

  it("update_required names the 2.1.212 floor explicitly", () => {
    const report: ClaudeDoctorReport = { status: "update_required", version: "2.0.9" };
    expect(describeClaudeReportStatus(report).detail).toContain("2.1.212");
  });

  it("not_installed", () => {
    expect(describeClaudeReportStatus({ status: "not_installed" }).tone).toBe("muted");
  });

  it("error surfaces the diagnostic string", () => {
    expect(describeClaudeReportStatus({ status: "error", error: "boom" }).detail).toBe("boom");
  });
});

describe("formatClaudeBinarySourceLabel", () => {
  const cases: Array<[ClaudeOnboardingSnapshot["source"], string]> = [
    ["env", "ANYCODE_CLAUDE_BIN (dev override)"],
    ["settings", "saved path"],
    ["path", "found on PATH"],
    ["common", "found in a common install location"],
    ["picker", "chosen manually"],
    ["none", "not found"],
  ];
  it.each(cases)("%s -> %s", (source, label) => {
    expect(formatClaudeBinarySourceLabel(source)).toBe(label);
  });
});

describe("pickClaudeBinaryFailureMessage", () => {
  it("invalid has a message, cancelled is silent", () => {
    expect(pickClaudeBinaryFailureMessage("invalid")).toMatch(/executable Claude Code binary/);
    expect(pickClaudeBinaryFailureMessage("cancelled")).toBeNull();
  });
});

describe("CLAUDE_PROFILE_LOGIN_COMMAND", () => {
  it("is plain `claude auth login` — ambient by default (owner pivot), no CLAUDE_CONFIG_DIR / stale /login", () => {
    expect(CLAUDE_PROFILE_LOGIN_COMMAND).toBe("claude auth login");
  });
});

// SLICE-CC-LOGIN (TASK.66, cut §7 W3 DoD tests).

describe("canShowSignInButton", () => {
  it("true ONLY for signed_out — every other status (and undefined) is false", () => {
    expect(canShowSignInButton({ status: "signed_out", version: "2.1.212" })).toBe(true);
    expect(canShowSignInButton({ status: "ready", version: "2.1.212" })).toBe(false);
    expect(canShowSignInButton({ status: "not_installed" })).toBe(false);
    expect(canShowSignInButton({ status: "update_required", version: "2.0.0" })).toBe(false);
    expect(canShowSignInButton({ status: "error", error: "boom" })).toBe(false);
    expect(canShowSignInButton(undefined)).toBe(false);
  });
});

// TASK.76 (owner directive 2026-07-19): honest, non-blocking "possible risks" note.

describe("CLAUDE_SUBSCRIPTION_RISK_NOTE", () => {
  it("covers all three verified facts: official CLI as-is with no token custody, shared quota pool, and the gray-zone enforcement risk", () => {
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).toMatch(/official Claude Code CLI/i);
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).toMatch(/never read or store your tokens/i);
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).toMatch(/same subscription quota as claude\.ai and the terminal/i);
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).toMatch(/gray area/i);
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).toMatch(/enforcement without notice is possible/i);
  });

  it("stays an informational note, never alarmist or a demand for consent", () => {
    expect(CLAUDE_SUBSCRIPTION_RISK_NOTE).not.toMatch(/warning|danger|must agree|i understand|confirm/i);
  });
});

describe("CLAUDE_READY_QUOTA_TRACE", () => {
  it("compresses the note to a one-line shared-quota + official-CLI-as-is reminder that survives past sign-in", () => {
    expect(CLAUDE_READY_QUOTA_TRACE).toMatch(/official Claude Code CLI, used as-is/i);
    expect(CLAUDE_READY_QUOTA_TRACE).toMatch(/shared Claude subscription quota/i);
    expect(CLAUDE_READY_QUOTA_TRACE.split("\n")).toHaveLength(1);
  });
});

describe("canShowReadyTrace", () => {
  it("true ONLY for ready — every other status (and undefined) is false", () => {
    expect(canShowReadyTrace({ status: "ready", version: "2.1.212" })).toBe(true);
    expect(canShowReadyTrace({ status: "signed_out", version: "2.1.212" })).toBe(false);
    expect(canShowReadyTrace({ status: "not_installed" })).toBe(false);
    expect(canShowReadyTrace({ status: "update_required", version: "2.0.0" })).toBe(false);
    expect(canShowReadyTrace({ status: "error", error: "boom" })).toBe(false);
    expect(canShowReadyTrace(undefined)).toBe(false);
  });
});

describe("signInButtonDisabled", () => {
  it("disabled while a recheck, a binary pick, or a login attempt is in flight — enabled only when all three are idle", () => {
    expect(signInButtonDisabled(false, false, false)).toBe(false);
    expect(signInButtonDisabled(true, false, false)).toBe(true);
    expect(signInButtonDisabled(false, true, false)).toBe(true);
    expect(signInButtonDisabled(false, false, true)).toBe(true);
  });
});

describe("CLAUDE_LOGIN_IN_PROGRESS_COPY", () => {
  it("matches the cut's exact in-progress copy", () => {
    expect(CLAUDE_LOGIN_IN_PROGRESS_COPY).toBe("A Terminal window has opened — complete sign-in there (your browser will open). Waiting…");
  });
});

describe("loginFailureMessage", () => {
  it("cancelled is silent — the terminal window is not ours to close, nothing actionable to say", () => {
    expect(loginFailureMessage("cancelled")).toBeNull();
  });

  it("busy/unsupported/timeout/failed each carry a distinct, non-null message", () => {
    expect(loginFailureMessage("busy")).toMatch(/already in progress/i);
    expect(loginFailureMessage("timeout")).toMatch(/timed out/i);
    expect(loginFailureMessage("failed")).toMatch(/failed/i);
  });

  it("unsupported points at the manual fallback command still visible on screen", () => {
    expect(loginFailureMessage("unsupported")).toContain(CLAUDE_PROFILE_LOGIN_COMMAND);
  });
});

function fakeSnapshot(overrides: Partial<ClaudeOnboardingSnapshot> = {}): ClaudeOnboardingSnapshot {
  return { report: { status: "ready", version: "2.1.212" }, binaryPath: "/opt/claude", source: "path", checkedAt: "2026-07-19T00:00:00.000Z", ...overrides };
}

describe("runClaudeSignIn", () => {
  it("success: onStart fires before the bridge call resolves, onSuccess receives the fresh snapshot verbatim, onSettle always fires", async () => {
    const order: string[] = [];
    const snapshot = fakeSnapshot();
    const bridge: Pick<ClaudeBridge, "loginStart"> = {
      loginStart: async (): Promise<ClaudeLoginStartResult> => {
        order.push("bridge-called");
        return { ok: true, snapshot };
      },
    };
    let received: ClaudeOnboardingSnapshot | undefined;
    await runClaudeSignIn(bridge, {
      onStart: () => order.push("start"),
      onSuccess: (fresh) => {
        order.push("success");
        received = fresh;
      },
      onFailure: () => order.push("failure"),
      onSettle: () => order.push("settle"),
    });
    expect(order).toEqual(["start", "bridge-called", "success", "settle"]);
    expect(received).toBe(snapshot);
  });

  it.each(["busy", "unsupported", "cancelled", "timeout", "failed"] as const)(
    "failure (%s): onFailure receives loginFailureMessage's projection, onSettle still fires, onSuccess never fires",
    async (reason) => {
      const order: string[] = [];
      const bridge: Pick<ClaudeBridge, "loginStart"> = { loginStart: async () => ({ ok: false, reason }) };
      let failureMessage: string | null | undefined;
      await runClaudeSignIn(bridge, {
        onStart: () => order.push("start"),
        onSuccess: () => order.push("success"),
        onFailure: (message) => {
          order.push("failure");
          failureMessage = message;
        },
        onSettle: () => order.push("settle"),
      });
      expect(order).toEqual(["start", "failure", "settle"]);
      expect(failureMessage).toBe(loginFailureMessage(reason));
    },
  );

  it("onSettle fires even when the bridge call throws", async () => {
    const bridge: Pick<ClaudeBridge, "loginStart"> = {
      loginStart: async () => {
        throw new Error("boom");
      },
    };
    const onSettle = vi.fn();
    await expect(
      runClaudeSignIn(bridge, { onStart: () => {}, onSuccess: () => {}, onFailure: () => {}, onSettle }),
    ).rejects.toThrow("boom");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe("cancelClaudeSignIn", () => {
  it("forwards to bridge.loginCancel and nothing else", () => {
    const loginCancel = vi.fn(async () => {});
    cancelClaudeSignIn({ loginCancel });
    expect(loginCancel).toHaveBeenCalledTimes(1);
    expect(loginCancel).toHaveBeenCalledWith();
  });
});
