// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DiagnosticsExportRow } from "./DiagnosticsExportSection.js";
import type { DiagnosticsSummary } from "../../../shared/diagnostics.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUMMARY: DiagnosticsSummary = {
  generatedAt: "2026-10-30T12:00:00.000Z",
  bytes: 2048,
  sections: [{ name: "telemetry", records: 40, bytes: 1024 }],
  truncated: false,
  redactions: 7,
};

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

async function mount(sessionId: string | null, bridge: { preview: Mock; save: Mock }) {
  (window as unknown as { anycode: unknown }).anycode = { diagnostics: bridge };
  root = createRoot(container);
  await act(async () => root!.render(createElement(DiagnosticsExportRow, { sessionId })));
  return container;
}

function button(action: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-environment-action="${action}"]`);
}

describe("diagnostics export row (GitHub #18)", () => {
  it("exports the tree of the session it was given, and shows the scrubbed preview", async () => {
    const preview = vi.fn(async () => ({ ok: true, summary: SUMMARY, preview: '{"format":"anycode-diagnostics"}' }));
    const save = vi.fn(async () => ({ ok: true, saved: true }));
    await mount("sess_root_0001", { preview, save });

    await act(async () => button("diagnostics-preview")!.click());
    expect(preview).toHaveBeenCalledWith({ sessionId: "sess_root_0001" });
    expect(container.querySelector(".environment-menu-diagnostics-preview")?.textContent).toContain("anycode-diagnostics");

    await act(async () => button("diagnostics-save")!.click());
    expect(save).toHaveBeenCalledWith({ sessionId: "sess_root_0001" });
    expect(container.textContent).toContain("Saved.");
  });

  it("cannot export anything without a bound session id", async () => {
    const preview = vi.fn();
    const save = vi.fn();
    await mount(null, { preview, save });
    expect(button("diagnostics-preview")!.disabled).toBe(true);
    expect(preview).not.toHaveBeenCalled();
  });

  it("shows a closed reason, never the bridge's error text", async () => {
    const preview = vi.fn(async () => ({ ok: false, reason: "build_failed" }));
    await mount("sess_root_0001", { preview, save: vi.fn() });
    await act(async () => button("diagnostics-preview")!.click());
    expect(container.textContent).toContain("The bundle could not be built.");
  });

  it("leaves the row usable when the preview bridge REJECTS (no handler registered)", async () => {
    const preview = vi.fn(async () => {
      throw new Error("Error invoking remote method 'anycode:diagnostics-preview'");
    });
    await mount("sess_root_0001", { preview, save: vi.fn() });

    await act(async () => button("diagnostics-preview")!.click());
    expect(container.textContent).toContain("The bundle could not be built.");
    // Not stuck in "previewing": the row's button is enabled again.
    expect(button("diagnostics-preview")!.disabled).toBe(false);
  });

  it("reports a rejected save instead of waiting forever", async () => {
    const preview = vi.fn(async () => ({ ok: true, summary: SUMMARY, preview: "{}" }));
    const save = vi.fn(async () => {
      throw new Error("Error invoking remote method 'anycode:diagnostics-save'");
    });
    await mount("sess_root_0001", { preview, save });

    await act(async () => button("diagnostics-preview")!.click());
    await act(async () => button("diagnostics-save")!.click());
    expect(container.textContent).toContain("The bundle could not be written.");
    expect(container.textContent).not.toContain("Waiting for the save dialog");
  });

  it("shows a long bundle in pages with the hidden amount stated, and can reveal all of it", async () => {
    const json = JSON.stringify({ format: "anycode-diagnostics", filler: "a".repeat(20_000), tail: "LAST-RECORD" });
    const preview = vi.fn(async () => ({ ok: true, summary: SUMMARY, preview: json }));
    const save = vi.fn(async () => ({ ok: true, saved: true }));
    await mount("sess_root_0001", { preview, save });

    await act(async () => button("diagnostics-preview")!.click());
    const pre = () => container.querySelector(".environment-menu-diagnostics-preview")?.textContent ?? "";
    const hidden = () => container.querySelector(".environment-menu-note.environment-menu-row-detail-wrap")?.textContent ?? "";
    expect(pre()).toHaveLength(8_000);
    expect(pre()).not.toContain("LAST-RECORD");
    expect(hidden()).toContain("Showing the first 8,000 of " + json.length.toLocaleString("en-US") + " characters");
    expect(hidden()).toContain("The saved file contains all of them.");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-environment-action="diagnostics-show-more"]')!.click());
    expect(pre()).toHaveLength(16_000);
    expect(pre()).not.toContain("LAST-RECORD");

    await act(async () => container.querySelector<HTMLButtonElement>('[data-environment-action="diagnostics-show-all"]')!.click());
    expect(pre()).toBe(json);
    expect(pre()).toContain("LAST-RECORD");
    expect(container.querySelector('[data-environment-action="diagnostics-show-all"]')).toBeNull();

    // The save still writes the same bundle the reviewer just read.
    await act(async () => button("diagnostics-save")!.click());
    expect(save).toHaveBeenCalledWith({ sessionId: "sess_root_0001" });
  });

  it("does not offer paging for a bundle that fits in one page", async () => {
    const preview = vi.fn(async () => ({ ok: true, summary: SUMMARY, preview: "{}" }));
    await mount("sess_root_0001", { preview, save: vi.fn() });
    await act(async () => button("diagnostics-preview")!.click());
    expect(container.querySelector('[data-environment-action="diagnostics-show-more"]')).toBeNull();
    expect(container.querySelector('[data-environment-action="diagnostics-show-all"]')).toBeNull();
  });
});
