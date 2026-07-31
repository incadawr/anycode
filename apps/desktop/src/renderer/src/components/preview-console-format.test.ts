import { describe, expect, it } from "vitest";
import type { PreviewConsoleBlock } from "./preview-console-format.js";
import { previewConsoleRowClassName, previewConsoleRowText } from "./preview-console-format.js";

function block(overrides: Partial<PreviewConsoleBlock> = {}): PreviewConsoleBlock {
  return {
    kind: "preview_console",
    id: "preview-console:0",
    previewId: "preview-1",
    level: "log",
    message: "hello from the page",
    ...overrides,
  };
}

describe("previewConsoleRowText", () => {
  it("brackets the level before the message, mirroring the model-facing console-tail convention", () => {
    expect(previewConsoleRowText(block({ level: "log", message: "hello from the page" }))).toBe(
      "[log] hello from the page",
    );
  });

  it("renders every level the same way — warn", () => {
    expect(previewConsoleRowText(block({ level: "warn", message: "deprecated API used" }))).toBe(
      "[warn] deprecated API used",
    );
  });

  it("renders every level the same way — error", () => {
    expect(previewConsoleRowText(block({ level: "error", message: "fetch failed" }))).toBe("[error] fetch failed");
  });

  it("renders every level the same way — pageerror", () => {
    expect(
      previewConsoleRowText(block({ level: "pageerror", message: "Uncaught TypeError: x is not a function" })),
    ).toBe("[pageerror] Uncaught TypeError: x is not a function");
  });

  it("a throttle-window summary row (suppressed present) needs no special-casing — the message already names the count", () => {
    expect(
      previewConsoleRowText(block({ level: "log", message: "3 console messages suppressed", suppressed: 3 })),
    ).toBe("[log] 3 console messages suppressed");
  });
});

describe("previewConsoleRowClassName", () => {
  it("error and pageerror reuse the danger-soft message-error strip", () => {
    expect(previewConsoleRowClassName("error")).toBe("message message-error");
    expect(previewConsoleRowClassName("pageerror")).toBe("message message-error");
  });

  it("log and warn reuse the quiet muted message-retry line", () => {
    expect(previewConsoleRowClassName("log")).toBe("message message-retry");
    expect(previewConsoleRowClassName("warn")).toBe("message message-retry");
  });
});
