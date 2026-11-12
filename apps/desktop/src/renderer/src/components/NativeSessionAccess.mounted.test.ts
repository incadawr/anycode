// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SessionPeerBridge, SessionPeerView, SessionPeerViewResult } from "../../../shared/session-peer-view.js";
import { NativeSessionAccess } from "./NativeSessionAccess.js";
import { SessionPeersDialog } from "./SessionPeersDialog.js";
import { useNativeSessionAccess } from "./useNativeSessionAccess.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const makeView = (name: string, granted = false, available = true): SessionPeerView => ({
  available, project: { key: `/${name}`, name, enabled: true, trusted: true, granted: false },
  peers: [{ key: "/peer", name: "peer", enabled: true, trusted: true, granted }],
});
function Harness({ tabId, bridge }: { tabId: string; bridge: SessionPeerBridge }) {
  const [dialog, setDialog] = useState(false);
  const controller = useNativeSessionAccess(tabId, dialog ? "dialog" : "menu", bridge);
  return createElement("div", null, createElement(NativeSessionAccess, { controller, onManage: () => setDialog(true) }),
    createElement(SessionPeersDialog, { open: dialog, onClose: () => setDialog(false), tabId, ...controller,
      onChange: (peerKey: string, enabled: boolean) => void controller.save({ peerKey, enabled }) }));
}
async function mount(bridge: SessionPeerBridge) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = async (tabId: string) => act(async () => root.render(createElement(Harness, { tabId, bridge })));
  await render("a");
  return { host, render, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const click = async (element: Element | null) => act(async () => (element as HTMLButtonElement).click());
const manage = (host: HTMLElement) => [...host.querySelectorAll("button")].find(b => b.textContent === "Manage projects…")!;

it("shows summary and toggle, updates both views, and retains the old view after a failed save", async () => {
  let current = makeView("a");
  const bridge: SessionPeerBridge = { get: vi.fn(async (): Promise<SessionPeerViewResult> => ({ ok: true, view: current })), set: vi.fn(async (change): Promise<SessionPeerViewResult> => {
    if (!change.enabled && change.peerKey) return { ok: false, reason: "io_error" };
    current = change.peerKey ? makeView("a", true) : { ...current, project: { ...current.project, enabled: change.enabled } };
    return { ok: true, view: current };
  }) };
  const t = await mount(bridge);
  try {
    expect(t.host.textContent).toContain("Communicates with 0 projects");
    expect(t.host.querySelector(".session-peers-row")).toBeNull();
    await click(t.host.querySelector('button[aria-label="Native session access"]'));
    expect(t.host.querySelector('button[aria-label="Native session access"]')?.getAttribute("aria-checked")).toBe("false");
    await click(t.host.querySelector('button[aria-label="Native session access"]'));
    await click(manage(t.host));
    await click(t.host.querySelector('.session-peers-row button'));
    expect(t.host.textContent).toContain("Communicates with 1 project");
    expect(t.host.querySelector('.session-peers-row button')?.getAttribute("aria-checked")).toBe("true");
    await click(t.host.querySelector('.session-peers-row button'));
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("previous policy is unchanged");
    expect(t.host.querySelector('.session-peers-row button')?.getAttribute("aria-checked")).toBe("true");
  } finally { await t.close(); }
});

it("hides unavailable native access", async () => {
  const t = await mount({ get: async () => ({ ok: true, view: makeView("a", false, false) }), set: vi.fn() });
  try { expect(t.host.querySelector('[aria-label="Native session access"]')).toBeNull(); expect(manage(t.host)).toBeUndefined(); }
  finally { await t.close(); }
});

it("ignores old tab get and set responses", async () => {
  let resolveGet!: (result: SessionPeerViewResult) => void;
  let resolveSet!: (result: SessionPeerViewResult) => void;
  const bridge: SessionPeerBridge = { get: vi.fn((tab: string): Promise<SessionPeerViewResult> => tab === "a" ? new Promise<SessionPeerViewResult>(r => { resolveGet = r; }) : Promise.resolve({ ok: true, view: makeView("b") })), set: vi.fn(() => new Promise<SessionPeerViewResult>(r => { resolveSet = r; })) };
  const t = await mount(bridge);
  try {
    await t.render("b");
    await act(async () => resolveGet({ ok: true, view: makeView("a", true) }));
    expect(t.host.textContent).toContain("Communicates with 0 projects");
    await t.render("a");
    await act(async () => resolveGet({ ok: true, view: makeView("a") }));
    await click(t.host.querySelector('button[aria-label="Native session access"]'));
    await t.render("b");
    await act(async () => resolveSet({ ok: true, view: makeView("a", true) }));
    expect(t.host.textContent).toContain("Communicates with 0 projects");
    expect(t.host.querySelector('button[aria-label="Native session access"]')?.getAttribute("aria-checked")).toBe("true");
  } finally { await t.close(); }
});

it.each(["invalid", "unavailable", "io_error"] as const)("shows the %s save error", async reason => {
  const { nativeAccessText } = await import("./session-peer-model.js");
  const t = await mount({ get: async () => ({ ok: true, view: makeView("a") }), set: async () => ({ ok: false, reason }) });
  try {
    await click(t.host.querySelector('button[aria-label="Native session access"]'));
    expect(t.host.querySelector('[role="alert"]')?.textContent).toBe(nativeAccessText[reason]);
  } finally { await t.close(); }
});

it("keeps loading disabled until the view is known", async () => {
  const t = await mount({ get: () => new Promise(() => {}), set: vi.fn() });
  try {
    expect(t.host.textContent).toContain("Loading…");
    expect(t.host.querySelector<HTMLButtonElement>('button[aria-label="Native session access"]')?.disabled).toBe(true);
  } finally { await t.close(); }
});

it.each([{ enabled: false }, { trusted: false }])("marks configured grants inactive when the current project is %o", async state => {
  const base = makeView("a", true);
  const t = await mount({ get: async () => ({ ok: true, view: { ...base, project: { ...base.project, ...state } } }), set: vi.fn() });
  try {
    const summary = t.host.querySelector('.native-access-summary')!;
    // Each part is its own element, so no separator can dangle when the summary wraps.
    expect(summary.querySelector('.native-access-summary-text')?.textContent).toBe("Communicates with 1 project");
    expect(summary.querySelector('.native-access-summary-state')?.textContent).toBe("Currently inactive");
    expect(summary.textContent).not.toContain("·");
  }
  finally { await t.close(); }
});

it("describes the effect of the switch instead of a state, and styles Manage as a link", async () => {
  const base = makeView("a");
  const t = await mount({ get: async () => ({ ok: true, view: { ...base, project: { ...base.project, enabled: false } } }), set: vi.fn() });
  try {
    const row = t.host.querySelector('[role="group"][aria-label="Native session access"]')!;
    expect(row.querySelector('button[aria-label="Native session access"]')?.getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector(".environment-menu-row-detail")?.textContent).toBe("Trusted sessions here can reach peer projects");
    expect(row.querySelector(".environment-menu-row-detail")?.textContent).not.toMatch(/^On\b/);
    expect(manage(t.host).classList.contains("native-access-manage")).toBe(true);
    expect(t.host.querySelector('.native-access-summary-state')).toBeNull();
    // The help tooltip speaks plain language, in the words of the visible labels.
    const help = row.querySelector('[role="tooltip"]')?.textContent ?? "";
    expect(help).toBe("Recommended: on for trusted top-level sessions (not subagents) in this exact folder. You can switch it off for this project.");
    expect(help).not.toMatch(/root sessions|turn this project/i);
  } finally { await t.close(); }
});
