/**
 * "Full browser access" per-session switch (Taskana 4759 owner amendment), shown
 * as a row in the tab's environment dropdown beside SessionAccessRow. It toggles
 * only THIS tab, by tabId; main resolves the session and the EFFECTIVE value
 * (trust-gated). Turning it ON asks first; turning it OFF is immediate.
 */
import { useContext, useEffect, useState } from "react";
import { TabContext } from "../tab-context.js";
import type {
  BrowserAccessChangedPayload,
  BrowserAccessGetResult,
  BrowserAccessSetResult,
  BrowserAccessTabState,
} from "../../../shared/browser-access.js";
import { ConfirmDialog, type ConfirmDialogRequest } from "./ConfirmDialog.js";
import { EnvironmentMenuRow } from "./EnvironmentMenuRow.js";
import { Globe } from "./icons.js";

export interface BrowserAccessBridge {
  get(): Promise<BrowserAccessGetResult>;
  set(tabId: string, enabled: boolean): Promise<BrowserAccessSetResult>;
  onChanged(callback: (payload: BrowserAccessChangedPayload) => void): () => void;
}

/** The confirm dialog shown before the switch turns ON (OFF never asks). */
export const BROWSER_ACCESS_CONFIRM: ConfirmDialogRequest = {
  title: "Allow full browser access?",
  body: "The agent will be able to open any website, click, type (including passwords) and run JavaScript in the preview without asking. It still cannot read cookies or stored credentials.",
  confirmLabel: "Allow",
};

export const BROWSER_ACCESS_ON_DETAIL = "Agent can use any website without asking";
export const BROWSER_ACCESS_TRUST_DETAIL = "Trust this folder first";

export interface BrowserAccessRowModel {
  checked: boolean;
  disabled: boolean;
  detail: string | null;
}

/** Pure projection of the row: the checkbox, whether it is locked, and the detail line. */
export function browserAccessRowModel(state: BrowserAccessTabState | undefined, hasTab: boolean): BrowserAccessRowModel {
  if (!hasTab) return { checked: false, disabled: true, detail: "Open a session to change it." };
  if (state === undefined) return { checked: false, disabled: true, detail: null };
  if (state.reason === "trust") return { checked: false, disabled: true, detail: BROWSER_ACCESS_TRUST_DETAIL };
  return { checked: state.fullAccess, disabled: false, detail: state.fullAccess ? BROWSER_ACCESS_ON_DETAIL : null };
}

/** The header chip shows while the tab's EFFECTIVE value is on (a trust-pending folder never shows it). */
export function browserAccessChipVisible(state: BrowserAccessTabState | undefined): boolean {
  return state?.fullAccess === true;
}

/** Turning ON from OFF asks for confirmation first; every other change is sent at once. */
export function browserAccessToggleAction(current: boolean, next: boolean): "confirm" | "set" {
  return next && !current ? "confirm" : "set";
}

/** Applies a main push to the state of THIS tab only. */
export function applyBrowserAccessChange(
  state: BrowserAccessTabState | undefined,
  tabId: string,
  payload: BrowserAccessChangedPayload,
): BrowserAccessTabState | undefined {
  if (payload.tabId !== tabId) return state;
  return payload.reason === undefined
    ? { tabId, fullAccess: payload.fullAccess }
    : { tabId, fullAccess: payload.fullAccess, reason: payload.reason };
}

/** Loads the tab's effective state and follows main's pushes. Returns the state and a setter for a set result. */
export function useBrowserAccessState(
  tabId: string | undefined,
  bridge: BrowserAccessBridge,
): [BrowserAccessTabState | undefined, (state: BrowserAccessTabState) => void] {
  const [state, setState] = useState<BrowserAccessTabState | undefined>(undefined);
  useEffect(() => {
    if (tabId === undefined) return;
    let cancelled = false;
    void bridge.get().then((result) => {
      if (cancelled || !result.ok) return;
      setState(result.tabs.find((candidate) => candidate.tabId === tabId));
    });
    const off = bridge.onChanged((payload) => {
      if (!cancelled) setState((current) => applyBrowserAccessChange(current, tabId, payload));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge, tabId]);
  return [state, setState];
}

export function BrowserAccessRow({ bridge = window.anycode.browserAccess }: { bridge?: BrowserAccessBridge }) {
  const tabId = useContext(TabContext)?.tabId;
  const [state, setState] = useBrowserAccessState(tabId, bridge);
  const [confirming, setConfirming] = useState(false);
  const view = browserAccessRowModel(state, tabId !== undefined);

  function apply(next: boolean): void {
    if (tabId === undefined) return;
    void bridge.set(tabId, next).then((result) => {
      // A refused set (e.g. trust pending) leaves the shown state as main last reported it.
      if (result.ok && result.tab.tabId === tabId) setState(result.tab);
    });
  }

  return (
    <>
      <EnvironmentMenuRow
        icon={<Globe />}
        title="Full browser access"
        detail={view.detail}
        ariaLabel="Full browser access"
        control={
          <input
            type="checkbox"
            aria-label="Allow full browser access for this session"
            data-environment-action="browser-full-access"
            checked={view.checked}
            disabled={view.disabled}
            onChange={(event) => {
              const next = event.target.checked;
              if (browserAccessToggleAction(view.checked, next) === "confirm") {
                setConfirming(true);
                return;
              }
              apply(next);
            }}
          />
        }
      />
      <ConfirmDialog
        request={confirming ? BROWSER_ACCESS_CONFIRM : null}
        onConfirm={() => {
          setConfirming(false);
          apply(true);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
