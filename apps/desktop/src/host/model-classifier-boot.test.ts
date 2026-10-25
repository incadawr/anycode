/**
 * Taskana 4730 xfix D4: the model-kind classifier's connection pinning must be
 * HONEST. An explicit `connectionId` the fork cannot resolve turns the
 * classifier OFF with a user-visible notice — never a silent fallback to the
 * session's own connection (the pre-fix behavior billed the WRONG connection),
 * and never a model resolved against a DIFFERENT connection than the one named.
 *
 * The resolution itself lives in a pure helper (model-classifier-boot.ts) so
 * this file pins the decision table without booting a host.
 */

import { describe, expect, it } from "vitest";
import { resolveModelClassifierBoot, type ModelClassifierPortSource } from "./model-classifier-boot.js";

/** A port source that hands out labeled fake ports and records what was asked. */
function makePortSource(models: readonly string[]): ModelClassifierPortSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    allowedModels: () => [...models],
    // The factory closes over the SESSION's connection — exactly the limited
    // resolution a fork has (main resolves connections, not the host).
    portFor: (model: string) => {
      asked.push(model);
      return { tag: "session-connection-port", model } as never;
    },
  };
}

describe("resolveModelClassifierBoot (Taskana 4730 xfix D4)", () => {
  it("no connectionId, no model: the session's own switchable port, session's model", () => {
    const source = makePortSource(["m-main"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.model).toBe("m-main");
      expect(boot.usesSessionPort).toBe(true);
    }
    expect(source.asked).toEqual([]);
  });

  it("a model without connectionId: validated against the session connection, factory-built port", () => {
    const source = makePortSource(["m-main", "glm-4.7-flash"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", model: "glm-4.7-flash" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.model).toBe("glm-4.7-flash");
      expect(boot.usesSessionPort).toBe(false);
    }
    expect(source.asked).toEqual(["glm-4.7-flash"]);
  });

  it("a model NOT on the session connection: classifier OFF with a notice naming the model", () => {
    const source = makePortSource(["m-main"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", model: "glm-4.7-flash" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(false);
    if (!boot.ok) {
      expect(boot.notice).toContain("glm-4.7-flash");
    }
  });

  it("a connectionId PINNED to the session's own active connection resolves (same account)", () => {
    const source = makePortSource(["m-main"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", connectionId: "conn-main" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(true);
  });

  it("a connectionId that names ANOTHER connection: classifier OFF — never silently the session's own (D4)", () => {
    const source = makePortSource(["m-main", "glm-4.7-flash"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", connectionId: "conn-cheap" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(false);
    if (!boot.ok) {
      expect(boot.notice).toContain("conn-cheap");
    }
    // Crucially: no port was built and the session's own port was NOT used.
    expect(source.asked).toEqual([]);
  });

  it("BOTH connectionId and model naming a foreign connection: OFF — the model is never resolved against the session's connection (D4)", () => {
    // Pre-fix behavior: modelPortFactory(model) resolved "glm-4.7-flash"
    // against the SESSION's connection even though the user pinned
    // conn-cheap — billing the wrong account.
    const source = makePortSource(["m-main", "glm-4.7-flash"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", connectionId: "conn-cheap", model: "glm-4.7-flash" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(false);
    if (!boot.ok) {
      expect(boot.notice).toContain("conn-cheap");
    }
    expect(source.asked).toEqual([]);
  });

  it("both fields naming the ACTIVE connection resolves normally", () => {
    const source = makePortSource(["m-main", "glm-4.7-flash"]);
    const boot = resolveModelClassifierBoot(
      { kind: "model", connectionId: "conn-main", model: "glm-4.7-flash" },
      { source, sessionModel: "m-main", activeConnectionId: "conn-main" },
    );
    expect(boot.ok).toBe(true);
    expect(source.asked).toEqual(["glm-4.7-flash"]);
  });
});
