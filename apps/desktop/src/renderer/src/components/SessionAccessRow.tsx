/**
 * Per-session Sessions API switch (Taskana 4747 owner amendment), shown as a row
 * in the tab's environment dropdown. The unit of exposure is the session: this
 * row toggles only THIS tab, by tabId; main resolves the session and owns the
 * state. Disabled under the env override or when the tab is unknown.
 */
import { useContext, useEffect, useState } from "react";
import { TabContext } from "../tab-context.js";
import { sessionSwitchDisabledReason, sessionSwitchLabel } from "./sessions-api-model.js";
import type { CommunicationGetResult, CommunicationMutationResult } from "../../../shared/communication-config.js";

export interface SessionAccessBridge {
  get(): Promise<CommunicationGetResult>;
  setSessionAccess(tabId: string, enabled: boolean): Promise<CommunicationMutationResult>;
}

export function SessionAccessRow({ bridge = window.anycode.communication }: { bridge?: SessionAccessBridge }) {
  const tabId = useContext(TabContext)?.tabId;
  const [enabled, setEnabled] = useState(false);
  const [envControlled, setEnvControlled] = useState(false);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge.get().then((result) => {
      if (cancelled || !result.ok) return;
      setEnvControlled(result.envControlled);
      const tab = result.view.tabs.find((candidate) => candidate.tabId === tabId);
      setKnown(tab !== undefined);
      setEnabled(tab?.enabled ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, tabId]);

  const reason = sessionSwitchDisabledReason(envControlled, tabId !== undefined && known);

  return (
    <div className="environment-menu-row" role="group" aria-label="Sessions API">
      <span className="environment-menu-row-main">
        <span>{sessionSwitchLabel(enabled)}</span>
        {reason !== null && <span className="environment-menu-row-detail">{reason}</span>}
      </span>
      <span className="environment-menu-actions">
        <input
          type="checkbox"
          aria-label="Share this session with the Sessions API"
          data-environment-action="sessions-api-access"
          checked={enabled}
          disabled={reason !== null}
          onChange={(event) => {
            if (tabId === undefined) return;
            const next = event.target.checked;
            void bridge.setSessionAccess(tabId, next).then((result) => {
              if (result.ok) setEnabled(result.view.tabs.find((tab) => tab.tabId === tabId)?.enabled ?? next);
            });
          }}
        />
      </span>
    </div>
  );
}
