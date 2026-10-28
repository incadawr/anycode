import { describe, expect, it, vi } from "vitest";
import {
  createAgentTitlePushes,
  isEnvelopeDerivedTitle,
  recoverAgentSessionTitle,
} from "./agent-session-title.js";

/** Lets the retainer's fire-and-forget push settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent title pushes", () => {
  it("retains a title whose push lost its host and retries it on the next host generation", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Host disconnected; delivery unknown"))
      .mockResolvedValueOnce({});
    const warn = vi.fn();
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn });

    pushes.retain("s1");
    await settle();
    expect(request).toHaveBeenCalledWith("s1", "worker-1");
    // A rejected push is NOT an acknowledgement: the handle stays retained.
    expect(pushes.pendingSessions()).toEqual(["s1"]);

    // The replacement host generation delivers its port -> retry.
    pushes.retry("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    // Only the host's committed write clears it.
    expect(pushes.pendingSessions()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not push the same session twice while one attempt is in flight", async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn: vi.fn() });

    pushes.retain("s1");
    pushes.retry("s1");
    pushes.push("s1");
    expect(request).toHaveBeenCalledTimes(1);

    release({});
    await settle();
    expect(pushes.pendingSessions()).toEqual([]);
  });

  it("never resurrects the title of a session that is gone", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Host disconnected; delivery unknown"));
    const pushes = createAgentTitlePushes({ titleOf: () => "worker-1", request, warn: vi.fn() });

    pushes.retain("s1");
    await settle();
    pushes.forget("s1");
    pushes.retry("s1");
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(pushes.pendingSessions()).toEqual([]);
  });
});

describe("resume-time agent title recovery", () => {
  // A payload-derived title is the envelope's first line CAPPED, so it is a
  // prefix of the header and not a whole envelope.
  const FALLBACK_TITLE = '[AnyCode authenticated agent message {"messageId":"m1","sender":"supervisor"'.slice(0, 80);

  it("repairs a pre-fix session whose persisted title is the payload fallback", async () => {
    const adopted: string[] = [];
    const repaired = await recoverAgentSessionTitle({
      sessionId: "s1",
      savedHandle: () => "worker-1",
      readPersistedTitle: async () => FALLBACK_TITLE,
      adopt: (title) => adopted.push(title),
    });
    expect(repaired).toBe(true);
    expect(adopted).toEqual(["worker-1"]);
  });

  it("leaves a title the user chose alone", async () => {
    const adopted: string[] = [];
    const repaired = await recoverAgentSessionTitle({
      sessionId: "s1",
      savedHandle: () => "worker-1",
      readPersistedTitle: async () => "Company profile design",
      adopt: (title) => adopted.push(title),
    });
    expect(repaired).toBe(false);
    expect(adopted).toEqual([]);
  });

  it("does nothing for a session without a saved handle", async () => {
    const adopt = vi.fn();
    const repaired = await recoverAgentSessionTitle({
      sessionId: "s1",
      savedHandle: () => undefined,
      readPersistedTitle: async () => FALLBACK_TITLE,
      adopt,
    });
    expect(repaired).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("does nothing (and never blocks a resume) when the session row cannot be read", async () => {
    const adopt = vi.fn();
    const repaired = await recoverAgentSessionTitle({
      sessionId: "s1",
      savedHandle: () => "worker-1",
      readPersistedTitle: async () => { throw new Error("SQLITE_BUSY"); },
      adopt,
    });
    expect(repaired).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("recognises only the envelope header prefix as a payload-derived title", () => {
    expect(isEnvelopeDerivedTitle(FALLBACK_TITLE)).toBe(true);
    expect(isEnvelopeDerivedTitle('[AnyCode authenticated agent message {"a":1}]\nFix the sidebar')).toBe(true);
    expect(isEnvelopeDerivedTitle("Fix the sidebar")).toBe(false);
    expect(isEnvelopeDerivedTitle("AnyCode authenticated agent message")).toBe(false);
    expect(isEnvelopeDerivedTitle(undefined)).toBe(false);
  });
});
