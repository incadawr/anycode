/**
 * Taskana 4702 Stage 1: the optional `permissions.classifier` settings key.
 * Absent = off and round-trips absent; a valid record parses; an invalid
 * record is dropped ALONE (the classifier stays off) without disturbing the
 * sibling `alwaysAllow` rules. No version bump (additive-optional).
 */

import { describe, expect, it } from "vitest";
import { cloneDefaults, parseSettings } from "./schema.js";

function docWith(permissions: Record<string, unknown>): Record<string, unknown> {
  return { ...cloneDefaults(), permissions };
}

describe("permissions.classifier (Taskana 4702)", () => {
  it("absent: the key is off and round-trips absent (no version bump)", () => {
    const parsed = parseSettings(cloneDefaults());
    expect(parsed.status).toBe("ok");
    expect(parsed.settings.permissions.classifier).toBeUndefined();
    expect(parsed.settings.version).toBe(cloneDefaults().version);
  });

  it("a valid record parses and keeps every field", () => {
    const parsed = parseSettings(
      docWith({
        alwaysAllow: [],
        classifier: { enabled: true, kind: "command", command: "/usr/local/bin/da --json", timeoutMs: 3000 },
      }),
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.settings.permissions.classifier).toEqual({
      enabled: true,
      kind: "command",
      command: "/usr/local/bin/da --json",
      timeoutMs: 3000,
    });
  });

  it("a disabled record parses (enabled:false stays off)", () => {
    const parsed = parseSettings(
      docWith({ alwaysAllow: [], classifier: { enabled: false, kind: "command", command: "da" } }),
    );
    expect(parsed.settings.permissions.classifier?.enabled).toBe(false);
  });

  it.each([
    ["unknown kind", { enabled: true, kind: "llm", command: "da" }],
    ["enabled not a boolean", { enabled: "yes", kind: "command", command: "da" }],
    ["missing command", { enabled: true, kind: "command" }],
    ["non-integer timeout", { enabled: true, kind: "command", command: "da", timeoutMs: 1.5 }],
    ["zero timeout", { enabled: true, kind: "command", command: "da", timeoutMs: 0 }],
  ])("an invalid record (%s) is dropped alone: classifier off, alwaysAllow intact", (_label, bad) => {
    const parsed = parseSettings(
      docWith({ alwaysAllow: [{ toolName: "Grep" }], classifier: bad }),
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.settings.permissions.classifier).toBeUndefined();
    expect(parsed.settings.permissions.alwaysAllow).toEqual([{ toolName: "Grep" }]);
  });
});
