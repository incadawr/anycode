/**
 * Host-side "Full browser access" flag (Taskana 4759). A UX hint only: when ON,
 * the browser-control tools skip their approval escalation and set `allowRemote`
 * for remote origins. MAIN stays authoritative (PreviewHost reads its own live
 * switch for every decision), so a stale host flag can at worst ask main for an
 * approval it then refuses.
 *
 * The initial value comes from the fork env main stamps (`ANYCODE_BROWSER_FULL_ACCESS`,
 * exactly "1" means ON); later changes arrive as `anycode:browser-access` messages
 * on the parentPort control plane (routed by boot.ts routePreviewMessage).
 */
import { BROWSER_FULL_ACCESS_ENV } from "../shared/browser-access.js";

export interface BrowserAccess {
  get(): boolean;
  set(value: boolean): void;
}

/** Only the exact string "1" turns the flag on at start; any other value is OFF. */
export function browserFullAccessFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[BROWSER_FULL_ACCESS_ENV] === "1";
}

export function createBrowserAccess(initial: boolean): BrowserAccess {
  let value = initial === true;
  return {
    get: () => value,
    set: (next) => {
      value = next === true;
    },
  };
}
