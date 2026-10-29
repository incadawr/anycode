import { describe, expect, it, vi } from "vitest";
import { closeSessionForAgent } from "./communication-close-session.js";

describe("main close_session gate", () => {
  function fixture(state = "idle") {
    const opened = new Set(["agent"]);
    const live: Array<{ tabId: string; sessionId: string; workspace: string; state?: string }> = [{ tabId: "tab", sessionId: "agent", workspace: "/ws" }, { tabId: "user-tab", sessionId: "user", workspace: "/ws" }];
    const manager = {
      listTabs: () => live,
      communicationRequest: vi.fn(async () => ({ state })),
      closeTab: vi.fn(async (id: string) => { live.splice(live.findIndex((t) => t.tabId === id), 1); return { ok: true as const }; }),
    };
    const closed = vi.fn();
    return { opened, manager, closed, close: (id: string) => closeSessionForAgent(manager, opened, id, closed) };
  }
  it("refuses user-opened and unknown tabs without touching their hosts", async () => {
    const f = fixture();
    expect(await f.close("user")).toEqual({ ok: false, reason: "not_agent_opened" });
    expect(await f.close("missing")).toEqual({ ok: false, reason: "not_found" });
    expect(f.manager.communicationRequest).not.toHaveBeenCalled();
    expect(f.manager.closeTab).not.toHaveBeenCalled();
  });
  it("refuses a running turn (cancel_turn must precede close)", async () => {
    const f = fixture("running");
    expect(await f.close("agent")).toEqual({ ok: false, reason: "busy" });
    expect(f.manager.closeTab).not.toHaveBeenCalled();
    expect(f.opened.size).toBe(1);
  });
  it("refuses an approval-waiting session as busy", async () => {
    const f = fixture("waiting_approval");
    expect(await f.close("agent")).toEqual({ ok: false, reason: "busy" });
    expect(f.manager.closeTab).not.toHaveBeenCalled();
  });
  it("rechecks turn state immediately before closing: idle then running refuses busy", async () => {
    const f = fixture();
    f.manager.communicationRequest.mockResolvedValueOnce({ state: "idle" }).mockResolvedValueOnce({ state: "running" });
    expect(await f.close("agent")).toEqual({ ok: false, reason: "busy" });
    expect(f.manager.communicationRequest).toHaveBeenCalledTimes(2);
    expect(f.manager.closeTab).not.toHaveBeenCalled();
    expect(f.opened.size).toBe(1);
    expect(f.closed).not.toHaveBeenCalled();
  });
  it("uses UI closeTab, frees agent bookkeeping and notifies renderer only on success", async () => {
    const f = fixture();
    expect(await f.close("agent")).toEqual({ ok: true });
    expect(f.manager.closeTab).toHaveBeenCalledWith("tab");
    expect(f.opened.size).toBe(0);
    expect(f.closed).toHaveBeenCalledWith("tab");
    expect(await f.close("agent")).toEqual({ ok: false, reason: "not_found" });
  });
  it("preserves the alive count and renderer when the UI close path refuses", async () => {
    const opened = new Set(["agent"]);
    const notify = vi.fn();
    const manager = {
      listTabs: () => [{ tabId: "tab", sessionId: "agent", workspace: "/ws", state: "running" }],
      communicationRequest: async () => ({ state: "idle" }),
      closeTab: async () => ({ ok: false as const, reason: "last_tab" as const }),
    };
    expect(await closeSessionForAgent(manager, opened, "agent", notify)).toEqual({ ok: false, reason: "last_tab" });
    expect(opened.size).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("refuses a concurrent close after the tab has been sealed", async () => {
    const f = fixture();
    f.manager.listTabs()[0]!.state = "closing";
    expect(await f.close("agent")).toEqual({ ok: false, reason: "not_found" });
    expect(f.manager.closeTab).not.toHaveBeenCalled();
  });
  it("fails closed when the host status cannot be checked", async () => {
    const f = fixture();
    f.manager.communicationRequest.mockRejectedValueOnce(new Error("gone"));
    expect(await f.close("agent")).toEqual({ ok: false, reason: "busy" });
    expect(f.manager.closeTab).not.toHaveBeenCalled();
  });

  it("closes a definitively crash-looped tab without an idle-host RPC", async () => {
    const f = fixture();
    f.manager.listTabs()[0]!.state = "crash_looped";
    expect(await f.close("agent")).toEqual({ ok: true });
    expect(f.manager.communicationRequest).not.toHaveBeenCalled();
    expect(f.manager.closeTab).toHaveBeenCalledWith("tab");
    expect(f.opened.size).toBe(0);
    expect(f.closed).toHaveBeenCalledWith("tab");
  });

  it("keeps a crash-looped tab's bookkeeping when the UI close path refuses", async () => {
    const opened = new Set(["agent"]);
    const notify = vi.fn();
    const manager = {
      listTabs: () => [{ tabId: "tab", sessionId: "agent", workspace: "/ws", state: "crash_looped" }],
      communicationRequest: vi.fn(async () => ({ state: "idle" })),
      closeTab: vi.fn(async () => ({ ok: false as const, reason: "last_tab" as const })),
    };
    expect(await closeSessionForAgent(manager, opened, "agent", notify)).toEqual({ ok: false, reason: "last_tab" });
    expect(manager.communicationRequest).not.toHaveBeenCalled();
    expect(opened.size).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still refuses a concurrent close of a crash-looped tab once sealed", async () => {
    const f = fixture();
    f.manager.listTabs()[0]!.state = "closing";
    expect(await f.close("agent")).toEqual({ ok: false, reason: "not_found" });
    expect(f.manager.closeTab).not.toHaveBeenCalled();
  });
});
