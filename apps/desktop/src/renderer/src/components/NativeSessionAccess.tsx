import { nativeAccessText as text } from "./session-peer-model.js";
import { EnvironmentMenuRow } from "./EnvironmentMenuRow.js";
import { Button, Switch } from "../ui/index.js";
import { Robot } from "./icons.js";
import type { useNativeSessionAccess } from "./useNativeSessionAccess.js";

export function NativeSessionAccess({ controller, onManage }: {
  controller: ReturnType<typeof useNativeSessionAccess>;
  onManage(): void;
}) {
  const { view, error, busy, save } = controller;
  if (view?.available === false) return null;
  const count = view?.peers.filter(peer => peer.granted).length ?? 0;
  return <div className="environment-menu-section">
    <EnvironmentMenuRow icon={<Robot />} title={text.title} ariaLabel={text.title} help={text.default}
      detail={view?.available ? `${text.short}${!view.project.trusted ? ` ${text.trust}` : ""}` : error ? undefined : "Loading…"}
      control={<Switch aria-label={text.title} checked={!!view?.available && view.project.enabled}
        disabled={busy || !view?.available || (!view.project.trusted && !view.project.enabled)} onCheckedChange={enabled => void save({ enabled })} />} />
    {view?.available && <div className="native-access-summary">
      <span className="native-access-summary-text">Communicates with {count} {count === 1 ? "project" : "projects"}</span>{" "}
      {count > 0 && (!view.project.enabled || !view.project.trusted) && <><span className="native-access-summary-state">Currently inactive</span>{" "}</>}
      <Button variant="ghost" size="sm" className="native-access-manage" onClick={onManage}>Manage…</Button>
    </div>}
    {error && <div role="alert" className="environment-menu-note">{error}</div>}
  </div>;
}
