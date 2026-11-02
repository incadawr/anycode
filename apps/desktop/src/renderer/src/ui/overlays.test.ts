// @vitest-environment jsdom
import { act, createRef, type HTMLAttributes } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Button, Drawer, MenuItem, Modal, Popover } from "./index.js";
import { byRole, createElement as h, key, mount } from "./ui.test-utils.js";

afterEach(()=>vi.restoreAllMocks());
const noop=()=>{};
function trigger(){const button=document.createElement("button");button.textContent="Trigger";document.body.append(button);button.focus();return button;}
function menu(onClose=noop){return h(Popover,{open:true,onClose,heading:"Access",position:{x:0,y:0},children:[h(MenuItem,{key:"a",label:"A"}),h(MenuItem,{key:"d",label:"Disabled",disabled:true}),h(MenuItem,{key:"b",label:"B"}),h(MenuItem,{key:"c",label:"C"})]});}
it("Modal 1: useId makes duplicate titles unique and valid",()=>{
  const {container}=mount(h("div",null,h(Modal,{open:true,title:"Same title",onClose:noop}),h(Modal,{open:true,title:"Same title",onClose:noop})));
  const dialogs=[...container.querySelectorAll("dialog")], ids=dialogs.map(d=>d.getAttribute("aria-labelledby"));expect(new Set(ids).size).toBe(2);for(const id of ids){expect(id).not.toMatch(/\s/);expect(document.getElementById(id!)?.textContent).toBe("Same title");}
});
it("Modal 2: restores trigger after controlled close",()=>{const button=trigger();const {render}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop},h(Button,null,"Run")));render(h(Modal,{open:false,title:"Confirm",onClose:noop}));expect(document.activeElement).toBe(button);button.remove();});
it("Modal 2: restores trigger when unmounted",()=>{const button=trigger();const {unmount}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop}));unmount();expect(document.activeElement).toBe(button);button.remove();});
it("Modal 3: initialFocusRef wins over autofocus and body order",()=>{const initialFocusRef=createRef<HTMLButtonElement>();const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop,initialFocusRef},h("button",{"data-autofocus":true},"First"),h("button",{ref:initialFocusRef},"Preferred")));expect(document.activeElement).toBe(byRole(container,"button","Preferred"));});
it("Modal 3: data-autofocus precedes the first body control",()=>{const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop},h("button",null,"First"),h("button",{"data-autofocus":true},"Preferred")));expect(document.activeElement).toBe(byRole(container,"button","Preferred"));});
it("Modal 3: focuses first body control, then Close for empty bodies",()=>{const {container,render}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop},h(Button,null,"Run")));expect(document.activeElement).toBe(byRole(container,"button","Run"));render(h(Modal,{open:false,title:"Confirm",onClose:noop}));render(h(Modal,{open:true,title:"Confirm",onClose:noop},"Empty"));expect(document.activeElement).toBe(byRole(container,"button","Close"));});
it("Modal 4: layout belongs to CSS and supports wide/className",()=>{const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop,wide:true,className:"extra"}));const dialog=container.querySelector("dialog")!;expect(dialog.getAttribute("style")).toBeNull();expect(dialog.classList.contains("ak-modal--wide")).toBe(true);expect(dialog.classList.contains("extra")).toBe(true);expect(dialog.querySelector(".ak-modal__heading")?.getAttribute("style")).toBeNull();});
it("Modal 5: calls showModal and exposes dialog name and description",()=>{
  const show=vi.fn(function(this:HTMLDialogElement){this.open=true;});
  Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:show});
  const {container}=mount(h(Modal,{open:true,title:"Confirm",subtitle:"Description",onClose:noop}));const dialog=byRole(container,"dialog","Confirm");expect(show).toHaveBeenCalledOnce();expect(dialog.getAttribute("aria-modal")).toBe("true");expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Description");
  Reflect.deleteProperty(HTMLDialogElement.prototype,"showModal");
});
it("Modal 6: traps Tab across fixed controls, skipping hidden, disabled and negative tabindex",()=>{
  const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop},h("button",{style:{position:"fixed"}},"Fixed"),h("button",{hidden:true},"Hidden"),h("button",{disabled:true},"Disabled"),h("button",{tabIndex:-1},"Negative")));
  const first=byRole(container,"button","Close"),last=byRole(container,"button","Fixed");last.focus();key("Tab");expect(document.activeElement).toBe(first);key("Tab",first,true);expect(document.activeElement).toBe(last);
});
it("Modal: Escape and native cancel each request close exactly once",()=>{const close=vi.fn();const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:close}));key("Escape");expect(close).toHaveBeenCalledTimes(1);close.mockClear();const event=new Event("cancel",{cancelable:true});byRole(container,"dialog").dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(close).toHaveBeenCalledTimes(1);});
it("Modal: scrim respects closeOnScrimClick and body clicks do not close",()=>{const close=vi.fn();const {container,render}=mount(h(Modal,{open:true,title:"Confirm",onClose:close},h("p",null,"Body")));container.querySelector("p")!.click();expect(close).not.toHaveBeenCalled();container.querySelector("dialog")!.click();expect(close).toHaveBeenCalledOnce();close.mockClear();render(h(Modal,{open:true,title:"Confirm",onClose:close,closeOnScrimClick:false}));container.querySelector("dialog")!.click();expect(close).not.toHaveBeenCalled();});
it("Popover 1: focuses first enabled row and restores trigger on close",()=>{const button=trigger();const {container,unmount}=mount(menu());expect(document.activeElement).toBe(byRole(container,"menuitem","A"));unmount();expect(document.activeElement).toBe(button);button.remove();});
it("Popover 2: arrows, Home, End and Tab navigate from the active row",()=>{const {container}=mount(menu());const check=(name:string)=>expect(document.activeElement).toBe(byRole(container,"menuitem",name));key("ArrowDown");check("B");key("ArrowDown");check("C");key("ArrowUp");check("B");key("End");check("C");key("Home");check("A");key("Tab");check("B");key("Tab",document.activeElement,true);check("A");key("ArrowUp");check("C");});
it("Popover 3: checkable fixes roles independently of selected",()=>{const {container,render}=mount(h("div",null,h(MenuItem,{label:"Check",checkable:true}),h(MenuItem,{label:"Plain",selected:true})));expect(byRole(container,"menuitemcheckbox","Check").getAttribute("aria-checked")).toBe("false");expect(byRole(container,"menuitem","Plain").hasAttribute("aria-checked")).toBe(false);render(h("div",null,h(MenuItem,{label:"Check",checkable:true,selected:true}),h(MenuItem,{label:"Plain"})));expect(byRole(container,"menuitemcheckbox","Check").getAttribute("aria-checked")).toBe("true");expect(byRole(container,"menuitem","Plain").hasAttribute("aria-checked")).toBe(false);});
it("Popover 4: Escape from a row closes exactly once",()=>{const close=vi.fn();mount(menu(close));key("Escape");expect(close).toHaveBeenCalledTimes(1);});
it("Popover 5: trigger mousedown does not count as an outside click",()=>{const button=trigger(),close=vi.fn();mount(menu(close));button.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));expect(close).not.toHaveBeenCalled();document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));expect(close).toHaveBeenCalledOnce();button.remove();});
it("Popover 6: one enabled row participates in tab order and follows focus",()=>{const {container}=mount(menu());const rows=[...container.querySelectorAll<HTMLButtonElement>(".ak-popover__row")];expect(rows.map(r=>r.tabIndex)).toEqual([0,-1,-1,-1]);key("ArrowDown");expect(rows.map(r=>r.tabIndex)).toEqual([-1,-1,0,-1]);});
it("Popover 6: reclamps on resize without changing props",()=>{
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({width:200,height:100} as DOMRect);
  const {container}=mount(h(Popover,{open:true,onClose:noop,position:{x:9999,y:9999},children:h(MenuItem,{label:"A"})}));
  const root=byRole(container,"menu");expect(root.style.left).toBe(`${innerWidth-208}px`);
  const width=innerWidth,height=innerHeight;
  try {
    Object.defineProperty(window,"innerWidth",{configurable:true,value:width-100});
    Object.defineProperty(window,"innerHeight",{configurable:true,value:height-50});
    window.dispatchEvent(new Event("resize"));
    expect(root.style.left).toBe(`${width-308}px`);expect(root.style.top).toBe(`${height-158}px`);
  } finally {
    Object.defineProperty(window,"innerWidth",{configurable:true,value:width});
    Object.defineProperty(window,"innerHeight",{configurable:true,value:height});
  }
});
it("Modal native close synchronizes controlled state exactly once",()=>{
  const onClose=vi.fn();const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose},h("form",{method:"dialog"},h("button",null,"Done"))));
  const dialog=container.querySelector("dialog")!;
  // jsdom lacks close/form-dialog submission; emulate the native close event.
  act(()=>{dialog.removeAttribute("open");dialog.dispatchEvent(new Event("close"));});
  expect(onClose).toHaveBeenCalledTimes(1);
  act(()=>dialog.dispatchEvent(new Event("close")));expect(onClose).toHaveBeenCalledTimes(1);
});
it("Modal React cleanup does not request close again",()=>{
  const onClose=vi.fn(),initialFocusRef=createRef<HTMLButtonElement>();
  const {container,render}=mount(h(Modal,{open:true,title:"Confirm",onClose,initialFocusRef},h("button",{ref:initialFocusRef},"Body")));
  const dialog=container.querySelector("dialog")!;
  dialog.close=()=>{dialog.removeAttribute("open");dialog.dispatchEvent(new Event("close"));};
  // Changing the focus ref runs cleanup while the same dialog is still mounted.
  render(h(Modal,{open:true,title:"Confirm",onClose,initialFocusRef:createRef<HTMLElement>()},"Body"));
  expect(onClose).not.toHaveBeenCalled();
});
for(const hidden of ["display","hidden","inert"] as const) it(`Modal skips ${hidden} ancestors for initial focus and reverse trap`,()=>{
  const props: HTMLAttributes<HTMLDivElement> = hidden==="display"?{style:{display:"none"}}:hidden==="hidden"?{hidden:true}:{inert:true};
  const {container}=mount(h(Modal,{open:true,title:"Confirm",onClose:noop},h("div",props,h("button",null,"Hidden first")),h(Button,null,"Visible"),h("div",props,h("button",null,"Hidden last"))));
  expect(document.activeElement).toBe(byRole(container,"button","Visible"));
  const close=byRole(container,"button","Close");close.focus();key("Tab",close,true);
  expect(document.activeElement).toBe(byRole(container,"button","Visible"));
});
it("Popover outside click closes when opened with body focused and no triggerRef",()=>{
  (document.activeElement as HTMLElement)?.blur();expect(document.activeElement).toBe(document.body);
  const close=vi.fn();mount(menu(close));document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));expect(close).toHaveBeenCalledTimes(1);
});
it("Drawer prioritizes autofocus, then body, then Close",()=>{
  const {container,render}=mount(h(Drawer,{open:true,onClose:noop,title:"Drawer"},h("button",null,"First"),h("button",{"data-autofocus":true},"Preferred")));
  expect(document.activeElement).toBe(byRole(container,"button","Preferred"));
  render(h(Drawer,{open:false,onClose:noop,title:"Drawer"}));render(h(Drawer,{open:true,onClose:noop,title:"Drawer"},h("button",null,"First")));
  expect(document.activeElement).toBe(byRole(container,"button","First"));
  render(h(Drawer,{open:false,onClose:noop,title:"Drawer"}));render(h(Drawer,{open:true,onClose:noop,title:"Drawer"},"Empty"));
  expect(document.activeElement).toBe(byRole(container,"button","Close"));
});
it("Drawer restores trigger on unmount and traps past hidden body controls",()=>{
  const button=trigger();const {container,unmount}=mount(h(Drawer,{open:true,onClose:noop,title:"Drawer"},h("button",null,"Visible"),h("div",{style:{display:"none"}},h("button",null,"Hidden"))));
  const close=byRole(container,"button","Close");close.focus();key("Tab",close,true);expect(document.activeElement).toBe(byRole(container,"button","Visible"));
  unmount();expect(document.activeElement).toBe(button);button.remove();
});

it("Popover Escape stops propagation past document", () => {
  const close = vi.fn(), outer = vi.fn();
  window.addEventListener("keydown", outer);
  mount(menu(close));
  key("Escape");
  expect(close).toHaveBeenCalledOnce();
  expect(outer).not.toHaveBeenCalled();
  window.removeEventListener("keydown", outer);
});

for (const kind of ["Modal", "Drawer"] as const) it(`Escape closes a popover inside ${kind} before its parent`, () => {
  const closeParent=vi.fn(), closeMenu=vi.fn();
  const props={open:true,title:"Parent",onClose:closeParent};
  const {container}=mount(kind === "Modal" ? h(Modal,props,menu(closeMenu)) : h(Drawer,props,menu(closeMenu)));
  const row=byRole(container,"menuitem","A"); row.focus(); key("Escape",row);
  expect(closeMenu).toHaveBeenCalledOnce(); expect(closeParent).not.toHaveBeenCalled();
});
