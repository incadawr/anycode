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

it("explains the temporary limitation without opening the account picker", async () => {
  const accounts = vi.fn(async () => [{id:"account-b",label:"Account B"}]);
  const continueOn = vi.fn(async () => ({ok:true as const}));
  const controller: CodexContinueController = {accounts,continueOn};
  const container=document.createElement("div"); document.body.append(container);
  const root=createRoot(container);
  try {
    await act(async()=>{root.render(createElement(UsageLimitBlock,{block,enterClass:"",codexContinue:controller}));});
    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).toContain("start a new session on another Codex account");
    expect(container.querySelector(".usage-limit-account-picker")).toBeNull();
    expect(container.querySelector(".usage-limit-switch-account")).toBeNull();
    expect(accounts).not.toHaveBeenCalled(); expect(continueOn).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());container.remove();}
});

it.each([
  "This conversation already exists on the target account and may be outdated or in use. It was not opened or changed. Choose another account or review the existing conversation.",
  "The original session is no longer available. A copy was left on the target account and may be outdated or in use. A retry on that account will be blocked; choose another account or review the existing conversation.",
])("shows continuation refusal details to the user", async (detail) => {
  const controller: CodexContinueController = {
    accounts: async () => [{ id:"account-b", label:"Account B" }],
    continueOn: async () => ({ok:false, detail}),
  };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {root.render(createElement(UsageLimitBlock, {block,enterClass:"",codexContinue:controller}));});
    await act(async () => {container.querySelector<HTMLButtonElement>(".usage-limit-switch-account")!.click();});
    await act(async () => {container.querySelector<HTMLButtonElement>(".usage-limit-account-choice")!.click();});
    expect(container.querySelector(".usage-limit-account-hint")?.textContent).toBe(detail);
  } finally {await act(async()=>root.unmount()); container.remove();}
});
