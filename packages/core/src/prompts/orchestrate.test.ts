/**
 * Taskana 4704 §3.4: the orchestrate reminder mirrors plan-reminder.ts —
 * these tests pin the tag shape (both transcript sanitizers strip exactly
 * `<orchestrate-reminder>`) and the core facts the desktop host depends on.
 */
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_REMINDER, withOrchestrateReminder } from "./orchestrate.js";
import * as barrel from "../index.js";
import { sanitizeTitleSource, deriveSessionTitle } from "../context/session-title.js";

describe("withOrchestrateReminder", () => {
  it("appends the reminder inside a paired <orchestrate-reminder> tag, after the user's own text", () => {
    expect(withOrchestrateReminder("ship the feature")).toBe(
      `ship the feature\n<orchestrate-reminder>\n${ORCHESTRATE_REMINDER}\n</orchestrate-reminder>`,
    );
  });

  it("names the roles and the detach discipline the orchestrator must follow", () => {
    expect(ORCHESTRATE_REMINDER).toContain("planner");
    expect(ORCHESTRATE_REMINDER).toContain("executor");
    expect(ORCHESTRATE_REMINDER).toContain("reviewer");
    expect(ORCHESTRATE_REMINDER).toContain("explore");
    expect(ORCHESTRATE_REMINDER).toContain("detach true");
  });

  it("leaves an empty prompt's tag intact (pure string function, no trimming)", () => {
    expect(withOrchestrateReminder("")).toBe(
      `\n<orchestrate-reminder>\n${ORCHESTRATE_REMINDER}\n</orchestrate-reminder>`,
    );
  });
});

describe("sanitizer strips the orchestrate reminder", () => {
  it("sanitizeTitleSource removes the paired tag block entirely", () => {
    const sanitized = sanitizeTitleSource(withOrchestrateReminder("Refactor the settings screen"));
    expect(sanitized).not.toContain("orchestrate-reminder");
    expect(sanitized).not.toContain(ORCHESTRATE_REMINDER);
    expect(sanitized.trim()).toBe("Refactor the settings screen");
  });

  it("a derived title never leaks the reminder text", () => {
    const title = deriveSessionTitle(sanitizeTitleSource(withOrchestrateReminder("Refactor the settings screen")));
    expect(title).toBe("Refactor the settings screen");
  });
});

describe("core barrel reachability", () => {
  it("exports withOrchestrateReminder", () => {
    expect(barrel.withOrchestrateReminder).toBe(withOrchestrateReminder);
  });
});
