import { describe, expect, it } from "vitest";
import { creationAdmissionFor } from "./communication-creation-admission.js";

describe("creation reservation", () => {
  it("holds admission across a caller abort until creation settles, without retrying", async () => {
    const owned = new Set<string>();
    const tabs: { sessionId: string }[] = [];
    const admission = creationAdmissionFor(owned, () => tabs);
    let settle!: () => void;
    let forks = 0;
    const pending = admission.run(async () => {
      forks++;
      await new Promise<void>(resolve => { settle = resolve; });
      tabs.push({ sessionId: "one" });
      return { ok: true, sessionId: "one", tabId: "tab-one" };
    });
    const caller = new AbortController();
    const response = Promise.race([pending, new Promise<string>(resolve => caller.signal.addEventListener("abort", () => resolve("unknown")))]);
    await Promise.resolve();
    caller.abort();
    expect(await response).toBe("unknown");
    let entered = false;
    const next = admission.run(async () => { entered = true; return { ok: false, reason: "not_ready" }; });
    await Promise.resolve();
    expect(entered).toBe(false);
    expect(forks).toBe(1);
    settle();
    expect(await pending).toMatchObject({ sessionId: "one", tabId: "tab-one" });
    await next;
    expect(forks).toBe(1);
  });
  it("refuses nested admission explicitly and still accepts later calls", async () => {
    const admission = creationAdmissionFor(new Set(), () => []);
    await admission.run(async () => {
      await Promise.resolve();
      await expect(admission.run(async () => ({ ok: false, reason: "not_ready" }))).rejects.toThrow("Nested creation admission");
      return { ok: true, sessionId: "one", tabId: "tab-one" };
    });
    expect(await admission.run(async () => ({ ok: true, sessionId: "two", tabId: "tab-two" }))).toMatchObject({ ok: true });
  });
  it("enforces eight live sessions across rate windows and frees closed slots", async () => {
    const owned = new Set<string>();
    const tabs: { sessionId: string }[] = [];
    let now = 0;
    let forks = 0;
    const admission = creationAdmissionFor(owned, () => tabs, () => now);
    const create = () => admission.run(async () => {
      const sessionId = String(++forks);
      tabs.push({ sessionId });
      return { ok: true, sessionId, tabId: `tab-${sessionId}` };
    });
    for (let i = 0; i < 5; i++) expect((await create()).ok).toBe(true);
    now = 60_001;
    const outcomes = await Promise.all(Array.from({ length: 5 }, create));
    expect(outcomes.filter(o => o.ok)).toHaveLength(3);
    expect(outcomes.filter(o => !o.ok && o.reason === "too_many")).toHaveLength(2);
    expect(forks).toBe(8);
    tabs.shift();
    expect((await create()).ok).toBe(true);
    expect(forks).toBe(9);
  });
  it("does not charge rejected or thrown preparation against the rate window", async () => {
    const admission = creationAdmissionFor(new Set(), () => []);
    for (let i = 0; i < 8; i++) {
      await expect(admission.run(async () => { throw new Error("pin failed"); })).rejects.toThrow("pin failed");
      expect(await admission.run(async () => ({ ok: false, reason: "not_ready" }))).toMatchObject({ reason: "not_ready" });
    }
    expect(await admission.run(async () => ({ ok: true, sessionId: "accepted", tabId: "real" }))).toMatchObject({ ok: true });
  });
});
