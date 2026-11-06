// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { UpdateProgressStatus } from "./SettingsScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("update progress", () => {
  it("renders a normalized label and accessible bar", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(UpdateProgressStatus, { status: { kind: "downloading", percent: 20.99, transferred: 1048576, total: 2097152 } })));
    expect(container.textContent).toContain("Downloading update… 20% (1.0 / 2.0 MB)");
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    await act(async () => root.unmount());
    container.remove();
  });
});
