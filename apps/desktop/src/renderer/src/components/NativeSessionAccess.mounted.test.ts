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
import { NativeSessionAccess } from "./NativeSessionAccess.js";
import { SESSION_APPROVALS_ARIA_LABEL } from "./sessions-api-model.js";
import { SessionApprovalsField } from "./SessionAccessRow.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("mounted clicks write main policy; failed revoke keeps the grant and shows an error; external approval is independent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-ui-")); const file = join(dir, "policy.json");
  const policy = createSessionPeerPolicyStore({ file });
  const ipc = createSessionPeerIpc({ policy, enabled: () => true, tabs: () => [{ tabId: "a", workspace: "/alpha" }, { tabId: "b", workspace: "/beta" }], realpath: p => p, isDirectory: () => true, isTrusted: async () => true });
  const bridge = { get: (tabId: string) => ipc.get({ tabId }), set: ipc.set };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const externalApproval = vi.fn();
  try {
    await act(async () => root.render(createElement("div", null, createElement(NativeSessionAccess, { tabId: "a", bridge }), createElement(SessionApprovalsField, { approvals: false, onChange: externalApproval }))));
    expect(host.textContent).toContain("Recommended default: On"); expect(host.textContent).toContain("alpha ↔ beta"); expect(host.textContent).toContain("/alpha ↔ /beta");
    const external = Array.from(host.querySelectorAll("input")).find(input => input.getAttribute("aria-label") === SESSION_APPROVALS_ARIA_LABEL)!;
    await act(async () => external.click()); expect(externalApproval).toHaveBeenCalledWith(true);
    expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label="Native session access"]')!;
    await act(async () => toggle.click()); expect(policy.isNativeEnabled("/alpha")).toBe(false);
    await act(async () => toggle.click()); expect(policy.isNativeEnabled("/alpha")).toBe(true);
    await act(async () => host.querySelector("button")!.click()); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(true);
    rmSync(file); mkdirSync(file);
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("previous policy is unchanged");
    expect(host.querySelector("button")?.textContent).toBe("Revoke communication"); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(true);
    rmSync(file, { recursive: true });
    await act(async () => host.querySelector("button")!.click()); expect(policy.hasPairGrant("/alpha", "/beta")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); rmSync(dir, { recursive: true, force: true }); }
});
