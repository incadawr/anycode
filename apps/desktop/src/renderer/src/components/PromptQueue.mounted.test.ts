// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TabContext } from "../tab-context.js";
import { createDesktopStore, type OrchestrationDelivery } from "../store.js";
import { PromptQueue } from "./PromptQueue.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(setup: (store: ReturnType<typeof createDesktopStore>) => void): Promise<{ element: HTMLElement; unmount(): Promise<void> }> {
  const store = createDesktopStore();
  setup(store);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(PromptQueue, {}))));
  return { element, unmount: async () => { await act(async () => root.unmount()); element.remove(); } };
}

function delivery(overrides: Partial<OrchestrationDelivery>): OrchestrationDelivery {
  return { requestId: "r1", text: "Background subagent finished with a long report", images: [], origin: "system", status: "pending", restored: false, reviewed: false, ...overrides };
}

it("shows neutral pending copy and the full title on a system delivery chip", async () => {
  const view = await mount((store) => store.setState({ orchestrationDeliveries: [delivery({})] }));
  try {
    const chip = view.element.querySelector<HTMLElement>(".prompt-queue-item-delivery")!;
    expect(chip.textContent).toContain("System report · delivered after this turn");
    expect(chip.textContent).not.toContain("will not resend");
    expect(chip.title).toBe("Background subagent finished with a long report\nWaiting for host response\nSystem report · delivered after this turn");
    expect(chip.classList.contains("prompt-queue-item-system")).toBe(true);
  } finally { await view.unmount(); }
});

it("keeps the no-resend warning for a rejected system delivery", async () => {
  const view = await mount((store) => store.setState({ orchestrationDeliveries: [delivery({ status: "rejected" })] }));
  try {
    const chip = view.element.querySelector<HTMLElement>(".prompt-queue-item-delivery")!;
    expect(chip.textContent).toContain("will not resend automatically");
    expect(chip.title).toContain("Background subagent finished with a long report");
    expect(chip.title).toContain("will not resend automatically");
  } finally { await view.unmount(); }
});

it("does not mark user delivery chips as system chips", async () => {
  const view = await mount((store) => store.setState({ orchestrationDeliveries: [delivery({ origin: undefined, text: "typed message" })] }));
  try {
    const chip = view.element.querySelector<HTMLElement>(".prompt-queue-item-delivery")!;
    expect(chip.classList.contains("prompt-queue-item-system")).toBe(false);
  } finally { await view.unmount(); }
});

it("gives a queued system report the full text as its title", async () => {
  const view = await mount((store) => store.setState({ promptQueue: [{ id: "q1", text: "Child report with a very long body", images: [], origin: "system", originId: "c1" }] }));
  try {
    const row = view.element.querySelector<HTMLElement>(".prompt-queue-list .prompt-queue-item")!;
    expect(row.title).toBe("Child report with a very long body\nSystem report · delivered after this turn");
  } finally { await view.unmount(); }
});

it("leaves an ordinary queued prompt without a title", async () => {
  const view = await mount((store) => store.setState({ promptQueue: [{ id: "q1", text: "typed", images: [] }] }));
  try {
    expect(view.element.querySelector<HTMLElement>(".prompt-queue-list .prompt-queue-item")!.title).toBe("");
  } finally { await view.unmount(); }
});
