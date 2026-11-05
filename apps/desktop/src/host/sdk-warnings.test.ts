import { afterEach, expect, it, vi } from "vitest";

const previous = globalThis.AI_SDK_LOG_WARNINGS;
afterEach(() => { globalThis.AI_SDK_LOG_WARNINGS = previous; vi.restoreAllMocks(); });

it("installs a warning logger that reports each warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  await import("./sdk-warnings.js");
  expect(typeof globalThis.AI_SDK_LOG_WARNINGS).toBe("function");
  if (typeof globalThis.AI_SDK_LOG_WARNINGS !== "function") throw new Error("missing logger");
  globalThis.AI_SDK_LOG_WARNINGS({ warnings: [{ type: "other", message: "warning" }] });
  expect(warn).toHaveBeenCalledOnce();
  expect(info).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});
