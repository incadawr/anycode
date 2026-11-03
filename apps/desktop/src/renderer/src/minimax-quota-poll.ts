import { useEffect } from "react";

export function useMiniMaxQuotaPoll(enabled: boolean, connectionId?: string): void {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void window.anycode?.settings.refreshMiniMaxQuota?.(connectionId).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [enabled, connectionId]);
}
