/**
 * Taskana 4702 Stage 1: the host-side reader for ANYCODE_PERMISSION_CLASSIFIER.
 * Pins the fail-closed contract: unset, empty, garbage JSON, a disabled record,
 * an invalid shape, or an empty command all yield NO classifier (off), never a
 * partial one. A valid enabled record yields a command classifier with the
 * configured argv and timeout.
 */

import { describe, expect, it } from "vitest";
import { parseAskClassifierEnv, parseAskClassifierEnvKind } from "./ask-classifier-env.js";

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

describe("parseAskClassifierEnvKind (Taskana 4730)", () => {
  it("kind model parses shape-only: no classifier is built", () => {
    const parsed = parseAskClassifierEnvKind(
      JSON.stringify({ enabled: true, kind: "model", connectionId: "c1", model: "m1", timeoutMs: 8000 }),
    );
    expect(parsed).toEqual({ kind: "model", connectionId: "c1", model: "m1", timeoutMs: 8000 });
  });

  it("kind model with both optional fields absent parses", () => {
    expect(parseAskClassifierEnvKind(JSON.stringify({ enabled: true, kind: "model" }))).toEqual({ kind: "model" });
  });

  it("kind command yields the ready command boot (same as parseAskClassifierEnv)", () => {
    const parsed = parseAskClassifierEnvKind(
      JSON.stringify({ enabled: true, kind: "command", command: "/opt/da --json", timeoutMs: 3000 }),
    );
    expect(parsed?.kind).toBe("command");
    if (parsed?.kind === "command") {
      expect(parsed.boot.classifier.id).toBe("command:da");
      expect(parsed.boot.timeoutMs).toBe(3000);
    }
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["garbage JSON", "{not json"],
    ["disabled", JSON.stringify({ enabled: false, kind: "model" })],
    ["blank model", JSON.stringify({ enabled: true, kind: "model", model: "  " })],
    ["blank connectionId", JSON.stringify({ enabled: true, kind: "model", connectionId: " " })],
    ["bad timeout", JSON.stringify({ enabled: true, kind: "model", timeoutMs: 0 })],
    ["missing enabled", JSON.stringify({ kind: "model" })],
    ["unknown kind", JSON.stringify({ enabled: true, kind: "llm" })],
  ])("%s => undefined (off)", (_label, raw) => {
    expect(parseAskClassifierEnvKind(raw)).toBeUndefined();
  });

  it("parseAskClassifierEnv still returns undefined for kind model (command-only wrapper)", () => {
    expect(parseAskClassifierEnv(JSON.stringify({ enabled: true, kind: "model", model: "m" }))).toBeUndefined();
  });
});
