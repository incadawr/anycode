/**
 * Taskana 4702 Stage 1: the host-side reader for ANYCODE_PERMISSION_CLASSIFIER.
 * Pins the fail-closed contract: unset, empty, garbage JSON, a disabled record,
 * an invalid shape, or an empty command all yield NO classifier (off), never a
 * partial one. A valid enabled record yields a command classifier with the
 * configured argv and timeout.
 */

import { describe, expect, it } from "vitest";
import { parseAskClassifierEnv } from "./ask-classifier-env.js";

describe("parseAskClassifierEnv (Taskana 4702)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["garbage JSON", "{not json"],
    ["JSON array", "[1,2]"],
    ["disabled", JSON.stringify({ enabled: false, kind: "command", command: "da" })],
    ["unknown kind", JSON.stringify({ enabled: true, kind: "model", command: "da" })],
    ["blank command", JSON.stringify({ enabled: true, kind: "command", command: "   " })],
    ["missing enabled", JSON.stringify({ kind: "command", command: "da" })],
    ["bad timeout", JSON.stringify({ enabled: true, kind: "command", command: "da", timeoutMs: -5 })],
  ])("%s => no classifier (off)", (_label, raw) => {
    expect(parseAskClassifierEnv(raw)).toBeUndefined();
  });

  it("a valid enabled record yields a command classifier with its timeout", () => {
    const boot = parseAskClassifierEnv(
      JSON.stringify({ enabled: true, kind: "command", command: "/opt/da --json", timeoutMs: 3000 }),
    );
    expect(boot).toBeDefined();
    expect(boot?.classifier.id).toBe("command:da");
    expect(boot?.timeoutMs).toBe(3000);
  });

  it("a valid record without timeoutMs leaves the default to the classifier", () => {
    const boot = parseAskClassifierEnv(JSON.stringify({ enabled: true, kind: "command", command: "da" }));
    expect(boot?.timeoutMs).toBeUndefined();
  });
});
