/**
 * RENDERED-component regression for the native model/effort menu (mounted in
 * jsdom, unlike EngineControls.test.ts's pure-logic coverage). A fake DOM tree
 * would keep passing if `Composer` stopped handing over the effort control or if
 * `EngineModelMenu` stopped rendering the row; this file renders the REAL
 * component — with the SAME prop expression Composer builds
 * (`nativeEffortControl`) — and drives real clicks through the menu.
 */
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineModelMenu, nativeEffortControl, type EngineModelMenuProps } from "./EngineControls.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
});

/** An engine catalog entry whose vocabulary includes `xhigh` and no core level set. */
const terraModels = [{ id: "gpt-6.1-terra", label: "Terra", efforts: ["low", "medium", "high", "xhigh"] }, { id: "plain", label: "Plain" }];

async function mount(props: EngineModelMenuProps): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(EngineModelMenu, props));
  });
  return { container, root };
}

/** Clicks the chip that opens the popover. */
async function openMenu(container: HTMLElement): Promise<void> {
  const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
  expect(chip).not.toBeNull();
  await act(async () => chip!.click());
}

/** Clicks the `Effort` (or `Model`) row on the popover's root page. */
async function openPage(container: HTMLElement, name: "Effort" | "Model"): Promise<void> {
  await openMenu(container);
  const page = container.querySelector<HTMLElement>('[data-model-pill-page="root"]');
  expect(page).not.toBeNull();
  const row = [...page!.querySelectorAll<HTMLButtonElement>("button.model-pill-row")]
    .find((button) => button.querySelector(".model-pill-row-name")?.textContent === name);
  expect(row, `the ${name} row must be rendered`).toBeDefined();
  await act(async () => row!.click());
}

describe("EngineModelMenu — rendered effort row", () => {
  it("renders the effort row and its advertised xhigh item when no current effort is known", async () => {
    const onPick = vi.fn();
    const onEffortPick = vi.fn();
    // Exactly what Composer builds: no `effort.current` anywhere, so only the
    // advertised vocabulary decides whether the row exists.
    const control = nativeEffortControl({ current: "gpt-6.1-terra", available: terraModels }, undefined, undefined, onEffortPick);
    expect(control).toBeDefined();
    const { container, root } = await mount({ model: { current: "gpt-6.1-terra", available: terraModels }, pendingModel: undefined, disabled: false, onPick, ...(control !== undefined ? { effort: control } : {}) });
    try {
      // No invented level: the unknown current effort reads as Default.
      const chip = container.querySelector('button[aria-label="Engine model and effort"]');
      expect(chip?.textContent).toContain("Default");

      await openPage(container, "Effort");

      const page = container.querySelector('[data-model-pill-page="effort"]');
      expect(page).not.toBeNull();
      const items = [...page!.querySelectorAll<HTMLButtonElement>("button.model-pill-item")];
      expect(items.map((item) => item.getAttribute("data-effort"))).toEqual(["low", "medium", "high", "xhigh"]);
      const xhigh = items.find((item) => item.getAttribute("data-effort") === "xhigh");
      expect(xhigh).toBeDefined();
      expect(xhigh!.textContent).toContain("xhigh");

      await act(async () => xhigh!.click());
      expect(onEffortPick).toHaveBeenCalledWith("xhigh");
      expect(onPick).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends the pick that CANCELS a queued effort instead of closing silently", async () => {
    const onEffortPick = vi.fn();
    const control = nativeEffortControl({ current: "gpt-6.1-terra", available: terraModels, effort: "medium" }, undefined, "xhigh", onEffortPick);
    const { container, root } = await mount({ model: { current: "gpt-6.1-terra", available: terraModels }, pendingModel: undefined, disabled: false, onPick: vi.fn(), ...(control !== undefined ? { effort: control } : {}) });
    try {
      await openPage(container, "Effort");

      const page = container.querySelector('[data-model-pill-page="effort"]')!;
      const items = [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")];
      const applied = items.find((item) => item.getAttribute("data-effort") === "medium")!;
      const queued = items.find((item) => item.getAttribute("data-effort") === "xhigh")!;
      // Applied and queued are distinguishable in the rendered menu.
      expect(applied.getAttribute("aria-checked")).toBe("true");
      expect(queued.getAttribute("aria-checked")).toBe("false");
      expect(queued.textContent).toContain("next turn");

      // Picking the APPLIED effort is the gesture that cancels `xhigh`: it must
      // reach the host, or the next turn silently still runs at `xhigh`.
      await act(async () => applied.click());
      expect(onEffortPick).toHaveBeenCalledWith("medium");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends an effort pick for a queued model switch whose own effort is unknown", async () => {
    // Model A is applied at `medium`; a switch to B (which advertises `medium`
    // but has no catalog default) is queued. B's effort is therefore UNKNOWN,
    // and picking `medium` for it is a real change — comparing against A's
    // applied `medium` closed the menu and left the next turn at B's default.
    const models = [
      { id: "model-a", label: "Model A", efforts: ["low", "medium", "high"] },
      { id: "model-b", label: "Model B", efforts: ["low", "medium", "high"] },
    ];
    const onEffortPick = vi.fn();
    const control = nativeEffortControl({ current: "model-a", available: models, effort: "medium" }, "model-b", undefined, onEffortPick);
    const { container, root } = await mount({
      model: { current: "model-a", available: models },
      pendingModel: "model-b",
      disabled: false,
      onPick: vi.fn(),
      ...(control !== undefined ? { effort: control } : {}),
    });
    try {
      await openPage(container, "Effort");

      const page = container.querySelector('[data-model-pill-page="effort"]')!;
      const medium = [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
        .find((item) => item.getAttribute("data-effort") === "medium")!;

      await act(async () => medium.click());
      // B's effort is unknown, so picking `medium` for it IS a change.
      expect(onEffortPick).toHaveBeenCalledWith("medium");

      // ...and nothing of A's reads as B's: the applied effort belongs to the
      // OLD model, so no level is checked and the chip reads Default.
      expect(medium.getAttribute("aria-checked")).toBe("false");
      expect(container.querySelector('button[aria-label="Engine model and effort"]')?.textContent).toContain("Default");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends a model pick that returns to the applied model while another switch is queued", async () => {
    const onPick = vi.fn();
    const { container, root } = await mount({ model: { current: "gpt-6.1-terra", available: terraModels }, pendingModel: "plain", disabled: false, onPick });
    try {
      await openPage(container, "Model");

      const page = container.querySelector('[data-model-pill-page="model"]')!;
      const applied = [...page.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
        .find((item) => item.getAttribute("data-model-id") === "gpt-6.1-terra")!;

      await act(async () => applied.click());
      expect(onPick).toHaveBeenCalledWith("gpt-6.1-terra");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
