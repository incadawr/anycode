/**
 * Per-session Sessions API switch (Taskana 4747 owner amendment), shown as rows
 * in the tab's environment dropdown. The unit of exposure is the session: the
 * switch toggles only THIS tab, by tabId; main resolves the session and owns the
 * state. Disabled under the env override or when the tab is unknown.
 *
 * The switch, the External approvals switch and the handle field are three
 * separate rows in the shared environment-menu shape (icon, title, secondary
 * line, control on the right), so nothing is clipped and the text field no
 * longer dangles beside a checkbox.
 */
import { useContext, useEffect, useState } from "react";
import { TabContext } from "../tab-context.js";
import { handleErrorText, sessionApprovalsLabel, sessionSwitchDetail, sessionSwitchDisabledReason, SESSION_APPROVALS_ARIA_LABEL, SESSION_APPROVALS_NOTE, SESSION_HANDLE_DETAIL, SESSION_HANDLE_HINT, SESSION_HANDLE_LABEL, SESSION_HANDLE_PLACEHOLDER, SESSION_SWITCH_TITLE } from "./sessions-api-model.js";
import type { CommunicationGetResult, CommunicationHandleResult, CommunicationMutationResult } from "../../../shared/communication-config.js";
import { EnvironmentMenuRow } from "./EnvironmentMenuRow.js";
import { Check, Pencil, Robot } from "./icons.js";

export interface SessionAccessBridge {
  get(): Promise<CommunicationGetResult>;
  setSessionAccess(tabId: string, enabled: boolean): Promise<CommunicationMutationResult>;
  setSessionHandle(tabId: string, handle: string | null): Promise<CommunicationHandleResult>;
  /** Taskana 4763: the External approvals switch. Refused by main unless the session is shared. */
  setSessionApprovals(tabId: string, enabled: boolean): Promise<CommunicationMutationResult>;
}

/**
 * Taskana 4763: the External approvals row. Presentational: the caller decides
 * when it is shown (only while the session is shared and the row is not
 * disabled). The long caption is the row's secondary line and wraps in full.
 */
export function SessionApprovalsField({ approvals, onChange }: { approvals: boolean; onChange: (next: boolean) => void }) {
  return (
    <EnvironmentMenuRow
      icon={<Check />}
      title={sessionApprovalsLabel(approvals)}
      detail={SESSION_APPROVALS_NOTE}
      ariaLabel="External approvals"
      control={
        <input
          type="checkbox"
          aria-label={SESSION_APPROVALS_ARIA_LABEL}
          data-environment-action="sessions-api-approvals"
          checked={approvals}
          onChange={(event) => onChange(event.target.checked)}
        />
      }
    />
  );
}

/** The handle row: labelled field on the right, its explanation on the tooltip and the secondary line. */
export function SessionHandleField({
  value,
  error,
  onChange,
  onCommit,
}: {
  value: string;
  error: string | null;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
}) {
  return (
    <EnvironmentMenuRow
      icon={<Pencil />}
      title={SESSION_HANDLE_LABEL}
      detail={SESSION_HANDLE_DETAIL}
      detailTitle={SESSION_HANDLE_HINT}
      ariaLabel="Session handle"
      error={error}
      control={
        <input
          type="text"
          className="environment-menu-text-input"
          aria-label={SESSION_HANDLE_LABEL}
          data-environment-action="sessions-api-handle"
          placeholder={SESSION_HANDLE_PLACEHOLDER}
          title={SESSION_HANDLE_HINT}
          maxLength={200}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onCommit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit(event.currentTarget.value);
          }}
        />
      }
    />
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
    <div className="environment-menu-section">
      <EnvironmentMenuRow
        icon={<Robot />}
        title={SESSION_SWITCH_TITLE}
        detail={reason ?? sessionSwitchDetail(enabled)}
        ariaLabel="Sessions API"
        control={
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
        }
      />
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
        <SessionHandleField value={handle} error={handleError} onChange={setHandle} onCommit={commitHandle} />
      )}
    </div>
  );
}
