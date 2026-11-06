// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettingsStoreApi } from "../settings-store.js";
import { RUN_ACTION_EVENT, SETTINGS_ADD_CONNECTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { SETTINGS_PANES, SettingsDialog, type SettingsScreenProps } from "./SettingsScreen.js";
import { parseSettingsPaneSelection } from "./settings-extensions-navigation.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
let root: Root;
let container: HTMLDivElement;
let latest: SettingsScreenProps;
let screenMounts: number;
let subscriptions: ReturnType<typeof vi.fn>[];
let cleanups: ReturnType<typeof vi.fn>[];
let store: SettingsStoreApi;
function ScreenProbe(props: SettingsScreenProps) {
  latest = props;
  useState(() => { screenMounts++; });
  return createElement("div", { "aria-label": "Screen probe" }, props.paneRequest?.pane ?? props.initialPane ?? "provider");
}
async function render(open = false) {
  await act(async () => root.render(createElement(SettingsDialog, { open, onClose: () => {}, store, screenComponent: ScreenProbe })));
}
async function select(detail: unknown) {
  await act(async () => window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail })));
}
const request = { pane: "mcp", tabId: "origin-b", scope: "project" } as const;
const paneIds = SETTINGS_PANES.map((pane) => pane.id);
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
beforeEach(() => {
  screenMounts = 0;
  cleanups = [vi.fn(), vi.fn(), vi.fn()];
  subscriptions = cleanups.map((cleanup) => vi.fn(() => cleanup));
  store = createStore(() => ({ updateStatus: { kind: "idle" }, subscribeUpdates: subscriptions[0],
    subscribeProviderHealth: subscriptions[1], subscribeProviderQuota: subscriptions[2] })) as unknown as SettingsStoreApi;
  Object.defineProperty(window, "anycode", { configurable: true, value: { settings: {} } });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
});

it("captures a scoped request while closed and passes it on the first screen mount", async () => {
  await render();
  expect(screenMounts).toBe(0);
  await select(request);
  expect(container.querySelector("dialog")).toBeNull();
  await render(true);
  expect(screenMounts).toBe(1);
  expect(latest.paneRequest).toEqual({ ...request, token: 1 });
  expect(latest.initialPane).toBeUndefined();
  expect(container.querySelector("dialog")!.open).toBe(true);
  expect(subscriptions.every((subscribe) => subscribe.mock.calls.length === 1)).toBe(true);
});

it("captures an open/select pair in the same turn before SettingsScreen mounts", async () => {
  function Host() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const onAction = (event: Event) => { if ((event as CustomEvent).detail === "settings.open") setOpen(true); };
      window.addEventListener(RUN_ACTION_EVENT, onAction);
      return () => window.removeEventListener(RUN_ACTION_EVENT, onAction);
    }, []);
    return createElement("div", null,
      createElement("button", { onClick: () => {
        window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
        window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: request }));
      } }, "Open scoped settings"),
      createElement(SettingsDialog, { open, onClose: () => setOpen(false), store, screenComponent: ScreenProbe }));
  }
  await act(async () => root.render(createElement(Host)));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(screenMounts).toBe(1);
  expect(latest.paneRequest).toMatchObject(request);
});

it("gives identical requests fresh increasing tokens without remounting the open screen", async () => {
  await render(true);
  await select(request);
  const first = latest.paneRequest!;
  await select(request);
  expect(latest.paneRequest!.token).toBeGreaterThan(first.token);
  expect(latest.paneRequest).toMatchObject(request);
  expect(screenMounts).toBe(1);
  await render(false);
  await render(true);
  expect(latest.paneRequest!.token).toBeGreaterThan(first.token);
  expect(screenMounts).toBe(2);
});

it("consumes by token, preserves newer requests and never resets the sequence", async () => {
  await render(true);
  await select(request);
  const firstToken = latest.paneRequest!.token;
  const consume = latest.onPaneRequestConsumed!;
  await select({ ...request, pane: "skills", scope: "user" });
  const second = latest.paneRequest!;
  await act(async () => consume(firstToken));
  expect(latest.paneRequest).toEqual(second);
  await act(async () => consume(second.token));
  expect(latest.paneRequest).toBeUndefined();
  await select(request);
  expect(latest.paneRequest!.token).toBeGreaterThan(second.token);
});

it("preserves legacy strings on first open and lets the latest valid command supersede earlier requests", async () => {
  await render();
  await select("skills");
  await render(true);
  expect(latest.initialPane).toBe("skills");
  expect(latest.paneRequest).toBeUndefined();
  await select(request);
  expect(latest.initialPane).toBeUndefined();
  await select("plugins");
  expect(latest.initialPane).toBe("plugins");
  expect(latest.paneRequest).toBeUndefined();
  await select(request);
  await act(async () => window.dispatchEvent(new CustomEvent(SETTINGS_ADD_CONNECTION_EVENT)));
  expect(latest.initialPane).toBe("provider");
  expect(latest.paneRequest).toBeUndefined();
  expect(latest.addConnectionRequest).toBeGreaterThan(0);
  await select(request);
  expect(latest.paneRequest).toMatchObject(request);
  expect(latest.addConnectionRequest).toBe(0);
});

it.each([
  undefined, null, 12, "unknown", [], {}, { pane: "mcp" },
  { ...request, pane: "unknown" }, { ...request, pane: 42 },
  { ...request, scope: "workspace" }, { ...request, scope: undefined },
  { ...request, tabId: "" }, { ...request, tabId: "  " }, { ...request, tabId: 4 },
  { ...request, path: "/private/config.json" }, { ...request, token: 90 },
  Object.create(request),
].map((detail) => [detail]))("rejects invalid details without discarding a valid pending request: %j", async (detail) => {
  expect(parseSettingsPaneSelection(detail, paneIds)).toBeNull();
  await render(true);
  await select(request);
  const pending = latest.paneRequest;
  await select(detail);
  expect(latest.paneRequest).toBe(pending);
});

it("accepts every rail pane and both scopes while copying only the event's identity fields", () => {
  for (const pane of paneIds) {
    expect(parseSettingsPaneSelection(pane, paneIds)).toBe(pane);
    for (const scope of ["project", "user"] as const) {
      const detail = { pane, scope, tabId: "opaque-tab" };
      expect(parseSettingsPaneSelection(detail, paneIds)).toEqual(detail);
      expect(parseSettingsPaneSelection(detail, paneIds)).not.toBe(detail);
    }
  }
});

it("retains the latest same-turn request and copies detail before its sender mutates it", async () => {
  await render(true);
  const detail = { ...request, tabId: "original" };
  await act(async () => {
    window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: request }));
    window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail }));
    detail.tabId = "changed-after-dispatch";
  });
  expect(latest.paneRequest).toEqual({ ...request, tabId: "original", token: 2 });
});

it("removes the always-mounted listener and subscriptions on unmount", async () => {
  const remove = vi.spyOn(window, "removeEventListener");
  await render();
  await act(async () => root.unmount());
  root = createRoot(container);
  expect(remove).toHaveBeenCalledWith(SETTINGS_SELECT_PANE_EVENT, expect.any(Function));
  expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
  await select(request);
  expect(screenMounts).toBe(0);
});


it("allocates tokens only after validation and continues across legacy requests", async () => {
  await render(true);
  await select(request);
  const first = latest.paneRequest!.token;
  await select({ ...request, scope: "invalid" });
  await select(request);
  expect(latest.paneRequest!.token).toBe(first + 1);
  await select("skills");
  await select(request);
  expect(latest.paneRequest!.token).toBe(first + 3);
});
