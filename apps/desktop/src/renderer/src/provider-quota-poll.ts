import { useEffect } from "react";

/**
 * One 60 s/visibility poll driving EVERY provider subscription quota
 * surface (MiniMax M Plan + GLM coding-plan). Main throttles each poller
 * to its own 60 s window, so refreshing both channels costs one settings
 * load and at most one HTTP GET per eligible connection per tick — a
 * connection that matches neither provider's gate fetches nothing.
 */
export function useProviderQuotaPoll(enabled: boolean, connectionId?: string): void {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void window.anycode?.settings.refreshMiniMaxQuota?.(connectionId).catch(() => {});
        void window.anycode?.settings.refreshOpenCodeGoQuota?.(connectionId).catch(() => {});
        void window.anycode?.settings.refreshGlmQuota?.(connectionId).catch(() => {});
      }
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [enabled, connectionId]);
}
