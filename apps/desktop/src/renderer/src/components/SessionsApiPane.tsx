/**
 * Settings → Sessions API pane (Taskana 4747): enable the local MCP that lets an
 * external agent (Claude Code, Codex) list and message the sessions the user
 * switches on. Everything is main-authoritative: folders come only from the
 * native dialog (`addWorkspace` takes no arguments), the token never reaches
 * this pane, and copied configs point at the stdio adapter + discovery file.
 * All text is rendered as PLAIN TEXT.
 */
import { useEffect, useState } from "react";
import {
  SESSIONS_API_DESCRIPTION,
  SESSIONS_API_ENV_NOTE,
  SESSIONS_API_FOLDER_NOTE,
  SESSIONS_API_NOTICES,
  SESSIONS_API_REGENERATE_CONFIRM,
  copyConfigEnabled,
  folderScopeHint,
  mutationRefusalText,
  parsePortInput,
  portFieldValue,
  regenerateEnabled,
  sessionsApiStatusLine,
  settingsEditable,
} from "./sessions-api-model.js";
import type {
  CommunicationCopyClient,
  CommunicationCopyConfigResult,
  CommunicationGetResult,
  CommunicationMutationResult,
  CommunicationRegenerateResult,
  CommunicationView,
} from "../../../shared/communication-config.js";

/** Subset of `window.anycode.communication` this pane drives (injectable for tests). */
export interface CommunicationBridge {
  get(): Promise<CommunicationGetResult>;
  setEnabled(enabled: boolean): Promise<CommunicationMutationResult>;
  setPort(port: number | null): Promise<CommunicationMutationResult>;
  addWorkspace(): Promise<CommunicationMutationResult>;
  removeWorkspace(workspace: string): Promise<CommunicationMutationResult>;
  regenerateToken(): Promise<CommunicationRegenerateResult>;
  copyConfig(client: CommunicationCopyClient): Promise<CommunicationCopyConfigResult>;
  setDefaultAccess(access: "off" | "on"): Promise<CommunicationMutationResult>;
}

export interface SessionsApiPaneProps {
  bridge?: CommunicationBridge;
}

const COPY_CLIENTS: ReadonlyArray<{ client: CommunicationCopyClient; label: string }> = [
  { client: "claude-code", label: "Claude Code" },
  { client: "codex", label: "Codex" },
  { client: "generic", label: "Generic" },
];

export interface SessionsApiPaneViewProps {
  view: CommunicationView;
  envControlled: boolean;
  error: string | null;
  portText: string;
  copied: { label: string; note: string } | null;
  confirmingRegenerate: boolean;
  onToggle(enabled: boolean): void;
  onAddFolder(): void;
  onRemoveFolder(workspace: string): void;
  onPortText(text: string): void;
  onApplyPort(): void;
  onDefaultAccess(access: "off" | "on"): void;
  onCopy(client: CommunicationCopyClient, label: string): void;
  onRegenerateAsk(): void;
  onRegenerateConfirm(): void;
  onRegenerateCancel(): void;
}

/** Presentational body: every value arrives as a prop, so the render is testable without state or effects. */
export function SessionsApiPaneView(props: SessionsApiPaneViewProps) {
  const { view, envControlled, error, portText, copied, confirmingRegenerate } = props;
  const status = view.status;
  const editable = settingsEditable(envControlled);
  const hint = folderScopeHint(view);
  return (
    <section className="settings-section sessions-api-pane" aria-label="Sessions API">
      <p className="sessions-api-description">{SESSIONS_API_DESCRIPTION}</p>

      {error && (
        <div className="mcp-problem-strip" role="alert">
          <span>{error}</span>
        </div>
      )}

      <label className="sessions-api-toggle">
        <input type="checkbox" checked={view.enabled} disabled={!editable} onChange={(event) => props.onToggle(event.target.checked)} />
        <span>Enable local Sessions API</span>
      </label>
      {envControlled && <p className="sessions-api-note">{SESSIONS_API_ENV_NOTE}</p>}

      <p className="sessions-api-status" aria-live="polite">{sessionsApiStatusLine(status, envControlled)}</p>

      <div className="sessions-api-folders">
        <h4>Allowed folders (optional)</h4>
        <p className="sessions-api-note">{SESSIONS_API_FOLDER_NOTE}</p>
        {hint && <p className="sessions-api-note">{hint}</p>}
        <ul>
          {view.workspaces.map((workspace) => (
            <li key={workspace}>
              <span className="sessions-api-folder-path">{workspace}</span>
              <button type="button" disabled={!editable} onClick={() => props.onRemoveFolder(workspace)}>Remove</button>
            </li>
          ))}
        </ul>
        <button type="button" disabled={!editable} onClick={() => props.onAddFolder()}>Add folder…</button>
      </div>

      <div className="sessions-api-port">
        <label>
          Port (empty = random free port)
          <input type="text" inputMode="numeric" value={portText} disabled={!editable} onChange={(event) => props.onPortText(event.target.value)} />
        </label>
        <button type="button" disabled={!editable} onClick={() => props.onApplyPort()}>Apply</button>
      </div>

      <div className="sessions-api-default">
        <label>
          New sessions are shared by default
          <select value={view.defaultSessionAccess} disabled={!editable} onChange={(event) => props.onDefaultAccess(event.target.value as "off" | "on")}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
      </div>

      <div className="sessions-api-copy">
        <h4>Copy MCP config</h4>
        {COPY_CLIENTS.map(({ client, label }) => (
          <button key={client} type="button" disabled={!copyConfigEnabled(status, envControlled)} onClick={() => props.onCopy(client, label)}>
            {label}
          </button>
        ))}
        {copied && (
          <div className="sessions-api-copied">
            <p>Copied the {copied.label} config to the clipboard. It points at the adapter and the discovery file; it holds no token.</p>
            {copied.note !== "" && <pre>{copied.note}</pre>}
          </div>
        )}
      </div>

      <div className="sessions-api-regenerate">
        {!confirmingRegenerate ? (
          <button type="button" disabled={!regenerateEnabled(status, envControlled)} onClick={() => props.onRegenerateAsk()}>Regenerate token</button>
        ) : (
          <div role="group" aria-label="Confirm token regeneration">
            <p>{SESSIONS_API_REGENERATE_CONFIRM}</p>
            <button type="button" onClick={() => props.onRegenerateConfirm()}>Regenerate now</button>
            <button type="button" onClick={() => props.onRegenerateCancel()}>Cancel</button>
          </div>
        )}
      </div>

      <div className="sessions-api-notices">
        {SESSIONS_API_NOTICES.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </div>
    </section>
  );
}

export function SessionsApiPane({ bridge = window.anycode.communication }: SessionsApiPaneProps) {
  const [view, setView] = useState<CommunicationView | null>(null);
  const [envControlled, setEnvControlled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portText, setPortText] = useState("");
  const [copied, setCopied] = useState<{ label: string; note: string } | null>(null);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge.get().then((result) => {
      if (cancelled || !result.ok) return;
      setView(result.view);
      setEnvControlled(result.envControlled);
      setPortText(portFieldValue(result.view.port));
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  function take(result: CommunicationMutationResult | CommunicationRegenerateResult): void {
    if (result.ok) {
      setView(result.view);
      setPortText(portFieldValue(result.view.port));
      setError(null);
      return;
    }
    setError(mutationRefusalText(result.reason) || null);
  }

  if (view === null) {
    return <section className="settings-section sessions-api-pane" aria-label="Sessions API"><p>Loading…</p></section>;
  }

  return (
    <SessionsApiPaneView
      view={view}
      envControlled={envControlled}
      error={error}
      portText={portText}
      copied={copied}
      confirmingRegenerate={confirmingRegenerate}
      onToggle={(enabled) => void bridge.setEnabled(enabled).then(take)}
      onAddFolder={() => void bridge.addWorkspace().then(take)}
      onRemoveFolder={(workspace) => void bridge.removeWorkspace(workspace).then(take)}
      onPortText={setPortText}
      onApplyPort={() => {
        const parsed = parsePortInput(portText);
        if (parsed === undefined) {
          setError(mutationRefusalText("invalid"));
          return;
        }
        void bridge.setPort(parsed).then(take);
      }}
      onDefaultAccess={(access) => void bridge.setDefaultAccess(access).then(take)}
      onCopy={(client, label) => {
        void bridge.copyConfig(client).then((result) => {
          if (!result.ok) {
            setError(result.reason === "no_adapter" ? "The stdio adapter script is not found in this build." : mutationRefusalText(result.reason) || null);
            return;
          }
          navigator.clipboard?.writeText(result.json)?.catch(() => undefined);
          setCopied({ label, note: result.note });
          setError(null);
        });
      }}
      onRegenerateAsk={() => setConfirmingRegenerate(true)}
      onRegenerateConfirm={() => {
        setConfirmingRegenerate(false);
        void bridge.regenerateToken().then(take);
      }}
      onRegenerateCancel={() => setConfirmingRegenerate(false)}
    />
  );
}
