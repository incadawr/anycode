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
const manage = (host: HTMLElement) => [...host.querySelectorAll("button")].find(b => b.textContent === "Manage…")!;

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
