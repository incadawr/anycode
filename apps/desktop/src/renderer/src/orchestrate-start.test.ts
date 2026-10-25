/**
 * Pure-logic tests for the start-screen Orchestrate helpers (orchestrate-start.ts):
 * the `/orchestrate <task>` recognizer, the send plan, the first-run role-picker
 * gate, the slash hint, and the Orchestrate row's wiring. Node-env vitest (no
 * jsdom), so every decision is exercised directly.
 */
import { describe, expect, it } from "vitest";
import {
  needsRolePicker,
  parseOrchestrateSlash,
  resolveStartOrchestrate,
  startDraftOrchestrateRowProps,
  startOrchestrateHint,
  startSendNeedsRolePicker,
} from "./orchestrate-start.js";

const ROLES = { executor: { primary: { engine: "claude" as const } } };

describe("parseOrchestrateSlash", () => {
  it("parses a leading /orchestrate token and returns the trimmed task after it", () => {
    expect(parseOrchestrateSlash("/orchestrate   refactor the parser  ")).toEqual({ task: "refactor the parser" });
  });

  it("accepts a newline as the separator after the token", () => {
    expect(parseOrchestrateSlash("/orchestrate\nfix tests")).toEqual({ task: "fix tests" });
  });

  it("returns an empty task for a bare /orchestrate (refused later, never a send)", () => {
    expect(parseOrchestrateSlash("/orchestrate")).toEqual({ task: "" });
  });

  it("ignores the token when it is not at the very start, or is a longer word", () => {
    expect(parseOrchestrateSlash("please /orchestrate x")).toBeNull();
    expect(parseOrchestrateSlash("/orchestrateall x")).toBeNull();
    expect(parseOrchestrateSlash("/orch x")).toBeNull();
  });
});

describe("resolveStartOrchestrate", () => {
  it("a /orchestrate token on a core draft turns orchestrate on and sends only the task", () => {
    expect(resolveStartOrchestrate("core", undefined, "/orchestrate map the modules")).toEqual({
      orchestrate: true,
      text: "map the modules",
      bareSlash: false,
    });
  });

  it("the draft's own Orchestrate toggle is honored for a plain message on a core draft", () => {
    expect(resolveStartOrchestrate("core", true, "map the modules")).toEqual({
      orchestrate: true,
      text: "map the modules",
      bareSlash: false,
    });
  });

  it("a plain message on a core draft without the toggle is an ordinary send", () => {
    expect(resolveStartOrchestrate("core", false, "hello")).toEqual({ orchestrate: false, text: "hello", bareSlash: false });
    expect(resolveStartOrchestrate("core", undefined, "hello")).toEqual({ orchestrate: false, text: "hello", bareSlash: false });
  });

  it("orchestrate is core-only: a Codex or Claude draft never orchestrates, and the token is sent literally", () => {
    expect(resolveStartOrchestrate("codex", true, "/orchestrate x")).toEqual({
      orchestrate: false,
      text: "/orchestrate x",
      bareSlash: false,
    });
    expect(resolveStartOrchestrate("claude", true, "hello")).toEqual({ orchestrate: false, text: "hello", bareSlash: false });
  });

  it("a bare /orchestrate is flagged so the caller refuses it", () => {
    expect(resolveStartOrchestrate("core", undefined, "/orchestrate  ")).toMatchObject({ bareSlash: true });
  });
});

describe("needsRolePicker / startSendNeedsRolePicker (first-run role gate)", () => {
  it("roles never configured (undefined) means the picker is needed", () => {
    expect(needsRolePicker(undefined)).toBe(true);
    expect(needsRolePicker(ROLES)).toBe(false);
    expect(needsRolePicker({})).toBe(false);
  });

  it("an orchestrating send with a task and no roles blocks on the picker", () => {
    const plan = resolveStartOrchestrate("core", undefined, "/orchestrate do the thing");
    expect(startSendNeedsRolePicker(plan, undefined)).toBe(true);
  });

  it("an orchestrating send proceeds straight through when roles already exist", () => {
    const plan = resolveStartOrchestrate("core", true, "do the thing");
    expect(startSendNeedsRolePicker(plan, ROLES)).toBe(false);
  });

  it("a plain send never opens the picker, roles or not", () => {
    const plan = resolveStartOrchestrate("core", false, "do the thing");
    expect(startSendNeedsRolePicker(plan, undefined)).toBe(false);
  });

  it("a bare /orchestrate does not open the picker (it is refused instead)", () => {
    const plan = resolveStartOrchestrate("core", undefined, "/orchestrate");
    expect(startSendNeedsRolePicker(plan, undefined)).toBe(false);
  });
});

describe("startOrchestrateHint", () => {
  it("shows while a core draft starts like the command but has not reached a task", () => {
    expect(startOrchestrateHint("core", "/orch")).toBe(true);
    expect(startOrchestrateHint("core", "/orchestrate")).toBe(true);
  });

  it("hides once a task follows the token, for a non-slash draft, and for non-core engines", () => {
    expect(startOrchestrateHint("core", "/orchestrate do x")).toBe(false);
    expect(startOrchestrateHint("core", "hello /orch")).toBe(false);
    expect(startOrchestrateHint("codex", "/orch")).toBe(false);
    expect(startOrchestrateHint("claude", "/orch")).toBe(false);
  });
});

describe("startDraftOrchestrateRowProps (the start-screen Orchestrate row wiring)", () => {
  it("core drafts get the row's state and a handler that forwards the next value", () => {
    const seen: boolean[] = [];
    const props = startDraftOrchestrateRowProps("core", true, (next) => seen.push(next));
    expect(props).toBeDefined();
    expect(props!.orchestrateActive).toBe(true);
    props!.onToggleOrchestrate(false);
    expect(seen).toEqual([false]);
  });

  it("an unset draft flag reads as off", () => {
    expect(startDraftOrchestrateRowProps("core", undefined, () => {})!.orchestrateActive).toBe(false);
  });

  it("Codex and Claude drafts get no row props at all (the row is hidden, as in-tab)", () => {
    expect(startDraftOrchestrateRowProps("codex", true, () => {})).toBeUndefined();
    expect(startDraftOrchestrateRowProps("claude", undefined, () => {})).toBeUndefined();
  });
});
