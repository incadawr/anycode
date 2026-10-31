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
});
