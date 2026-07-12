import { useContext } from "react";
import type { CommandHookDeclaration, HookEvent } from "@anycode/core";
import { TabContext, useTabStore } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { HookIcon, Warning, X } from "./icons.js";

const EVENT_LABELS: Record<HookEvent, string> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  UserPromptSubmit: "UserPromptSubmit",
  Stop: "Stop",
  SubagentStop: "SubagentStop",
};

// Stable event order for grouping — the EVENT_LABELS key order, NOT alphabetical.
const EVENT_ORDER = Object.keys(EVENT_LABELS) as HookEvent[];

export interface HookGroup {
  event: HookEvent;
  count: number;
  hooks: readonly CommandHookDeclaration[];
}

export function formatHookEvent(event: HookEvent): string {
  return EVENT_LABELS[event];
}

export function formatHookMatcher(matcher: string | undefined): string {
  return matcher === undefined || matcher.length === 0 ? "-" : `/${matcher}/`;
}

export function formatHookTimeout(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? "default" : `${timeoutMs} ms`;
}

export function groupHooksByEvent(hooks: readonly CommandHookDeclaration[]): HookGroup[] {
  const byEvent = new Map<HookEvent, CommandHookDeclaration[]>();
  for (const hook of hooks) {
    const existing = byEvent.get(hook.event);
    if (existing) {
      existing.push(hook);
    } else {
      byEvent.set(hook.event, [hook]);
    }
  }
  return EVENT_ORDER.filter((event) => byEvent.has(event)).map((event) => {
    const eventHooks = byEvent.get(event)!;
    return { event, count: eventHooks.length, hooks: eventHooks };
  });
}

function HookRow({ hook }: { hook: CommandHookDeclaration }) {
  return (
    <div className="hooks-row">
      <div className="hooks-row-main">
        <span className="hooks-event">{formatHookEvent(hook.event)}</span>
        <span className="hooks-command" title={hook.command}>
          {hook.command}
        </span>
      </div>
      <div className="hooks-row-meta">
        <span title={formatHookMatcher(hook.matcher)}>{formatHookMatcher(hook.matcher)}</span>
        <span>{formatHookTimeout(hook.timeoutMs)}</span>
      </div>
    </div>
  );
}

function HookGroupSection({ group }: { group: HookGroup }) {
  return (
    <div className="hooks-group">
      <div className="hooks-group-header">
        <span className="hooks-group-title">{formatHookEvent(group.event)}</span>
        <span className="hooks-group-count">{group.count}</span>
      </div>
      {group.hooks.map((hook, index) => (
        <HookRow key={`${hook.event}:${hook.command}:${index}`} hook={hook} />
      ))}
    </div>
  );
}

export function HooksPanel() {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("HooksPanel must be used within a <TabContext.Provider>");
  }

  const { tabId } = ctx;
  const hooks = useTabStore((state) => state.hookDeclarations);
  const configError = useTabStore((state) => state.hookConfigError);
  const open = useTabsStore((state) => state.tabs.find((t) => t.tabId === tabId)?.hooksPanelOpen ?? false);

  if (!open) {
    return null;
  }

  function close(): void {
    useTabsStore.getState().setHooksPanelOpen(tabId, false);
  }

  const groups = groupHooksByEvent(hooks);

  return (
    <aside className="hooks-panel lsp-panel" aria-label="Hooks">
      <div className="hooks-panel-header lsp-panel-header">
        <HookIcon />
        <h2 className="lsp-panel-title">Hooks</h2>
        <button type="button" className="lsp-panel-close" aria-label="Close hooks" onClick={close}>
          <X />
        </button>
      </div>

      <div className="hooks-panel-body lsp-panel-body">
        {configError !== null && (
          <div className="hooks-error" role="alert">
            <Warning className="hooks-error-icon" />
            <span>{configError}</span>
          </div>
        )}
        {hooks.length === 0 ? (
          <div className="lsp-empty">No command hooks configured.</div>
        ) : (
          groups.map((group) => <HookGroupSection key={group.event} group={group} />)
        )}
      </div>
    </aside>
  );
}
