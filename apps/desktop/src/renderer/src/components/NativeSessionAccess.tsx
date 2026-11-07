import { useEffect, useState } from "react";
import type { SessionPeerBridge, SessionPeerChange, SessionPeerView } from "../../../shared/session-peer-view.js";
import { nativeAccessText as text } from "./session-peer-model.js";
import { EnvironmentMenuRow } from "./EnvironmentMenuRow.js";
import { Button } from "../ui/components/Button.js";
import { Switch } from "../ui/components/Switch.js";
import { Robot } from "./icons.js";

export function NativeSessionAccess({ tabId, bridge = window.anycode.sessionPeers }: { tabId: string; bridge?: SessionPeerBridge }) {
  const [view, setView] = useState<SessionPeerView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setView(undefined); setError(undefined);
    void bridge.get(tabId).then(result => {
      if (active) { if (result.ok) setView(result.view); else setError(text.loadError); }
    }).catch(() => { if (active) setError(text.loadError); });
    return () => { active = false; };
  }, [bridge, tabId]);
  async function save(change: Omit<SessionPeerChange, "tabId" | "projectKey">) {
    if (!view) return;
    setBusy(true); setError(undefined);
    try { const result = await bridge.set({ tabId, projectKey: view.project.key, ...change }); if (result.ok) setView(result.view); else setError(text[result.reason]); }
    catch { setError(text.io_error); }
    finally { setBusy(false); }
  }
  if (!view?.available && !error) return null;
  return <div className="environment-menu-section">
    {view?.available && <EnvironmentMenuRow icon={<Robot />} title={text.title} ariaLabel={text.title} detail={`${text.default} ${!view.project.trusted ? text.trust : ""}`}
      control={<Switch aria-label={text.title} checked={!!view?.available && view.project.enabled}
        disabled={busy || !view?.available || (!view.project.trusted && !view.project.enabled)} onCheckedChange={enabled => void save({ enabled })} />} />}
    {view?.available && view.peers.map(peer => <EnvironmentMenuRow key={peer.key} icon={<Robot />}
      title={`${view.project.name} ↔ ${peer.name}`} ariaLabel={`${view.project.key} ↔ ${peer.key}`} detail={`${view.project.key} ↔ ${peer.key}`}
      control={<Button variant="ghost" size="sm" disabled={busy || (!peer.granted && (!peer.trusted || !view.project.trusted || !peer.enabled || !view.project.enabled))}
        onClick={() => void save({ peerKey: peer.key, enabled: !peer.granted })}>{peer.granted ? text.revoke : text.grant}</Button>} />)}
    {error && <div role="alert" className="environment-menu-note">{error}</div>}
  </div>;
}
