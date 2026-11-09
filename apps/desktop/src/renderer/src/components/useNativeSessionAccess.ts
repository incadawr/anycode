import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPeerBridge, SessionPeerChange, SessionPeerView } from "../../../shared/session-peer-view.js";
import { nativeAccessText as text } from "./session-peer-model.js";

export function useNativeSessionAccess(tabId: string | undefined, refresh: "menu" | "dialog" | undefined, bridge: SessionPeerBridge | undefined = window.anycode?.sessionPeers) {
  const [view, setView] = useState<SessionPeerView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const pending = useRef<{ tabId: string; id: number } | undefined>(undefined);
  const current = useRef({ tabId, view });
  current.current = { tabId, view };
  useEffect(() => {
    ++epoch.current;
    pending.current = undefined;
    setView(undefined); setError(undefined); setBusy(false);
    return () => { epoch.current++; };
  }, [tabId, bridge]);
  useEffect(() => {
    if (!refresh || !tabId || !bridge || pending.current?.tabId === tabId) return;
    const id = ++epoch.current;
    void bridge.get(tabId).then(result => {
      if (epoch.current !== id) return;
      if (result.ok) { setView(result.view); setError(undefined); } else setError(text.loadError);
    }).catch(() => { if (epoch.current === id) setError(text.loadError); });
    return () => { if (epoch.current === id) epoch.current++; };
  }, [tabId, bridge, refresh]);
  const save = useCallback(async (change: Omit<SessionPeerChange, "tabId" | "projectKey">) => {
    const snapshot = current.current;
    if (!snapshot.tabId || !snapshot.view || !bridge || busy) return;
    const id = ++epoch.current;
    pending.current = { tabId: snapshot.tabId, id };
    setBusy(true); setError(undefined);
    try {
      const result = await bridge.set({ tabId: snapshot.tabId, projectKey: snapshot.view.project.key, ...change });
      if (epoch.current !== id) return;
      if (result.ok) setView(result.view); else setError(text[result.reason]);
    } catch { if (epoch.current === id) setError(text.io_error); }
    finally { if (pending.current?.id === id) pending.current = undefined; if (epoch.current === id) setBusy(false); }
  }, [bridge, busy]);
  return { view, error, busy, save };
}
