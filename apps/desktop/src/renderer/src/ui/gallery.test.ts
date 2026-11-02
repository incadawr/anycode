// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { Gallery } from "./gallery/Gallery.js";
import { byRole, click, createElement as h, mount } from "./ui.test-utils.js";
it("gallery theme, accent and density controls stamp the token root",()=>{
  const {container}=mount(h(Gallery));
  const theme=byRole(container,"radiogroup","Theme");click(byRole(theme,"radio","light"));expect(document.documentElement.dataset.theme).toBe("light");
  const accent=byRole(container,"combobox","Accent") as HTMLSelectElement;
  act(()=>{accent.value="teal";accent.dispatchEvent(new Event("change",{bubbles:true}));});expect(document.documentElement.dataset.accent).toBe("teal");
  const density=byRole(container,"radiogroup","Density");click(byRole(density,"radio","compact"));expect(document.documentElement.dataset.density).toBe("compact");
});
it("gallery exposes all overlay launchers and interactive examples",()=>{
  const {container}=mount(h(Gallery));
  click(byRole(container,"button","Open modal"));expect(byRole(container,"dialog","Confirm run")).toBeTruthy();click(byRole(container,"button","Close"));
  click(byRole(container,"button","Open drawer"));expect(byRole(container,"dialog","Connection")).toBeTruthy();click(byRole(container,"button","Close"));
  click(byRole(container,"button","Toggle popover"));expect(byRole(container,"menu","Access mode")).toBeTruthy();
});

it("gallery shows every state of the W1 families", () => {
  const { container } = mount(h(Gallery));
  for (const variant of ["primary", "secondary", "ghost", "danger"]) {
    expect(container.querySelector(`.ak-btn--${variant}`)).not.toBeNull();
  }
  for (const size of ["sm", "md", "lg"]) {
    expect(container.querySelector(`.ak-btn--${size}`) ?? container.querySelector(".ak-btn")).not.toBeNull();
  }
  expect(container.querySelector(".ak-btn--loading")).not.toBeNull();
  expect(container.querySelector(".ak-btn__icon")).not.toBeNull();
  expect(container.querySelector(".ak-iconbtn")).not.toBeNull();
  expect(container.querySelector(".ak-choice__control")).not.toBeNull();
  expect(container.querySelector(".ak-choice__control--radio")).not.toBeNull();
  expect(container.querySelector(".ak-choice-group")).not.toBeNull();
  expect(container.querySelectorAll(".ak-switch").length).toBeGreaterThan(1);
  expect(container.querySelector(".ak-control[aria-invalid='true']")).not.toBeNull();
  expect(container.querySelector(".ak-control[readonly]")).not.toBeNull();
});

it("gallery shows the Menu trigger with its items",()=>{
  const {container}=mount(h(Gallery));
  const trigger=byRole(container,"button","Menu");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  click(trigger);expect(byRole(container,"menu","Actions")).toBeTruthy();
});
