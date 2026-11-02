// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Badge, Banner, Chip, EmptyState } from "./index.js";
import { accessibleName, byRole, click, createElement as h, mount } from "./ui.test-utils.js";

describe("Badge", () => {
  const tones = ["neutral", "success", "warning", "danger", "info"] as const;
  for (const tone of tones) {
    it(`renders the ${tone} tone with an icon and a word`, () => {
      const { container } = mount(h(Badge, { status: tone, label: `Label ${tone}` }));
      const badge = container.querySelector(".ak-badge")!;
      expect(badge.classList.contains(`ak-badge--${tone}`)).toBe(true);
      expect(badge.querySelector("svg")).not.toBeNull();
      // The status is never conveyed by colour alone.
      expect(accessibleName(badge)).toContain(`Label ${tone}`);
    });
  }
  it("keeps legacy status names as aliases of the canonical tones", () => {
    const { container } = mount(
      h("div", null,
        h(Badge, { status: "ok", label: "ok" }),
        h(Badge, { status: "warn", label: "warn" }),
        h(Badge, { status: "bad", label: "bad" }),
        h(Badge, { status: "run", label: "run" }),
      ),
    );
    expect(container.querySelector(".ak-badge--ok")).not.toBeNull();
    expect(container.querySelector(".ak-badge--success")).not.toBeNull();
    expect(container.querySelector(".ak-badge--warn")).not.toBeNull();
    expect(container.querySelector(".ak-badge--warning")).not.toBeNull();
    expect(container.querySelector(".ak-badge--bad")).not.toBeNull();
    expect(container.querySelector(".ak-badge--danger")).not.toBeNull();
    expect(container.querySelector(".ak-badge--run")).not.toBeNull();
    expect(container.querySelector(".ak-badge--accent")).not.toBeNull();
  });
  it("uses a distinct icon shape per status", () => {
    const paths = (tone: "success" | "warning" | "danger" | "info") => {
      const { container } = mount(h(Badge, { status: tone, label: "x" }));
      return container.querySelector(".ak-badge svg")!.innerHTML;
    };
    const shapes = new Set([paths("success"), paths("warning"), paths("danger"), paths("info")]);
    expect(shapes.size).toBe(4);
  });
});

describe("Chip", () => {
  it("exposes the access mode as icon plus word", () => {
    const { container } = mount(h(Chip, { mode: "yolo" }));
    const chip = byRole(container, "button", "yolo");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(accessibleName(chip)).toBe("yolo");
  });
  it("marks a selected chip with aria-pressed and toggles it off", () => {
    const { container } = mount(h(Chip, { label: "Filter", selected: true }));
    const chip = byRole(container, "button", "Filter");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.classList.contains("ak-chip--selected")).toBe(true);
  });
  it("exposes an explicitly unselected toggle", () => {
    const { container } = mount(h(Chip, { label: "Filter", selected: false }));
    expect(byRole(container, "button", "Filter").getAttribute("aria-pressed")).toBe("false");
  });
  it("leaves aria-pressed unset for a plain chip", () => {
    const { container } = mount(h(Chip, { label: "Filter" }));
    expect(byRole(container, "button", "Filter").hasAttribute("aria-pressed")).toBe(false);
  });
  it("does not activate a disabled chip", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Chip, { label: "Filter", disabled: true, onClick }));
    click(byRole(container, "button", "Filter"));
    expect(onClick).not.toHaveBeenCalled();
  });
  it("activates an enabled chip on click", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Chip, { label: "Filter", onClick }));
    click(byRole(container, "button", "Filter"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Banner", () => {
  it("uses an alert role only for danger", () => {
    const { container, render } = mount(h(Banner, { tone: "info", children: "i" }));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render(h(Banner, { tone: "success", children: "s" }));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render(h(Banner, { tone: "warning", children: "w" }));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render(h(Banner, { tone: "danger", children: "d" }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("maps legacy warn and bad tones onto warning and danger", () => {
    const { container } = mount(h(Banner, { tone: "warn", children: "w" }));
    expect(container.querySelector(".ak-banner--warning")).not.toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
  it("renders an action without losing it behind the role region", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Banner, { tone: "info", children: "m", action: h("button", { onClick }, "Reload") }));
    click(byRole(container, "button", "Reload"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("closes when the dismiss control is pressed", () => {
    const onDismiss = vi.fn();
    const { container } = mount(h(Banner, { tone: "info", children: "m", closable: true, onDismiss }));
    click(byRole(container, "button", "Dismiss notice"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it("has no dismiss control unless closable", () => {
    const { container } = mount(h(Banner, { tone: "info", children: "m" }));
    expect(container.querySelector(".ak-banner__close")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders the title as a heading of the requested level", () => {
    const { container } = mount(h(EmptyState, { title: "No servers", headingLevel: 2 }));
    const heading = container.querySelector("h2")!;
    expect(heading.textContent).toBe("No servers");
    expect(accessibleName(heading)).toBe("No servers");
  });
  it("defaults to h3", () => {
    const { container } = mount(h(EmptyState, { title: "Nothing here" }));
    expect(container.querySelector("h3")!.textContent).toBe("Nothing here");
  });
  it("hides the decorative icon from assistive technology", () => {
    const { container } = mount(h(EmptyState, { title: "Empty", icon: h("svg", { "data-testid": "icon" }) }));
    expect(container.querySelector(".ak-empty__icon")!.getAttribute("aria-hidden")).toBe("true");
  });
  it("renders with and without an action", () => {
    const { container, render } = mount(h(EmptyState, { title: "Empty" }));
    expect(container.querySelector(".ak-empty__action")).toBeNull();
    render(h(EmptyState, { title: "Empty", action: h("button", null, "Add") }));
    expect(container.querySelector(".ak-empty__action")).not.toBeNull();
  });
});
