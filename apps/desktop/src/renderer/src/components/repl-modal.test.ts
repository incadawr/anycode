// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HostToUiMessage, WireAgentEvent } from "../../../shared/protocol.js";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { tabRegistry } from "../tab-registry.js";
import { Composer } from "./Composer.js";
import { ConnectedPermissionModal } from "./PermissionModal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("onlyRealNestedAskHasLabel", async () => {
  const store = createDesktopStore({ schedule: (fn) => fn() });
  const apply = (message: HostToUiMessage) => store.getState().applyHostMessage(message);
  const event = (value: WireAgentEvent) => ({ type: "agent_event", turnId: "turn", event: value } as const);
  const started = { type: "turn_started", turnId: "turn", requestId: "prompt" } as const;
  const parent = { type: "tool_call", toolCall: { id: "repl", name: "REPL", input: { code: "return 42" } } } as const;
  const running = { type: "tool_execution_start", toolCallId: "repl", toolName: "REPL", input: {} } as const;
  const child = { type: "repl_call_start", toolCallId: "repl", callId: "repl.1", toolName: "Bash", input: { fields: { command: "echo hello" } } } as const;
  const ask = {
    requestId: "request-uuid", toolName: "Bash", input: child.input.fields, mode: "build",
    metadata: { name: "Bash", description: "Run a command", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" },
  } as const;
  const label = "from a Code Mode script";
  vi.stubGlobal("anycode", { listSessions: async () => [] });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    apply({ type: "host_ready", sessionId: "session", workspace: "/project", mode: "build", model: "model" });
    apply(started);
    for (const value of [parent, running, child]) apply(event(value));
    apply(event({ type: "tool_call", toolCall: { id: "direct.1", name: "Bash", input: ask.input } }));
    apply({ type: "permission_request", ...ask, toolCallId: "direct.1" });
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } },
      createElement(Fragment, null, createElement(Composer), createElement(ConnectedPermissionModal)),
    )));
    expect(container.querySelector(".permission-modal")).not.toBeNull();
    expect(container.textContent).not.toContain(label);

    await act(async () => apply({ type: "permission_request", ...ask, toolCallId: "repl.1" }));
    expect(container.textContent).toContain(label);
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow-button")!.click());
    expect(send).toHaveBeenLastCalledWith("tab", { type: "permission_response", requestId: "request-uuid", behavior: "allow" });

    await act(async () => {
      apply({ type: "presentation_snapshot", items: [], truncated: false, historyTracksTurns: true, coveredTurnIds: ["turn"],
        turns: [{ turnId: "turn", requestId: "prompt", startedAt: 1, events: [parent, running, child].map((value) => ({ event: value, step: 1 })) }],
      });
      apply(started);
      apply({ type: "approval_state", unattended: false, pending: { ...ask, requestId: "reconnect-uuid", toolCallId: "repl.1" } });
      apply({ type: "session_checkpoint", liveTurnId: "turn", permission: { ...ask, requestId: "reconnect-uuid" } });
    });
    expect(container.textContent).toContain(label);
    expect(container.querySelector(".permission-modal")?.textContent).not.toContain("return 42");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click());
    expect(send).toHaveBeenLastCalledWith("tab", { type: "cancel_turn" });
    await act(async () => apply({ type: "permission_settled", requestId: "reconnect-uuid", behavior: "deny", origin: "turn_cancelled" }));
    expect(container.querySelector(".permission-modal")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (showModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    send.mockRestore();
    vi.unstubAllGlobals();
  }
});
