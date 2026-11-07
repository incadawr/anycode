import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { flushSync } from "react-dom";
import { RUN_ACTION_EVENT, SETTINGS_SELECT_PANE_EVENT } from "../slash-menu.js";
import { formatEnvironmentHooksDetail } from "../hooks-status.js";
import { hasCrashedLspServer } from "../lsp-status.js";
import { SessionExtensionsFooter } from "./SessionExtensionsFooter.js";
import type { SettingsPaneSelection } from "./settings-extensions-navigation.js";
import { createPortal } from "react-dom";
import { useTabContextTabId, useTabStoreApi, useTabStore, useTabSend } from "../tab-context.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Button, useRovingTabindex } from "../ui/index.js";
import { useSessionExtensions, type ExtensionCategory } from "./useSessionExtensions.js";
import { useTabsStore } from "../tabs-store.js";
import { SessionExtensionsList, SessionExtensionsLspSummary } from "./SessionExtensionsList.js";
import {
  countConfiguredMcp, countConfiguredPlugins, countConfiguredSkills, countConfiguredLsp, extensionCountText,
} from "./extensions-model.js";

export function SessionExtensionsMenu() {
  const tabId = useTabContextTabId();
  const store = useTabStoreApi();
  const send = useTabSend();
  const { open, setOpen, reads, retry, mcpRows, mcpFailed, connection, engine, lspServers, setMcpEnabled, mcpWrite, mcpBusy, mcpWritable, catalogControls } = useSessionExtensions({ tabId, store });
  const hooks = useTabStore((state) => state.hookDeclarations);
  const hookConfigError = useTabStore((state) => state.hookConfigError);
  const core = engine === null;
  const id = useId();
  const warningId = `${id}-warning`;
  const lspCrashed = engine === null && hasCrashedLspServer(lspServers);
  const failed = mcpFailed || lspCrashed;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const details = useRef<HTMLDivElement>(null);
  const categoryList = useRef<HTMLDivElement>(null);
  const lastCategory = useRef(new Map<string, number>());
  const returnTo = useRef<number | null>(null);
  const tabExit = useRef(false);
  const [selection, setSelection] = useState<{ index: number; focus: boolean } | null>(null);
  const [narrow, setNarrow] = useState(window.innerWidth < 600);
  const roving = useRovingTabindex({ count: core ? 5 : 4, onActiveIndexChange: (index) => rows.current[index]?.focus() });
  useOverlayFlag(open);
  const select = (index: number, focus = true) => {
    lastCategory.current.set(tabId, index);
    setSelection({ index, focus });
  };
  const initialIndex = () => Math.min(lastCategory.current.get(tabId) ?? 0, core ? 4 : 3);
  const show = () => {
    roving.setActiveIndex(initialIndex());
    setSelection(narrow ? null : { index: initialIndex(), focus: false });
    setOpen(true);
  };
  const back = () => {
    returnTo.current = selection?.index ?? 0;
    setSelection(narrow ? null : { index: selection?.index ?? 0, focus: false });
  };
  const exitOnBlur = (event: FocusEvent<HTMLElement>) => {
    if (!tabExit.current) return;
    const next = event.relatedTarget as Node | null;
    if (!panel.current?.contains(next) && !trigger.current?.contains(next)) setOpen(false);
  };
  useEffect(() => {
    tabExit.current = false;
    if (!open) setSelection(null);
  }, [open]);
  useLayoutEffect(() => {
    if (selection?.focus) details.current?.focus();
    if (returnTo.current !== null) {
      rows.current[returnTo.current]?.focus();
      returnTo.current = null;
    }
  }, [selection]);
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth < 600;
      if (next && !narrow && selection && categoryList.current?.contains(document.activeElement)) {
        setSelection({ ...selection, focus: true });
      }
      if (!next && !selection) setSelection({ index: initialIndex(), focus: false });
      setNarrow(next);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [narrow, selection]);

  useLayoutEffect(() => {
    if (!open) return;
    rows.current[initialIndex()]?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!panel.current || !trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const rect = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8))}px`;
      panel.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      tabExit.current = false;
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      tabExit.current = event.key === "Tab";
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, setOpen]);

  const manage = (pane: SettingsPaneSelection["pane"], scope: "project" | "user") => {
    flushSync(() => setOpen(false));
    trigger.current?.focus();
    window.dispatchEvent(new CustomEvent(SETTINGS_SELECT_PANE_EVENT, { detail: { pane, tabId, scope } }));
    window.dispatchEvent(new CustomEvent(RUN_ACTION_EVENT, { detail: "settings.open" }));
  };
  const categories = [
    ["MCP", extensionCountText(reads.mcp, countConfiguredMcp)],
    ["Plugins", extensionCountText(reads.plugins, countConfiguredPlugins)],
    ["Skills", extensionCountText(reads.skills, countConfiguredSkills)],
    ["LSP", extensionCountText(reads.lsp, countConfiguredLsp)],
    ...(core ? [["Hooks", formatEnvironmentHooksDetail(hooks)]] : []),
  ];
  const categoryKeys: ExtensionCategory[] = ["mcp", "plugins", "skills", "lsp"];
  return <>
    <Button ref={trigger} type="button" className="session-extensions-trigger" title="Extensions"
      aria-describedby={failed ? warningId : undefined}
      aria-label="Extensions" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onBlur={exitOnBlur}
      onClick={() => { if (open) setOpen(false); else show(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          show();
        }
      }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
      </svg>
      <span className="session-extensions-label">Extensions</span>
      {failed && <><span className="session-extensions-warning session-extensions-dot tone-danger" aria-hidden="true" />
        <span id={warningId} className="session-extensions-sr">{mcpFailed && "MCP connection failed. "}{lspCrashed && "A language server crashed. "}{connection !== "ready" ? "Last reported status; host unavailable." : ""}</span></>}
    </Button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-modal="false" aria-label="Extensions"
      className={`session-extensions-panel${selection ? " has-details" : ""}`} data-layout={narrow ? "drill-down" : "columns"}
      onBlur={exitOnBlur}>
      <div className="session-extensions-heading">Configured entries</div>
      <div className="session-extensions-body">
      <div ref={categoryList} className="session-extensions-categories" hidden={narrow && selection !== null}>
      {categories.map(([label, count], index) => <Button key={label} type="button"
        ref={(element) => { rows.current[index] = element; }} className="session-extensions-category"
        data-extension-category={index === 4 ? "hooks" : categoryKeys[index]}
        aria-expanded={selection?.index === index} aria-controls={selection?.index === index ? `${id}-details` : undefined}
        tabIndex={roving.tabIndexFor(index)} onFocus={() => roving.setActiveIndex(index)}
        onClick={() => select(index)}
        onKeyDown={(event) => {
          if (["ArrowRight", "Enter", " "].includes(event.key)) { event.preventDefault(); select(index); }
          else roving.onKeyDown(index)(event);
        }}>
        <span>{label}{index === 0 && mcpFailed && <span className="session-extensions-dot tone-danger" aria-hidden="true" />}</span>
        {index === 0 && mcpFailed && <span className="session-extensions-sr">MCP connection failed</span>}<span aria-live="polite" title={index === 4 ? count : undefined}>{count}</span><span aria-hidden="true">›</span>
      </Button>)}
      </div>
      {selection && <div ref={details} id={`${id}-details`} className="session-extensions-details" tabIndex={-1}
        role="region" aria-label={categories[selection.index]![0]}
        onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); back(); } }}>
        {narrow && <Button type="button" className="session-extensions-back" onClick={back}>Back</Button>}
        <h3>{categories[selection.index]![0]}</h3>
        {selection.index === 3 && <SessionExtensionsLspSummary servers={lspServers} core={engine === null}
          ready={connection === "ready"} onRestart={() => {
            if (engine === null && connection === "ready" && hasCrashedLspServer(lspServers)) send({ type: "lsp_restart_request" });
          }} onDetails={() => {
            setOpen(false);
            useTabsStore.getState().setLspPanelOpen(tabId, true);
          }} />}
        {(selection.index === 1 || selection.index === 2) && engine !== null &&
          <p>AnyCode catalog. Availability in the current engine is not confirmed.</p>}
        {selection.index === 1 && <p>All projects; background services and account sources may change immediately.</p>}
        {selection.index === 4 && <section aria-label="Hooks summary">
          <p>{formatEnvironmentHooksDetail(hooks)}</p>
          {(hooks.length > 0 || hookConfigError !== null) && <Button type="button" data-extension-action="hooks-details"
            onClick={() => {
              setOpen(false);
              useTabsStore.getState().setHooksPanelOpen(tabId, true);
            }}>Details</Button>}
        </section>}
        {selection.index < 4 && <><SessionExtensionsList category={categoryKeys[selection.index]!} reads={reads} mcpRows={mcpRows}
          onManage={manage} catalogControls={catalogControls}
          mcpControls={{ setEnabled: setMcpEnabled, write: mcpWrite, busy: mcpBusy, writable: mcpWritable }}
          retry={(category) => { details.current?.focus(); retry(category); }} />
        <SessionExtensionsFooter key={`${tabId}:${selection.index}`} tabId={tabId} category={categoryKeys[selection.index]!}
          projectAvailable={reads.mcp.status === "ready" && reads.mcp.snapshot.projectAvailable}
          onManage={manage} /></>}
      </div>}
      </div>
    </div>, document.body)}
  </>;
}
