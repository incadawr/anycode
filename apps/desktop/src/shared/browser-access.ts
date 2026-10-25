/**
 * "Full browser access" control-plane contract (Taskana 4759 owner amendment):
 * channel names and value-only types shared by main (main/browser-access*.ts),
 * the preload bridge and the renderer. ZERO imports by construction: the
 * sandboxed preload bundles this module, so it may not pull anything in.
 */

export const BROWSER_ACCESS_GET_CHANNEL = "anycode:browser-access-get";
export const BROWSER_ACCESS_SET_CHANNEL = "anycode:browser-access-set";
export const BROWSER_ACCESS_CHANGED_CHANNEL = "anycode:browser-access-changed";

/** parentPort message type main -> host: the tab's effective switch (a UX hint for skipping approval prompts). */
export const BROWSER_ACCESS_HOST_MESSAGE_TYPE = "anycode:browser-access";

/** Env stamp main writes into a tab host's fork env ("1" = on, "0" = off). */
export const BROWSER_FULL_ACCESS_ENV = "ANYCODE_BROWSER_FULL_ACCESS";

/** Why the effective value is OFF although the stored switch may be ON. */
export type BrowserAccessReason = "trust";

/** Renderer-safe state of one live tab: the EFFECTIVE (trust-gated) value only. */
export interface BrowserAccessTabState {
  tabId: string;
  fullAccess: boolean;
  reason?: BrowserAccessReason;
}

export type BrowserAccessGetResult = { ok: true; tabs: BrowserAccessTabState[] } | { ok: false; reason: "invalid" | "not_main_window" };

export type BrowserAccessSetResult =
  | { ok: true; tab: BrowserAccessTabState }
  | { ok: false; reason: "invalid" | "not_main_window" | "unknown_tab" | "io_error" };

/** Pushed on `BROWSER_ACCESS_CHANGED_CHANNEL` whenever a tab's effective value changes. */
export interface BrowserAccessChangedPayload extends BrowserAccessTabState {}

/** Host-side message: `{ type, fullAccess }`. Anything else arriving on the host is ignored. */
export interface BrowserAccessHostMessage {
  type: typeof BROWSER_ACCESS_HOST_MESSAGE_TYPE;
  fullAccess: boolean;
}
