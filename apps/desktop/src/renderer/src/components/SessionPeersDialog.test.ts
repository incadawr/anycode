// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { NativeProjectView, SessionPeerView } from "../../../shared/session-peer-view.js";
import { SessionPeersDialog } from "./SessionPeersDialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function peer(key: string, over: Partial<NativeProjectView> = {}): NativeProjectView {
  const name = key.split("/").filter(Boolean).pop() ?? key;
  return { key, name, enabled: true, trusted: true, granted: false, ...over };
}

function view(project: Partial<NativeProjectView> = {}, peers: NativeProjectView[] = []): SessionPeerView {
  return {
    available: true,
    project: { key: "/w/current", name: "current", enabled: true, trusted: true, granted: false, ...project },
    peers,
  };
}

async function mount(props: Partial<Parameters<typeof SessionPeersDialog>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onClose = vi.fn();
  await act(async () => root.render(createElement(SessionPeersDialog, {
    open: true, onClose, tabId: "tab-1", view: view(), busy: false, error: undefined, onChange, ...props,
  })));
  return {
    host,
    onChange,
    onClose,
    async rerender(next: Partial<Parameters<typeof SessionPeersDialog>[0]>) {
      await act(async () => root.render(createElement(SessionPeersDialog, { open: true, onClose, tabId: "tab-1", view: view(), busy: false, onChange, ...props, ...next })));
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".session-peers-row")];
}

function switches(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
}

function searchInput(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('input[type="search"]')!;
}

function type(host: HTMLElement, value: string): void {
  const input = searchInput(host);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const many = Array.from({ length: 50 }, (_, index) =>
  peer(`/w/project-${String(index).padStart(2, "0")}`));

it("lists every peer with the granted ones first", async () => {
  const granted = peer("/w/granted-app", { granted: true });
  const { host, unmount } = await mount({ view: view({}, [...many, granted]) });
  try {
    expect(rows(host)).toHaveLength(51);
    expect(rows(host)[0]?.getAttribute("aria-label")).toBe("granted-app — /w/granted-app");
    expect(rows(host)[1]?.getAttribute("aria-label")).toBe("project-00 — /w/project-00");
    // The current project is named once, in the header.
    expect(host.querySelector(".ak-modal__subtitle")?.textContent).toBe("Current project: current — /w/current");
    expect(host.textContent?.match(/Current project:/g)).toHaveLength(1);
  } finally { await unmount(); }
});

it("keeps two folders with the same name apart", async () => {
  const { host, unmount } = await mount({ view: view({}, [peer("/one/app", { name: "app" }), peer("/two/app", { name: "app" })]) });
  try {
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[0]?.getAttribute("aria-label")).toBe("app — /one/app");
    expect(rows(host)[1]?.getAttribute("aria-label")).toBe("app — /two/app");
    expect(host.textContent?.match(/Current project:/g)).toHaveLength(1);
  } finally { await unmount(); }
});

it("searches by the full path and by the name, and the clear button brings every peer back", async () => {
  const { host, unmount } = await mount({ view: view({}, many) });
  try {
    await act(async () => type(host, "/w/project-07"));
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0]?.getAttribute("aria-label")).toBe("project-07 — /w/project-07");

    await act(async () => type(host, "PROJECT-1"));
    expect(rows(host).length).toBeGreaterThan(1);
    expect(rows(host).length).toBeLessThan(50);

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Clear"]')!.click());
    expect(rows(host)).toHaveLength(50);
    expect(searchInput(host).value).toBe("");
  } finally { await unmount(); }
});

it("shows the reason a peer cannot be granted", async () => {
  const { host, unmount } = await mount({ view: view({ trusted: false }, [peer("/w/other")]) });
  try {
    expect(host.textContent).toContain("This folder is not trusted");
    expect(switches(host)[0]?.disabled).toBe(true);
  } finally { await unmount(); }
});

it("shows a reason for every blocked state", async () => {
  const cases: Array<[Partial<NativeProjectView>, Partial<NativeProjectView>, string]> = [
    [{ trusted: false }, {}, "This folder is not trusted"],
    [{ enabled: false }, {}, "Native access is off for this folder"],
    [{}, { trusted: false }, "That folder is not trusted"],
    [{}, { enabled: false }, "Native access is off for that folder"],
  ];
  for (const [project, other, expected] of cases) {
    const { host, unmount } = await mount({ view: view(project, [peer("/w/other", other)]) });
    try {
      expect(host.textContent).toContain(expected);
      expect(switches(host)[0]?.disabled).toBe(true);
    } finally { await unmount(); }
  }
});

it("keeps a saved grant revocable while it is inactive", async () => {
  const granted = peer("/w/other", { granted: true, enabled: false });
  const { host, onChange, unmount } = await mount({ view: view({ enabled: false }, [granted]) });
  try {
    expect(host.textContent).toContain("Currently inactive: Native access is off for this folder");
    expect(switches(host)[0]?.disabled).toBe(false);
    await act(async () => switches(host)[0]!.click());
    expect(onChange).toHaveBeenCalledWith("/w/other", false);
  } finally { await unmount(); }
});

it("locks the rows while a save runs and shows the error of the last save", async () => {
  const { host, unmount } = await mount({
    view: view({}, [peer("/w/other", { granted: true })]),
    busy: true,
    error: "Could not save native access.",
  });
  try {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not save native access.");
    expect(host.textContent).toContain("Saving…");
    expect(switches(host)[0]?.getAttribute("aria-disabled")).toBe("true");
  } finally { await unmount(); }
});

it("tells the two empty states apart", async () => {
  const empty = await mount({ view: view({}, []) });
  try {
    expect(empty.host.textContent).toContain("No other projects are known yet");
    expect(empty.host.querySelector(".session-peers-summary")).toBeNull();
    expect(empty.host.textContent).not.toContain("No projects found");
  } finally { await empty.unmount(); }

  const noMatch = await mount({ view: view({}, many) });
  try {
    await act(async () => type(noMatch.host, "nothing-matches-this"));
    expect(noMatch.host.textContent).toContain("No projects found");
    expect(noMatch.host.textContent).not.toContain("No other projects are known yet");
  } finally { await noMatch.unmount(); }
});

it("puts the focus on the search field, keeps it in the dialog and closes on Escape", async () => {
  const { host, onClose, unmount } = await mount({ view: view({}, many) });
  try {
    expect(document.activeElement).toBe(searchInput(host));

    const dialog = host.querySelector("dialog")!;
    const focusables = [...dialog.querySelectorAll<HTMLElement>("button,input")];
    const last = focusables.at(-1)!;
    await act(async () => last.focus());
    expect(document.activeElement).toBe(last);
    await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).not.toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => searchInput(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalled();
  } finally { await unmount(); }
});

it("reveals the full path of a peer when its row takes the focus", async () => {
  const { host, unmount } = await mount({ view: view({}, [peer("/w/deep/nested/app")]) });
  try {
    const path = rows(host)[0]!.querySelector(".session-peers-row-path")!;
    expect(path.textContent).toBe("…/nested/app");
    await act(async () => switches(host)[0]!.focus());
    expect(path.textContent).toBe("/w/deep/nested/app");
  } finally { await unmount(); }
});

it("renders nothing while it is closed", async () => {
  const { host, unmount } = await mount({ open: false, view: view({}, many) });
  try {
    expect(host.querySelector("dialog")).toBeNull();
    expect(rows(host)).toHaveLength(0);
  } finally { await unmount(); }
});


it("preserves search across saves and resets it for a new tab or reopening", async () => {
  const dialog = await mount({ view: view({}, many) });
  try {
    await act(async () => type(dialog.host, "project-07"));
    await dialog.rerender({ view: view({}, [...many]) });
    expect(searchInput(dialog.host).value).toBe("project-07");
    await dialog.rerender({ tabId: "tab-2", view: view({}, many) });
    expect(searchInput(dialog.host).value).toBe("");
    await act(async () => type(dialog.host, "project-07"));
    await dialog.rerender({ open: false });
    await dialog.rerender({ open: true });
    expect(searchInput(dialog.host).value).toBe("");
  } finally { await dialog.unmount(); }
});

it("keeps a focused switch inert while saving", async () => {
  const dialog = await mount({ view: view({}, [peer("/w/other")]) });
  try {
    const control = switches(dialog.host)[0]!;
    await act(async () => control.focus());
    await dialog.rerender({ busy: true });
    expect(document.activeElement).toBe(control);
    await act(async () => control.click());
    expect(dialog.onChange).not.toHaveBeenCalled();
  } finally { await dialog.unmount(); }
});
