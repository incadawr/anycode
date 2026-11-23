import { expect, it } from "vitest";
import { deriveSessionTitle } from "../context/session-title.js";
import { CODE_MODE_REMINDER, withCodeModeReminder } from "./code-mode-reminder.js";

it("appends the reminder in a system-reminder tag that titles strip", () => {
  const input = withCodeModeReminder("Fix the title bug");
  expect(input).toBe(`Fix the title bug\n<system-reminder>\n${CODE_MODE_REMINDER}\n</system-reminder>`);
  expect(deriveSessionTitle(input)).toBe(deriveSessionTitle("Fix the title bug"));
});
