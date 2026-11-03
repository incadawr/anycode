import { expect, it } from "vitest";
import { parseChildTerminal } from "../shared/child-sessions.js";
import { childBootFailure, sanitizeBootFailure } from "./child-boot-failure.js";

it("reports a startup error with the original engine message", () => {
  const reason = "host failed to initialize: Codex version preflight timed out after 15000ms";
  expect(parseChildTerminal(childBootFailure(reason))).toMatchObject({
    status: "error", turns: 0, toolCalls: 0,
    finalText: `${reason}\nThis is a startup failure; retry the task unchanged.`,
  });
});

it.each(["Codex", "Claude"])("redacts credentials in %s startup errors", (engine) => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const safe = sanitizeBootFailure(`host failed to initialize: ${engine} version preflight exited 1: ${secret}`);
  const result = childBootFailure(safe.message, safe.truncated);
  expect(result.finalText).not.toContain(secret);
  expect(result.finalText).toContain(`${engine} version preflight exited 1`);
  expect(result.finalText).toContain("[redacted]");
});

it("bounds a long failure while preserving the startup hint and terminal validity", () => {
  const safe = sanitizeBootFailure("host failed to initialize: " + "bad ".repeat(30_000));
  const result = childBootFailure(safe.message, safe.truncated);
  expect(result.truncated).toBe(true);
  expect(result.finalText.length).toBeLessThanOrEqual(100_000);
  expect(result.finalText).toContain("retry the task unchanged");
  expect(parseChildTerminal(result)).toEqual(result);
});
