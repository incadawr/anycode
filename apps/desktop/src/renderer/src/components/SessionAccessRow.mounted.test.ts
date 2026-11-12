// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CommunicationGetResult, CommunicationMutationResult, CommunicationView } from "../../../shared/communication-config.js";
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { SessionAccessRow, type SessionAccessBridge } from "./SessionAccessRow.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewWith = (projectEnabled: boolean): CommunicationView => ({
  enabled: true, workspaces: [], missingWorkspaces: [], port: null, defaultSessionAccess: "off",
  status: { state: "listening", port: 1, sharedCount: 1 } as unknown as CommunicationView["status"],
  agentProjects: [],
  tabs: [{ tabId: "tb", enabled: true, approvals: false, projectEnabled, projectRoot: "/canonical/project" }],
});

async function mount(bridge: SessionAccessBridge) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tb", store: createDesktopStore() } }, createElement(SessionAccessRow, { bridge }))));
  return { host, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const enableButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-environment-action="sessions-api-enable-project"]');
const click = async (element: Element | null) => act(async () => (element as HTMLButtonElement).click());

function bridgeWith(set: SessionAccessBridge["agentProjectsSet"]): SessionAccessBridge {
  return {
    get: async (): Promise<CommunicationGetResult> => ({ ok: true, envControlled: false, view: viewWith(false) } as CommunicationGetResult),
    setSessionAccess: vi.fn(), setSessionHandle: vi.fn(), setSessionApprovals: vi.fn(),
    agentProjectsSet: set,
  };
}

it("a shared session in a project that is off offers Enable for the canonical project folder and clears the warning on success", async () => {
  const set = vi.fn(async (): Promise<CommunicationMutationResult> => ({ ok: true, view: viewWith(true) }));
  const t = await mount(bridgeWith(set));
  try {
    expect(t.host.textContent).toContain("Allow agents to open tasks here");
    await click(enableButton(t.host));
    expect(set).toHaveBeenCalledWith("/canonical/project", true);
    expect(enableButton(t.host)).toBeNull();
    expect(t.host.textContent).not.toContain("Allow agents to open tasks here");
  } finally { await t.close(); }
});

it("keeps the warning and the Enable button when saving the project switch fails", async () => {
  const set = vi.fn(async (): Promise<CommunicationMutationResult> => ({ ok: false, reason: "io_error" }) as CommunicationMutationResult);
  const t = await mount(bridgeWith(set));
  try {
    await click(enableButton(t.host));
    expect(set).toHaveBeenCalledWith("/canonical/project", true);
    expect(enableButton(t.host)).not.toBeNull();
    expect(t.host.textContent).toContain("Allow agents to open tasks here");
    // The failure is shown next to the button, not swallowed.
    expect(t.host.querySelector(".environment-menu-row-error")?.textContent).toBe("The settings could not be saved or the folder could not be read.");
  } finally { await t.close(); }
});
