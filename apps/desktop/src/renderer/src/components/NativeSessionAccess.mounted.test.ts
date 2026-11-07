// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("../tab-context.js", () => ({ TabContext: { } }));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
import { createSessionPeerIpc } from "../../../main/session-peer-ipc.js";
import { createSessionPeerPolicyStore } from "../../../main/session-peer-policy.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPeerViewResult } from "../../../shared/session-peer-view.js";
import { NativeSessionAccess } from "./NativeSessionAccess.js";
import { SESSION_APPROVALS_ARIA_LABEL } from "./sessions-api-model.js";
import { SessionApprovalsField } from "./SessionAccessRow.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("mounted clicks write main policy; failed revoke keeps the grant and shows an error; external approval wiring smoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-ui-")); const file = join(dir, "policy.json");
  const policy = createSessionPeerPolicyStore({ file });
  const ipc = createSessionPeerIpc({ policy, enabled: () => true, tabs: () => [{ tabId: "a", workspace: "/alpha" }, { tabId: "b", workspace: "/beta" }], realpath: p => p, isDirectory: () => true, isTrusted: async () => true });
  const bridge = { get: (tabId: string) => ipc.get({ tabId }), set: ipc.set };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const externalApproval = vi.fn();
  try {
    await act(async () => root.render(createElement("div", null, createElement(NativeSessionAccess, { tabId: "a", bridge }), createElement(SessionApprovalsField, { approvals: false, onChange: externalApproval }))));
    expect(host.textContent).toContain("Recommended default: On"); expect(host.textContent).toContain("alpha ↔ beta"); expect(host.textContent).toContain("/alpha ↔ /beta");
    const external = Array.from(host.querySelectorAll<HTMLButtonElement>("button[role=switch]")).find(input => input.getAttribute("aria-label") === SESSION_APPROVALS_ARIA_LABEL)!;
    await act(async () => external.click()); expect(externalApproval).toHaveBeenCalledWith(true);
    expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Native session access"]')!;
    await act(async () => toggle.click()); expect(policy.isNativeEnabled("/alpha")).toBe(false);
    await act(async () => toggle.click()); expect(policy.isNativeEnabled("/alpha")).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("button.ak-btn")!.click()); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(true);
    rmSync(file); mkdirSync(file);
    await act(async () => host.querySelector<HTMLButtonElement>("button.ak-btn")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("previous policy is unchanged");
    expect(host.querySelector<HTMLButtonElement>("button.ak-btn")?.textContent).toBe("Revoke communication"); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(true);
    rmSync(file, { recursive: true });
    await act(async () => host.querySelector<HTMLButtonElement>("button.ak-btn")!.click()); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["invalid", "unavailable", "io_error"] as const)("shows an actionable %s result and exact folder labels", async reason => {
  const project = { key: "/one/src", name: "src", enabled: true, trusted: true, granted: false };
  const view = { available: true, project, peers: [{ ...project, key: "/two/src" }, { ...project, key: "/three/src" }] };
  const messages = { invalid: "The folder selection changed. Reopen this menu and try again.", unavailable: "Native access is unavailable. Check folder trust and feature availability, then reopen this menu.", io_error: "Could not save native access. The previous policy is unchanged. If storage is unreadable, repair it and restart the app." };
  const bridge = { get: async () => ({ ok: true as const, view }), set: async () => ({ ok: false as const, reason }) };
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NativeSessionAccess, { tabId: "a", bridge })));
    const rows = host.querySelectorAll('[role="group"]');
    for (const [index, peer] of view.peers.entries()) {
      expect(rows[index + 1]?.getAttribute("aria-label")).toBe(`${project.key} ↔ ${peer.key}`);
      expect(rows[index + 1]?.querySelector(".environment-menu-row-title")?.textContent).toBe(`${project.name} ↔ ${peer.name}`);
      expect(rows[index + 1]?.querySelector(".environment-menu-row-detail-prose")?.textContent).toBe(`${project.key} ↔ ${peer.key}`);
      expect(rows[index + 1]?.textContent?.split(`${project.key} ↔ ${peer.key}`)).toHaveLength(2);
    }
    await act(async () => host.querySelector<HTMLButtonElement>("button.ak-btn")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(messages[reason]);
  } finally { await act(async () => root.unmount()); }
});
it("keeps a disabled loading row until availability is known", async () => {
  let resolve!: (value: SessionPeerViewResult) => void;
  const bridge = { get: () => new Promise<SessionPeerViewResult>(r => { resolve = r; }), set: vi.fn() };
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NativeSessionAccess, { tabId: "a", bridge })));
    expect(host.textContent).not.toContain("Recommended default:");
    expect(host.textContent).toContain("Loading…");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Native session access"]')?.disabled).toBe(true);
    await act(async () => resolve({ ok: true, view: { available: false, project: { key: "/alpha", name: "alpha", enabled: true, trusted: true, granted: false }, peers: [] } }));
    expect(host.textContent).not.toContain("Recommended default:");
    expect(host.querySelector('[aria-label="Native session access"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
