/**
 * TASK.95 — CollabAgentCardIndex unit tests.
 *
 * The index is the session-lifetime correlation seam: registration, reverse
 * agentThreadId -> card mapping, sparse receiver/model merge, independent
 * cards, multi-receiver aggregation, terminal precedence, state observation
 * without premature settle, the exactly-once terminal latch, correlation
 * retained across turns, and clear() isolation.
 */
import { describe, expect, it } from "vitest";
import { CollabAgentCardIndex } from "./collab-agent-index.js";

describe("TASK.95 — CollabAgentCardIndex", () => {
  it("registers a card and exposes it plus its reverse receiver mapping", () => {
    const index = new CollabAgentCardIndex();
    const card = index.register("spawn-1", { prompt: "do the thing", model: "gpt-5.4-codex", receiverThreadIds: ["child-1"] });
    expect(card).toMatchObject({ cardId: "spawn-1", prompt: "do the thing", model: "gpt-5.4-codex", terminalEmitted: false });
    expect(card.receiverThreadIds).toEqual(["child-1"]);
    expect(index.get("spawn-1")).toBe(card);
    expect(index.cardFor("child-1")).toBe("spawn-1");
    expect(index.cardFor("unknown")).toBeUndefined();
  });

  it("merges sparse metadata and unions receiver ids without overwriting known prompt/model", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { prompt: "keep me", model: "gpt-5.4-codex", receiverThreadIds: ["child-1"] });
    // A completing snapshot that is sparse (no prompt/model) plus a second receiver.
    index.merge("spawn-1", { prompt: null, model: null, receiverThreadIds: ["child-2", "child-1"] });
    const card = index.get("spawn-1")!;
    expect(card.prompt).toBe("keep me");
    expect(card.model).toBe("gpt-5.4-codex");
    expect(card.receiverThreadIds).toEqual(["child-1", "child-2"]);
    expect(index.cardFor("child-2")).toBe("spawn-1");
  });

  it("fills an initially-unknown prompt/model from a later populated snapshot", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["child-1"] });
    index.merge("spawn-1", { prompt: "late prompt", model: "gpt-late" });
    expect(index.get("spawn-1")).toMatchObject({ prompt: "late prompt", model: "gpt-late" });
  });

  it("keeps different spawn cards independent", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["child-1"] });
    index.register("spawn-2", { receiverThreadIds: ["child-2"] });
    index.observeStates("spawn-1", { "child-1": { status: "completed" } });
    expect(index.terminalFor("spawn-1")).toBe("completed");
    expect(index.terminalFor("spawn-2")).toBeNull();
    expect(index.cardFor("child-2")).toBe("spawn-2");
  });

  it("does not settle on the first receiver while another is running or unobserved", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a", "b"] });
    index.observeStates("spawn-1", { a: { status: "completed" } });
    expect(index.terminalFor("spawn-1")).toBeNull();
    index.observeStates("spawn-1", { b: { status: "running" } });
    expect(index.terminalFor("spawn-1")).toBeNull();
    index.observeStates("spawn-1", { b: { status: "completed" } });
    expect(index.terminalFor("spawn-1")).toBe("completed");
  });

  it("aggregates multiple receivers with error > cancelled > completed precedence", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a", "b", "c"] });
    index.observeStates("spawn-1", { a: { status: "completed" }, b: { status: "shutdown" }, c: { status: "completed" } });
    expect(index.terminalFor("spawn-1")).toBe("cancelled");
    index.observeStates("spawn-1", { b: { status: "errored" } });
    expect(index.terminalFor("spawn-1")).toBe("error");
  });

  it("treats pendingInit/running/interrupted/notFound/unknown states as non-terminal observations", () => {
    for (const status of ["pendingInit", "running", "interrupted", "notFound", "someFutureStatus"]) {
      const index = new CollabAgentCardIndex();
      index.register("spawn-1", { receiverThreadIds: ["a"] });
      index.observeStates("spawn-1", { a: { status } });
      expect(index.terminalFor("spawn-1")).toBeNull();
    }
  });

  it("never fabricates terminal state for missing or malformed state entries", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a", "b"] });
    index.observeStates("spawn-1", { a: { status: "completed" } });
    // b unobserved -> no aggregate terminal.
    expect(index.terminalFor("spawn-1")).toBeNull();
  });

  it("latches the terminal exactly once and cannot resurrect after settling", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a"] });
    index.observeStates("spawn-1", { a: { status: "completed" } });
    expect(index.hasTerminal("spawn-1")).toBe(false);
    index.markTerminal("spawn-1");
    expect(index.hasTerminal("spawn-1")).toBe(true);
    // A later observation cannot clear the latch.
    index.observeStates("spawn-1", { a: { status: "running" } });
    index.markTerminal("spawn-1");
    expect(index.hasTerminal("spawn-1")).toBe(true);
  });

  it("retains mapping across turns and hasObservedChild tracks any observed state", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a"] });
    expect(index.hasObservedChild("spawn-1")).toBe(false);
    index.observeStates("spawn-1", { a: { status: "running", message: "working" } });
    expect(index.hasObservedChild("spawn-1")).toBe(true);
    // Still correlate in a "later turn" — nothing here is turn-scoped.
    expect(index.cardFor("a")).toBe("spawn-1");
    expect(index.stateFor("spawn-1", "a")).toEqual({ status: "running", message: "working" });
  });

  it("is deterministic for duplicate/malformed receiver ids — first card keeps the mapping", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["dup"] });
    index.register("spawn-2", { receiverThreadIds: ["dup"] });
    expect(index.cardFor("dup")).toBe("spawn-1");
    // Empty/malformed ids never enter the mapping.
    index.mergeReceivers("spawn-1", ["", "next"]);
    expect(index.cardFor("")).toBeUndefined();
    expect(index.cardFor("next")).toBe("spawn-1");
  });

  it("clears all correlation without touching anything else", () => {
    const index = new CollabAgentCardIndex();
    index.register("spawn-1", { receiverThreadIds: ["a"] });
    index.markTerminal("spawn-1");
    index.clear();
    expect(index.get("spawn-1")).toBeUndefined();
    expect(index.cardFor("a")).toBeUndefined();
    expect(index.hasTerminal("spawn-1")).toBe(false);
  });

  it("treats unknown card ids as deterministic no-ops", () => {
    const index = new CollabAgentCardIndex();
    index.merge("ghost", { prompt: "x", receiverThreadIds: ["a"] });
    index.observeStates("ghost", { a: { status: "completed" } });
    index.markTerminal("ghost");
    expect(index.get("ghost")).toBeUndefined();
    expect(index.cardFor("a")).toBeUndefined();
    expect(index.terminalFor("ghost")).toBeNull();
  });
});
