// @vitest-environment jsdom
import { cloneElement, useState, type ButtonHTMLAttributes, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Badge, Banner, Button, Chip, ContextRing, Drawer, EmptyState, Field, IconButton, Input, Menu, MenuItem, Modal, Popover, SearchInput, SegmentedControl, Select, Switch, Textarea, Toast, ToastStack, ToolCard } from "./index.js";
import { accessibleName, byRole, click, createElement as h, key, mount } from "./ui.test-utils.js";

const noop = () => {};
const action = h(Button, { disabled:true }, "Unavailable");
const cases: { name:string; render:()=>ReactElement; selector:string; text:string; disabled:()=>ReactElement }[] = [
  { name:"Button", render:()=>h(Button,null,"Save"), selector:"button", text:"Save", disabled:()=>h(Button,{disabled:true},"Save") },
  { name:"IconButton", render:()=>h(IconButton,{label:"Search",icon:"?"}), selector:"button", text:"Search", disabled:()=>h(IconButton,{label:"Search",icon:"?",disabled:true}) },
  { name:"Chip", render:()=>h(Chip,{mode:"yolo"}), selector:"button", text:"yolo", disabled:()=>h(Chip,{mode:"yolo",disabled:true}) },
  { name:"Input", render:()=>h(Input,{label:"Model"}), selector:"input", text:"Model", disabled:()=>h(Input,{label:"Model",disabled:true}) },
  { name:"Select", render:()=>h(Select,{label:"Pricing",options:[{value:"auto",label:"Auto"}]}), selector:"select", text:"Pricing", disabled:()=>h(Select,{label:"Pricing",options:[],disabled:true}) },
  { name:"Textarea", render:()=>h(Textarea,{label:"Message"}), selector:"textarea", text:"Message", disabled:()=>h(Textarea,{label:"Message",disabled:true}) },
  { name:"Switch", render:()=>h(Switch,{label:"Updates",checked:false,onCheckedChange:noop}), selector:"button", text:"Updates", disabled:()=>h(Switch,{label:"Updates",checked:false,onCheckedChange:noop,disabled:true}) },
  { name:"SearchInput", render:()=>h(SearchInput,{label:"Find",value:"abc",onValueChange:noop}), selector:"input", text:"Find", disabled:()=>h(SearchInput,{label:"Find",value:"abc",onValueChange:noop,disabled:true}) },
  { name:"SegmentedControl", render:()=>h(SegmentedControl,{label:"Scope",options:[{value:"a",label:"A"}],value:"a",onChange:noop}), selector:"[role=radiogroup]", text:"Scope", disabled:()=>h(SegmentedControl,{label:"Scope",options:[{value:"a",label:"A",disabled:true}],value:"a",onChange:noop}) },
  { name:"Modal", render:()=>h(Modal,{open:true,onClose:noop,title:"Confirm"},"Body"), selector:"dialog", text:"Confirm", disabled:()=>h(Modal,{open:true,onClose:noop,title:"Confirm"},action) },
  { name:"Drawer", render:()=>h(Drawer,{open:true,onClose:noop,title:"Connection"},"Body"), selector:"[role=dialog]", text:"Connection", disabled:()=>h(Drawer,{open:true,onClose:noop,title:"Connection"},action) },
  { name:"Popover", render:()=>h(Popover,{open:true,onClose:noop,position:{x:0,y:0},heading:"Access",children:h(MenuItem,{label:"Plan"})}), selector:"[role=menu]", text:"Access", disabled:()=>h(Popover,{open:true,onClose:noop,position:{x:0,y:0},children:h(MenuItem,{label:"Plan",disabled:true})}) },
  { name:"MenuItem", render:()=>h(MenuItem,{label:"Plan"}), selector:"button", text:"Plan", disabled:()=>h(MenuItem,{label:"Plan",disabled:true}) },
  { name:"Menu", render:()=>h(Menu,{label:"Actions",children:h(MenuItem,{label:"Plan"})}), selector:".ak-menu__trigger", text:"Actions", disabled:()=>h(Menu,{label:"Actions",disabled:true,children:h(MenuItem,{label:"Plan"})}) },
  { name:"Field", render:()=>h(Field,{label:"Field",children:props=>h("input",props)}), selector:"input", text:"Field", disabled:()=>h(Field,{label:"Field",children:props=>h("input",{...props,disabled:true})}) },
];
for (const c of cases) describe(c.name,()=>{
  it("renders",()=>{ expect(mount(c.render()).container.querySelector(c.selector)).not.toBeNull(); });
  it("disabled controls cannot activate",()=>{
    const {container}=mount(c.disabled()),activated=vi.fn();
    const controls=[...container.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter(el=>accessibleName(el)!=="Close");
    expect(controls.length).toBeGreaterThan(0);
    for(const control of controls){control.addEventListener("click",activated);click(control);}
    expect(activated).not.toHaveBeenCalled();
  });
  it("has an accessible name",()=>{ const {container}=mount(c.render()); expect(accessibleName(container.querySelector(c.selector)!)).toBe(c.text); });
});
// Presentational components have no disabled API; test disabled actions where supported.
const displays = [
  {name:"Badge", element:h(Badge,{status:"bad",label:"Denied"}), text:"Denied", selector:".ak-badge"},
  {name:"Banner", element:h(Banner,{tone:"bad",action,children:"Failed"}), text:"Failed", selector:"[role=alert]"},
  {name:"ContextRing", element:h(ContextRing,{value:.42,label:"42% used"}), text:"42% used", selector:"[role=img]"},
  {name:"EmptyState", element:h(EmptyState,{title:"No sessions",description:"Start one",action}), text:"No sessions", selector:".ak-empty"},
  {name:"Toast", element:h(Toast,{status:"ok",message:"Saved"}), text:"Saved", selector:"[role=status]"},
  {name:"ToastStack", element:h(ToastStack,{children:h(Toast,{status:"ok",message:"Saved"})}), text:"Saved", selector:".ak-toasts"},
  {name:"ToolCard", element:h(ToolCard,{name:"read_file",summary:"src/tokens.css",body:"content"}), text:"read_file", selector:"button"},
];
for (const c of displays) describe(c.name,()=>{
  it("renders",()=>expect(mount(c.element).container.querySelector(c.selector)).not.toBeNull());
  it("preserves disabled actions without inventing a disabled presentation state",()=>{
    const {container}=mount(c.element);
    expect(container.querySelector(c.selector)?.hasAttribute("disabled")).toBe(false);
  });
  it("provides a textual status or accessible name",()=>{
    const {container}=mount(c.element); expect(accessibleName(container.querySelector(c.selector)!)).toContain(c.text);
  });
});
it("Switch toggles and reflects checked state",()=>{
  function Harness(){const [checked,setChecked]=useState(false);return h(Switch,{checked,onCheckedChange:setChecked,label:"Updates"});}
  const {container}=mount(h(Harness));const control=byRole(container,"switch","Updates");expect(control.getAttribute("aria-checked")).toBe("false");click(control);expect(control.getAttribute("aria-checked")).toBe("true");
});
it("ToolCard supports uncontrolled and controlled expansion",()=>{
  const changed=vi.fn();const {container,render}=mount(h(ToolCard,{name:"read_file",body:"content",onExpandedChange:changed}));const button=byRole(container,"button",/read_file/);click(button);expect(button.getAttribute("aria-expanded")).toBe("true");expect(changed).toHaveBeenCalledWith(true);
  render(h(ToolCard,{name:"read_file",expanded:false,onExpandedChange:changed,body:"content"}));click(button);expect(button.getAttribute("aria-expanded")).toBe("false");
});
it("single segmented control changes aria-checked",()=>{
  function Harness(){const [value,onChange]=useState("a");return h(SegmentedControl,{label:"Scope",options:[{value:"a",label:"A"},{value:"b",label:"B"}],value,onChange});}
  const {container}=mount(h(Harness));const b=byRole(container,"radio","B");expect(b.getAttribute("aria-checked")).toBe("false");click(b);expect(b.getAttribute("aria-checked")).toBe("true");
});
it("multi segmented control toggles independently",()=>{
  function Harness(){const [value,onChange]=useState<string[]>(["low"]);return h(SegmentedControl,{label:"Effort",multiple:true,options:[{value:"low",label:"Low"},{value:"high",label:"High"}],value,onChange});}
  const {container}=mount(h(Harness));click(byRole(container,"button","High"));expect(byRole(container,"button","Low").getAttribute("aria-pressed")).toBe("true");expect(byRole(container,"button","High").getAttribute("aria-pressed")).toBe("true");
});
it("Badge and access Chip convey status with icon and word",()=>{const {container}=mount(h("div",null,h(Badge,{status:"bad",label:"Denied"}),h(Chip,{mode:"yolo"})));expect(container.querySelector(".ak-badge--bad svg")).not.toBeNull();expect(byRole(container,"button","yolo").querySelector("svg")).not.toBeNull();});
it("loading Button is busy, hides its spinner from a11y and guards activation without native disabled",()=>{
  const onClick=vi.fn();
  const host=Button({loading:true,onClick,children:"Save"}) as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  expect(host.props.disabled).toBe(true);
  // Override the host prop, not just the DOM attribute: React also suppresses
  // events based on its disabled prop, so both native and React gates must be bypassed.
  const {container,render}=mount(cloneElement(host,{disabled:false}));const button=byRole(container,"button","Save");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(accessibleName(button)).toBe("Save");
  click(button);expect(onClick).not.toHaveBeenCalled();
  render(Button({loading:false,onClick,children:"Save"}));
  expect(button.hasAttribute("aria-busy")).toBe(false);expect(button.querySelector("svg")).toBeNull();
  click(button);expect(onClick).toHaveBeenCalledTimes(1);
});
it("Toast uses polite status and assertive alert regions",()=>{const {container,render}=mount(h(Toast,{status:"ok",message:"Saved"}));expect(byRole(container,"status").getAttribute("aria-live")).toBe("polite");render(h(Toast,{status:"bad",message:"Boom",assertive:true}));expect(byRole(container,"alert").getAttribute("aria-live")).toBe("assertive");});
it("Input links label, error and invalid state",()=>{const {container}=mount(h(Input,{label:"Model",error:"Key required"}));const input=byRole(container,"textbox","Model");expect(input.getAttribute("aria-invalid")).toBe("true");expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("Key required");expect(byRole(container,"alert").textContent).toBe("Key required");});
it("SearchInput clears controlled text",()=>{function Harness(){const [value,onValueChange]=useState("abc");return h(SearchInput,{label:"Find",value,onValueChange});}const {container}=mount(h(Harness));click(byRole(container,"button","Clear"));expect((byRole(container,"searchbox","Find") as HTMLInputElement).value).toBe("");});
it("Drawer closes once on Escape and restores focus",()=>{const trigger=document.createElement("button");document.body.append(trigger);trigger.focus();const onClose=vi.fn();const {container,render}=mount(h(Drawer,{open:true,onClose,title:"Connection"},"Content"));expect(byRole(container,"dialog","Connection").getAttribute("aria-modal")).toBe("true");key("Escape");expect(onClose).toHaveBeenCalledTimes(1);render(h(Drawer,{open:false,onClose,title:"Connection"}));expect(document.activeElement).toBe(trigger);trigger.remove();});

for(const kind of ["Banner","EmptyState"] as const) it(`${kind} preserves a disabled action without calling its handler`,()=>{
  const onClick=vi.fn(),action=h(Button,{disabled:true,onClick},"Unavailable");
  const element=kind==="Banner"?h(Banner,{action,children:"Message"}):h(EmptyState,{title:"Empty",action});
  const {container}=mount(element);click(byRole(container,"button","Unavailable"));expect(onClick).not.toHaveBeenCalled();
});

it("single segmented control roves and selects with arrows", () => {
  const onChange = vi.fn();
  const {container, render} = mount(h(SegmentedControl, {label:"Mode", value:"a", onChange, options:[{value:"a",label:"A"},{value:"b",label:"B",disabled:true},{value:"c",label:"C"}]}));
  const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map(r => r.tabIndex)).toEqual([0,-1,-1]);
  radios[0]!.focus(); key("ArrowRight",radios[0]!);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("c"); expect(document.activeElement).toBe(radios[2]);
  render(h(SegmentedControl, {label:"Mode", value:"c", onChange, options:[{value:"a",label:"A"},{value:"b",label:"B",disabled:true},{value:"c",label:"C"}]}));
  expect(radios.map(r => r.tabIndex)).toEqual([-1,-1,0]);
});
