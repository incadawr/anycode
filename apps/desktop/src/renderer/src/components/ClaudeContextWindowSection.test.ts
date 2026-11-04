// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDefaults } from "../../../settings/schema.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";
import { createSettingsStore } from "../settings-store.js";
import {
  CLAUDE_CONTEXT_WINDOW_HINT,
  ClaudeContextWindowSection,
  claudeContextWindowOf,
  claudeContextWindowPatch,
  parseClaudeContextWindowInput,
} from "./ClaudeContextWindowSection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function snapshotWith(claude: Record<string, unknown>): SettingsSnapshot {
  return { settings: { ...cloneDefaults(), claude }, secrets: [], envOverrides: [], providerReady: true, readOnly: false } as SettingsSnapshot;
}

async function mount(settingsClaude: Record<string, unknown>, setPatch: ReturnType<typeof vi.fn>) {
  const store = createSettingsStore();
  store.setState({ snapshot: snapshotWith(settingsClaude), setPatch: setPatch as never });
  root = createRoot(container);
  await act(async () => root!.render(createElement(ClaudeContextWindowSection, { store })));
  return container.querySelector<HTMLInputElement>("input")!;
}

async function type(input: HTMLInputElement, raw: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, raw);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement): Promise<void> {
  // React maps onBlur to the delegated focusout event.
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
}

describe("claude context-window section — pure helpers", () => {
  it("the save patch carries the number; the clear patch carries the \"\" sentinel", () => {
    expect(claudeContextWindowPatch(260000)).toEqual({ claude: { contextWindowTokens: 260000 } });
    expect(claudeContextWindowPatch("")).toEqual({ claude: { contextWindowTokens: "" } });
  });

  it("reads the persisted limit; absent block reads as not configured", () => {
    expect(claudeContextWindowOf({ claude: { contextWindowTokens: 260000 } })).toBe(260000);
    expect(claudeContextWindowOf({ claude: {} })).toBeUndefined();
    expect(claudeContextWindowOf({})).toBeUndefined();
    expect(claudeContextWindowOf(undefined)).toBeUndefined();
  });

  it("input parse: blank clears, in-range passes, junk and out-of-range name the bounds", () => {
    expect(parseClaudeContextWindowInput("")).toEqual({ value: "" });
    expect(parseClaudeContextWindowInput(" 260000 ")).toEqual({ value: 260000 });
    expect(parseClaudeContextWindowInput("abc")).toEqual({ error: "Enter a whole number of tokens, or leave blank." });
    expect(parseClaudeContextWindowInput("99999")).toEqual({ error: expect.stringContaining("between 100000 and 1000000") });
    expect(parseClaudeContextWindowInput("1000001")).toEqual({ error: expect.stringContaining("between 100000 and 1000000") });
  });

  it("the hint names the bounds and the blank behavior", () => {
    expect(CLAUDE_CONTEXT_WINDOW_HINT).toContain("100000–1000000");
    expect(CLAUDE_CONTEXT_WINDOW_HINT).toContain("blank");
  });
});

describe("claude context-window section — mounted", () => {
  it("populates from the persisted limit, saves an edited value on blur", async () => {
    const setPatch = vi.fn().mockResolvedValue({ ok: true });
    const input = await mount({ contextWindowTokens: 260000 }, setPatch);
    expect(input.value).toBe("260000");
    await type(input, "200000");
    await blur(input);
    expect(setPatch).toHaveBeenCalledExactlyOnceWith({ claude: { contextWindowTokens: 200000 } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("saving blank sends the clear sentinel", async () => {
    const setPatch = vi.fn().mockResolvedValue({ ok: true });
    const input = await mount({ contextWindowTokens: 260000 }, setPatch);
    await type(input, "");
    await blur(input);
    expect(setPatch).toHaveBeenCalledExactlyOnceWith({ claude: { contextWindowTokens: "" } });
  });

  it("an untouched blank field with nothing persisted never writes on blur", async () => {
    const setPatch = vi.fn().mockResolvedValue({ ok: true });
    const input = await mount({}, setPatch);
    await blur(input);
    // Blank with nothing persisted is a no-op, not a clear: the "" sentinel
    // compares as undefined (== not configured) before any write is sent.
    expect(setPatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("an out-of-range edit refuses the save with an error and never calls setPatch", async () => {
    const setPatch = vi.fn().mockResolvedValue({ ok: true });
    const input = await mount({}, setPatch);
    await type(input, "42");
    await blur(input);
    expect(setPatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("between 100000 and 1000000");
  });

  it("a save that main refuses surfaces the error instead of silently pretending", async () => {
    const setPatch = vi.fn().mockResolvedValue({ ok: false, reason: "invalid" });
    const input = await mount({}, setPatch);
    await type(input, "260000");
    await blur(input);
    expect(setPatch).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  });
});
