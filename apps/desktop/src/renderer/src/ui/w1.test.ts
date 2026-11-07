// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, Checkbox, Field, IconButton, Input, Radio, RadioGroup, Select, Switch, Textarea } from "./index.js";
import { accessibleName, byRole, click, createElement as h, key, mount } from "./ui.test-utils.js";

const noop = () => {};

describe("Button / IconButton (W1)", () => {
  it("defaults to type=button and renders every variant and size", () => {
    const { container } = mount(
      h("div", null,
        h(Button, { variant: "primary" }, "P"),
        h(Button, { variant: "secondary" }, "S"),
        h(Button, { variant: "ghost" }, "G"),
        h(Button, { variant: "danger" }, "D"),
        h(Button, { size: "sm" }, "sm"),
        h(Button, { size: "lg" }, "lg"),
      ),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map(b => b.getAttribute("type"))).toEqual(buttons.map(() => "button"));
    expect(container.querySelector(".ak-btn--primary")).not.toBeNull();
    expect(container.querySelector(".ak-btn--secondary")).not.toBeNull();
    expect(container.querySelector(".ak-btn--ghost")).not.toBeNull();
    expect(container.querySelector(".ak-btn--danger")).not.toBeNull();
    expect(container.querySelector(".ak-btn--sm")).not.toBeNull();
    expect(container.querySelector(".ak-btn--lg")).not.toBeNull();
  });

  it("keeps an explicit type", () => {
    const { container } = mount(h(Button, { type: "submit" }, "Send"));
    expect(byRole(container, "button", "Send").getAttribute("type")).toBe("submit");
  });

  it("renders a leading icon next to the label", () => {
    const { container } = mount(h(Button, { leadingIcon: h("span", { "data-icon": "1" }, "i") }, "Search"));
    const button = byRole(container, "button", "Search");
    expect(button.querySelector("[data-icon]")).not.toBeNull();
    expect(accessibleName(button)).toBe("Search");
  });

  it("marks a loading button busy and blocks activation", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Button, { loading: true, onClick }, "Save"));
    const button = byRole(container, "button", "Save");
    expect(button.getAttribute("aria-busy")).toBe("true");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a disabled button inert and named", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Button, { disabled: true, onClick }, "Save"));
    const button = byRole(container, "button", "Save");
    expect(button.hasAttribute("disabled")).toBe(true);
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("activates on Enter and Space like a native button", () => {
    const onClick = vi.fn();
    const { container } = mount(h(Button, { onClick }, "Save"));
    const button = byRole(container, "button", "Save");
    key("Enter", button);
    key(" ", button);
    // jsdom does not translate keys into clicks; the button stays a native control.
    expect(button.tagName).toBe("BUTTON");
    click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("requires an accessible label on IconButton", () => {
    const { container } = mount(h(IconButton, { label: "Close", icon: "x" }));
    const button = byRole(container, "button", "Close");
    expect(button.getAttribute("aria-label")).toBe("Close");
    expect(button.getAttribute("type")).toBe("button");
  });

  it("renders IconButton in pressed and disabled states", () => {
    const onClick = vi.fn();
    const { container } = mount(h("div", null,
      h(IconButton, { label: "Pin", icon: "p", pressed: true }),
      h(IconButton, { label: "Stop", icon: "s", disabled: true, onClick }),
    ));
    expect(byRole(container, "button", "Pin").getAttribute("aria-pressed")).toBe("true");
    const stop = byRole(container, "button", "Stop");
    expect(stop.hasAttribute("disabled")).toBe(true);
    click(stop);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Field (W1)", () => {
  it("links the label to the control through useId", () => {
    const { container } = mount(h(Input, { label: "Model" }));
    const input = byRole(container, "textbox", "Model") as HTMLInputElement;
    expect(input.id).toBeTruthy();
    expect(input.labels?.[0]?.textContent).toContain("Model");
  });

  it("gives two fields unique ids", () => {
    const { container } = mount(h("div", null, h(Input, { label: "A" }), h(Input, { label: "B" })));
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs[0]!.id).not.toBe(inputs[1]!.id);
  });

  it("honours an explicit id", () => {
    const { container } = mount(h(Input, { label: "Model", id: "model-field" }));
    expect(byRole(container, "textbox", "Model").id).toBe("model-field");
  });

  it("describes the control with the hint and marks it invalid on error", () => {
    const { container } = mount(h(Input, { label: "Model", hint: "Short name", error: "Required" }));
    const input = byRole(container, "textbox", "Model");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(described.length).toBe(2);
    const texts = described.map(id => document.getElementById(id)?.textContent ?? "");
    expect(texts).toContain("Required");
    expect(texts).toContain("Short name");
  });

  it("renders the error exactly once with role=alert", () => {
    const { container } = mount(h(Input, { label: "Model", error: "Key required" }));
    const alerts = container.querySelectorAll("[role=alert]");
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.textContent).toBe("Key required");
  });

  it("marks required fields and honours readOnly and disabled", () => {
    const { container } = mount(h("div", null,
      h(Input, { label: "Model", required: true }),
      h(Input, { label: "Fixed", readOnly: true, defaultValue: "x" }),
      h(Input, { label: "Locked", disabled: true }),
    ));
    expect(byRole(container, "textbox", "Model").getAttribute("aria-required")).toBe("true");
    expect((byRole(container, "textbox", "Fixed") as HTMLInputElement).readOnly).toBe(true);
    expect((byRole(container, "textbox", "Locked") as HTMLInputElement).disabled).toBe(true);
  });

  it("applies the same contract to Select and Textarea", () => {
    const { container } = mount(h("div", null,
      h(Select, { label: "Pricing", options: [{ value: "auto", label: "Auto" }], error: "Pick one" }),
      h(Textarea, { label: "Message", hint: "Be brief", required: true }),
    ));
    const select = byRole(container, "combobox", "Pricing");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelectorAll("[role=alert]").length).toBe(1);
    const textarea = byRole(container, "textbox", "Message");
    expect(textarea.getAttribute("aria-required")).toBe("true");
    expect(document.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent).toBe("Be brief");
  });

  it("keeps the Field render-prop contract with an explicit id", () => {
    const { container } = mount(h(Field, { label: "Raw", id: "raw-id", children: props => h("input", props) }));
    const input = byRole(container, "textbox", "Raw");
    expect(input.id).toBe("raw-id");
  });
});

describe("Choice (W1)", () => {
  it("renders a checkbox with a linked label and checked state", () => {
    const { container } = mount(h(Checkbox, { label: "Auto-update", checked: true, onCheckedChange: noop }));
    const box = byRole(container, "checkbox", "Auto-update") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the mixed state for an indeterminate checkbox", () => {
    const { container } = mount(h(Checkbox, { label: "Some", indeterminate: true, checked: false, onCheckedChange: noop }));
    expect(byRole(container, "checkbox", "Some").getAttribute("aria-checked")).toBe("mixed");
  });

  it("toggles a checkbox and reports the change", () => {
    const changed = vi.fn();
    function Harness() {
      const [checked, setChecked] = useState(false);
      return h(Checkbox, { label: "Auto-update", checked, onCheckedChange: v => { changed(v); setChecked(v); } });
    }
    const { container } = mount(h(Harness));
    const box = byRole(container, "checkbox", "Auto-update") as HTMLInputElement;
    click(box);
    expect(changed).toHaveBeenCalledWith(true);
    expect((byRole(container, "checkbox", "Auto-update") as HTMLInputElement).checked).toBe(true);
  });

  it("keeps a disabled checkbox inert", () => {
    const changed = vi.fn();
    const { container } = mount(h(Checkbox, { label: "Locked", disabled: true, onCheckedChange: changed }));
    const box = byRole(container, "checkbox", "Locked") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    click(box);
    expect(changed).not.toHaveBeenCalled();
  });

  it("describes a checkbox with its description", () => {
    const { container } = mount(h(Checkbox, { label: "Auto-update", description: "Nightly builds", onCheckedChange: noop }));
    const box = byRole(container, "checkbox", "Auto-update");
    expect(document.getElementById(box.getAttribute("aria-describedby")!)?.textContent).toBe("Nightly builds");
  });

  it("renders a radio group with role radiogroup, fieldset and legend", () => {
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [{ value: "light", label: "light" }, { value: "dark", label: "dark" }],
    }));
    const group = byRole(container, "radiogroup", "Theme");
    expect(group).not.toBeNull();
    expect(container.querySelector("fieldset")).not.toBeNull();
    expect(container.querySelector("legend")?.textContent).toBe("Theme");
  });

  it("selects the first option by default and reports changes", () => {
    const changed = vi.fn();
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [{ value: "light", label: "light" }, { value: "dark", label: "dark" }],
      onValueChange: changed,
    }));
    expect(byRole(container, "radio", "light").getAttribute("aria-checked")).toBe("true");
    click(byRole(container, "radio", "dark"));
    expect(changed).toHaveBeenCalledWith("dark");
  });

  it("keeps a single radio in the tab order (roving tabindex)", () => {
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [{ value: "light", label: "light" }, { value: "dark", label: "dark" }],
    }));
    const radios = [...container.querySelectorAll<HTMLElement>("input[type=radio]")];
    expect(radios.map(r => r.tabIndex)).toEqual([0, -1]);
  });

  it("moves the selection and focus with the arrow keys", () => {
    const changed = vi.fn();
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [
        { value: "light", label: "light" },
        { value: "dark", label: "dark" },
        { value: "system", label: "system" },
      ],
      onValueChange: changed,
    }));
    const light = byRole(container, "radio", "light");
    light.focus();
    key("ArrowDown", light);
    expect(changed).toHaveBeenLastCalledWith("dark");
    expect(document.activeElement).toBe(byRole(container, "radio", "dark"));
    key("ArrowUp", byRole(container, "radio", "dark"));
    expect(changed).toHaveBeenLastCalledWith("light");
    expect(document.activeElement).toBe(byRole(container, "radio", "light"));
  });

  it("wraps around at the group edges and supports Home and End", () => {
    const changed = vi.fn();
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [{ value: "a", label: "a" }, { value: "b", label: "b" }, { value: "c", label: "c" }],
      onValueChange: changed,
    }));
    const first = byRole(container, "radio", "a");
    first.focus();
    key("ArrowUp", first);
    expect(changed).toHaveBeenLastCalledWith("c");
    key("End", byRole(container, "radio", "c"));
    expect(changed).toHaveBeenLastCalledWith("c");
    key("Home", byRole(container, "radio", "c"));
    expect(changed).toHaveBeenLastCalledWith("a");
  });

  it("skips a disabled option while navigating", () => {
    const changed = vi.fn();
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b", disabled: true },
        { value: "c", label: "c" },
      ],
      onValueChange: changed,
    }));
    const first = byRole(container, "radio", "a");
    first.focus();
    key("ArrowDown", first);
    expect(changed).toHaveBeenLastCalledWith("c");
  });

  it("does not select on focus or option changes and normalizes disabled navigation", () => {
    const changed = vi.fn();
    const options = [{ value: "a", label: "a", disabled: true }, { value: "b", label: "b" }, { value: "c", label: "c" }, { value: "d", label: "d", disabled: true }];
    const { container, render } = mount(h(RadioGroup, { label: "Theme", options, onValueChange: changed }));
    const b = byRole(container, "radio", "b");
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute("aria-checked")).toBe("true");
    byRole(container, "radio", "c").focus();
    expect(changed).not.toHaveBeenCalled();
    key("Home", byRole(container, "radio", "c"));
    expect(document.activeElement).toBe(b);
    key("End", b);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("c");
    render(h(RadioGroup, { label: "Theme", options: options.map(o => o.value === "c" ? { ...o, disabled: true } : o), onValueChange: changed }));
    expect(b.tabIndex).toBe(0);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("preserves an indeterminate checkbox after activation", () => {
    const { container } = mount(h(Checkbox, { label: "Mixed", indeterminate: true, checked: false, onCheckedChange: noop }));
    const box = byRole(container, "checkbox", "Mixed") as HTMLInputElement;
    click(box);
    expect(box.indeterminate).toBe(true);
  });

  it("disables every option of a disabled group", () => {
    const { container } = mount(h(RadioGroup, {
      label: "Theme",
      disabled: true,
      options: [{ value: "a", label: "a" }, { value: "b", label: "b" }],
    }));
    for (const radio of container.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
      expect(radio.disabled).toBe(true);
    }
  });

  it("renders a standalone radio with a linked label", () => {
    const { container } = mount(h(Radio, { label: "Solo", value: "a", checked: true, onChange: noop }));
    const radio = byRole(container, "radio", "Solo");
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect((radio as HTMLInputElement).labels?.[0]?.textContent).toContain("Solo");
  });
});

it("supports compact inputs and selects and a tall monospaced textarea", () => {
  const { container } = mount(h("div", null,
    h(Input, { label: "Compact input", size: "sm" }),
    h(Select, { label: "Compact select", size: "sm", options: [{ value: "a", label: "A" }] }),
    h(Textarea, { label: "Prompt", mono: true, tall: true }),
  ));
  expect(byRole(container, "textbox", "Compact input").classList.contains("ak-control--sm")).toBe(true);
  expect(byRole(container, "combobox", "Compact select").classList.contains("ak-control--sm")).toBe(true);
  const prompt = byRole(container, "textbox", "Prompt");
  expect(prompt.classList.contains("ak-textarea--mono")).toBe(true);
  expect(prompt.classList.contains("ak-textarea--tall")).toBe(true);
  const sheet = readFileSync([process.cwd(), join(process.cwd(), "apps/desktop")].map((root) => join(root, "src/renderer/src/ui/ui.css")).find((path) => existsSync(path))!, "utf8");
  expect(sheet).toMatch(/\.ak-control--sm\s*\{[^}]*height:\s*var\(--ctl-h-sm\)/s);
  expect(sheet).toMatch(/\.ak-textarea--tall\s*\{[^}]*min-height:\s*10rem/s);
  expect(sheet).toMatch(/\.ak-textarea--mono\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
});

describe("Switch (W1)", () => {
  it("names the switch through aria-labelledby", () => {
    const { container } = mount(h(Switch, { checked: false, onCheckedChange: noop, label: "Auto-update" }));
    const control = byRole(container, "switch", "Auto-update");
    expect(control.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent).toBe("Auto-update");
  });

  it("keeps the switch role and reflects the checked state", () => {
    const { container } = mount(h(Switch, { checked: true, onCheckedChange: noop, label: "Auto-update" }));
    expect(byRole(container, "switch", "Auto-update").getAttribute("aria-checked")).toBe("true");
  });

  it("toggles on click and stays inert when disabled", () => {
    const changed = vi.fn();
    const { container } = mount(h("div", null,
      h(Switch, { checked: false, onCheckedChange: changed, label: "On" }),
      h(Switch, { checked: false, onCheckedChange: changed, label: "Off", disabled: true }),
    ));
    click(byRole(container, "switch", "On"));
    expect(changed).toHaveBeenCalledWith(true);
    click(byRole(container, "switch", "Off"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("describes the switch with an external description", () => {
    const { container } = mount(h(Switch, { checked: false, onCheckedChange: noop, label: "Auto", describedBy: "desc" }));
    expect(byRole(container, "switch", "Auto").getAttribute("aria-describedby")).toBe("desc");
  });
});

describe("style contract (W1)", () => {
  // The jsdom environment changes import.meta.url, so the file is found by walking the directory tree.
  function kitFile(relative: string): string {
    for (const root of [process.cwd(), join(process.cwd(), "apps/desktop")]) {
      const candidate = join(root, "src/renderer/src/ui", relative);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`Cannot locate ${relative}`);
  }
  const css = readFileSync(kitFile("ui.css"), "utf8");
  const tokens = readFileSync(kitFile("../tokens.css"), "utf8");

  it("keeps the switch geometry of .settings-switch (32x18, 12px thumb)", () => {
    expect(tokens).toMatch(/--switch-w:\s*2rem/);
    expect(tokens).toMatch(/--switch-h:\s*1\.125rem/);
    expect(tokens).toMatch(/--switch-knob:\s*0\.75rem/);
    expect(css).toMatch(/\.ak-switch\s*\{[^}]*width:\s*var\(--switch-w\)/s);
    expect(css).toMatch(/\.ak-switch::after\s*\{[^}]*width:\s*var\(--switch-knob\)/s);
  });

  it("styles every button variant, size and state", () => {
    for (const selector of [
      ".ak-btn--primary", ".ak-btn--secondary", ".ak-btn--ghost", ".ak-btn--danger",
      ".ak-btn--sm", ".ak-btn--lg", ".ak-btn--loading", ".ak-btn:active", ".ak-btn:focus-visible",
      ".ak-iconbtn", ".ak-iconbtn--md", ".ak-iconbtn:active", ".ak-iconbtn:focus-visible",
      ".ak-choice", ".ak-choice__control", ".ak-choice__control--radio", ".ak-choice-group",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("adds no colour literal to the kit stylesheet", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\brgba?\s*\(/gi) ?? []).toEqual([]);
  });
});
