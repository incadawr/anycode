// @vitest-environment jsdom
import { expect, it } from "vitest";
import { CountPill } from "./index.js";
import { createElement as h, mount } from "./ui.test-utils.js";

const glyph = (id: string) => h("svg", { "data-glyph": id, "aria-hidden": "true" });

it("draws one icon and count group per non-zero item, in order", () => {
  const { container } = mount(h(CountPill, { items: [{ id: "a", icon: glyph("a"), count: 2 }, { id: "b", icon: glyph("b"), count: 11 }] }));
  const groups = [...container.querySelectorAll(".ak-countpill__item")];
  expect(groups.map((group) => group.getAttribute("data-item"))).toEqual(["a", "b"]);
  expect(groups.map((group) => group.textContent)).toEqual(["2", "11"]);
  expect(groups[0]!.querySelector("[data-glyph=a]")).not.toBeNull();
});

it("hides items with a count of zero and renders nothing when all are zero", () => {
  const some = mount(h(CountPill, { items: [{ id: "a", icon: glyph("a"), count: 0 }, { id: "b", icon: glyph("b"), count: 3 }] }));
  expect([...some.container.querySelectorAll(".ak-countpill__item")].map((group) => group.getAttribute("data-item"))).toEqual(["b"]);
  const none = mount(h(CountPill, { items: [{ id: "a", icon: glyph("a"), count: 0 }], busy: true }));
  expect(none.container.querySelector(".ak-countpill")).toBeNull();
});

it("draws the ring only while busy, and the ring is decorative", () => {
  const items = [{ id: "a", icon: glyph("a"), count: 1 }];
  expect(mount(h(CountPill, { items })).container.querySelector(".ak-countpill__ring")).toBeNull();
  const ring = mount(h(CountPill, { items, busy: true })).container.querySelector(".ak-countpill__ring");
  expect(ring).not.toBeNull();
  expect(ring!.getAttribute("aria-hidden")).toBe("true");
  expect(ring!.getAttribute("focusable")).toBe("false");
});

it("passes the title and class through and is not interactive", () => {
  const { container } = mount(h(CountPill, { items: [{ id: "a", icon: glyph("a"), count: 1 }], title: "1 thing", className: "extra" }));
  const pill = container.querySelector(".ak-countpill")!;
  expect(pill.getAttribute("title")).toBe("1 thing");
  expect(pill.classList.contains("extra")).toBe(true);
  expect(pill.tagName).toBe("SPAN");
  expect(pill.querySelector("button, a, [tabindex], [role]")).toBeNull();
});
