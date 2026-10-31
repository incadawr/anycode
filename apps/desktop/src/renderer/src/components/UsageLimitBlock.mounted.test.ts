// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UsageLimitBlock } from "./MessageList.js";
import type { CodexContinueController } from "../codex-continue.js";
import type { TranscriptBlock } from "../store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block: Extract<TranscriptBlock, { kind: "usage_limit" }> = {
  kind: "usage_limit",
  id: "usage-1",
  notice: { kind: "usage_limit", code: 429, engine: "codex" },
};

it("closes the account picker once the continue succeeded, so the same conversation is not opened twice", async () => {
  const continueOn = vi.fn(async () => ({ ok: true as const }));
  const controller: CodexContinueController = {
    accounts: async () => [{ id: "account-b", label: "Account B" }],
    continueOn,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(UsageLimitBlock, { block, enterClass: " enter", codexContinue: controller }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".usage-limit-switch-account")!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".usage-limit-account-choice")!.click();
    });

    expect(continueOn).toHaveBeenCalledWith("account-b");
    expect(container.querySelector(".usage-limit-account-picker")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
