/**
 * Per-session Sessions API switch (Taskana 4747 owner amendment), shown as a row
 * in the tab's environment dropdown. The unit of exposure is the session: this
 * row toggles only THIS tab, by tabId; main resolves the session and owns the
 * state. Disabled under the env override or when the tab is unknown.
 */
import { useContext, useEffect, useState } from "react";
import { TabContext } from "../tab-context.js";
import { handleErrorText, sessionApprovalsLabel, sessionSwitchDisabledReason, sessionSwitchLabel, SESSION_APPROVALS_ARIA_LABEL, SESSION_APPROVALS_NOTE, SESSION_HANDLE_LABEL, SESSION_HANDLE_PLACEHOLDER } from "./sessions-api-model.js";
import type { CommunicationGetResult, CommunicationHandleResult, CommunicationMutationResult } from "../../../shared/communication-config.js";

export interface SessionAccessBridge {
  get(): Promise<CommunicationGetResult>;
  setSessionAccess(tabId: string, enabled: boolean): Promise<CommunicationMutationResult>;
  setSessionHandle(tabId: string, handle: string | null): Promise<CommunicationHandleResult>;
  /** Taskana 4763: the External approvals switch. Refused by main unless the session is shared. */
  setSessionApprovals(tabId: string, enabled: boolean): Promise<CommunicationMutationResult>;
}

/**
 * Taskana 4763: the External approvals checkbox. Presentational: the row decides
 * when it is shown (only while the session is shared and the row is not disabled).
 */
export function SessionApprovalsField({ approvals, onChange }: { approvals: boolean; onChange: (next: boolean) => void }) {
  return (
    <span className="environment-menu-row-main">
      <span>{sessionApprovalsLabel(approvals)}</span>
      <input
        type="checkbox"
        aria-label={SESSION_APPROVALS_ARIA_LABEL}
        data-environment-action="sessions-api-approvals"
        checked={approvals}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="environment-menu-row-detail">{SESSION_APPROVALS_NOTE}</span>
    </span>
  );
}

/**
 * Sends one handle write for a tab. Only the tabId and the trimmed text leave
 * the renderer; blank text means "clear". Validation and uniqueness are main's.
 */
export function commitSessionHandle(bridge: Pick<SessionAccessBridge, "setSessionHandle">, tabId: string, text: string): Promise<CommunicationHandleResult> {
  const trimmed = text.trim();
  return bridge.setSessionHandle(tabId, trimmed === "" ? null : trimmed);
}

export function SessionAccessRow({ bridge = window.anycode.communication }: { bridge?: SessionAccessBridge }) {
  const tabId = useContext(TabContext)?.tabId;
  const [enabled, setEnabled] = useState(false);
  const [approvals, setApprovals] = useState(false);
  const [envControlled, setEnvControlled] = useState(false);
  const [known, setKnown] = useState(false);
  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.get().then((result) => {
      if (cancelled || !result.ok) return;
      setEnvControlled(result.envControlled);
      const tab = result.view.tabs.find((candidate) => candidate.tabId === tabId);
      setKnown(tab !== undefined);
      setEnabled(tab?.enabled ?? false);
      setApprovals(tab?.approvals ?? false);
      setHandle(tab?.handle ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, tabId]);

  const reason = sessionSwitchDisabledReason(envControlled, tabId !== undefined && known);

  const commitHandle = (text: string) => {
    if (tabId === undefined) return;
    void commitSessionHandle(bridge, tabId, text).then((result) => {
      if (result.ok) {
        setHandle(result.view.tabs.find((tab) => tab.tabId === tabId)?.handle ?? "");
        setHandleError(null);
      } else {
        setHandleError(handleErrorText(result.reason));
      }
    });
  };

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
              if (result.ok) {
                const tab = result.view.tabs.find((candidate) => candidate.tabId === tabId);
                setEnabled(tab?.enabled ?? next);
                setApprovals(tab?.approvals ?? false);
              }
            });
          }}
        />
      </span>
      {enabled && reason === null && (
        <SessionApprovalsField
          approvals={approvals}
          onChange={(next) => {
            if (tabId === undefined) return;
            void bridge.setSessionApprovals(tabId, next).then((result) => {
              if (result.ok) setApprovals(result.view.tabs.find((tab) => tab.tabId === tabId)?.approvals ?? false);
            });
          }}
        />
      )}
      {enabled && reason === null && (
        <span className="environment-menu-row-main">
          <input
            type="text"
            aria-label={SESSION_HANDLE_LABEL}
            data-environment-action="sessions-api-handle"
            placeholder={SESSION_HANDLE_PLACEHOLDER}
            maxLength={200}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            onBlur={(event) => commitHandle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitHandle(event.currentTarget.value);
            }}
          />
          {handleError !== null && <span className="environment-menu-row-detail" role="alert">{handleError}</span>}
        </span>
      )}
    </div>
  );
}
