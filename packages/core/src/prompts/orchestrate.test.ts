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

  it("keeps the Settings role routes authoritative over engine-named project profiles", () => {
    expect(ORCHESTRATE_REMINDER).toContain("pass exactly one of these four role names as agent_type");
    expect(ORCHESTRATE_REMINDER).toContain("that routing is authoritative");
    // Never an UNCONDITIONAL instruction: the role-route rule is explicitly
    // subordinate to the user naming a profile/engine. Before, "always pass one of the four" contradicted the very
    // next sentence and a request to use `claude` got incompatible orders.
    expect(ORCHESTRATE_REMINDER).toContain("When the user has not asked for a named profile or engine");
    expect(ORCHESTRATE_REMINDER).not.toContain("Always pass exactly one");
    expect(ORCHESTRATE_REMINDER).not.toContain("always pass exactly one");
  });

  it("states the explicit-profile exception without contradicting the four-role rule", () => {
    // The exception itself: a named profile/engine request WINS, and using that
    // profile is what the user asked for rather than a substitution.
    expect(ORCHESTRATE_REMINDER).toContain("only when the user explicitly asks for that profile or engine by name");
    expect(ORCHESTRATE_REMINDER).toContain("not a substitution for a role");
    // …while the self-initiative ban stays unconditional.
    expect(ORCHESTRATE_REMINDER).toContain("Never pick such a profile on your own initiative");
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
