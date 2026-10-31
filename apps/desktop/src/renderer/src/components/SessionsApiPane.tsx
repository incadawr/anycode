/**
 * Settings → Sessions API pane (Taskana 4747): enable the local MCP that lets an
 * external agent (Claude Code, Codex) list and message the sessions the user
 * switches on. Everything is main-authoritative: folders come only from the
 * native dialog (`addWorkspace` takes no arguments), the token never reaches
 * this pane, and copied configs point at the stdio adapter + discovery file.
 * All text is rendered as PLAIN TEXT.
 *
 * Layout (top to bottom): an enable switch with a status chip; a "Connect an
 * agent" flow (only while enabled); a collapsed Advanced disclosure; one footer
 * line. The header title and subtitle come from the Settings shell.
 */
import { useEffect, useState } from "react";
import {
  SESSIONS_API_AGENT_PROJECTS_EMPTY,
  SESSIONS_API_AGENT_PROJECTS_HINT,
  SESSIONS_API_AGENT_PROJECTS_LABEL,
  SESSIONS_API_AGENT_PROJECT_ON,
  SESSIONS_API_AGENT_PROJECT_TURN_OFF,
  SESSIONS_API_ENABLE_LABEL,
  SESSIONS_API_ENV_NOTE,
  SESSIONS_API_FOLDER_HINT,
  SESSIONS_API_FOLDER_MISSING_LABEL,
  SESSIONS_API_FOLDER_MISSING_NOTE,
  SESSIONS_API_FOLDER_NOTE,
  SESSIONS_API_FOOTER,
  SESSIONS_API_NODE_HINT,
  SESSIONS_API_PORT_HINT,
  SESSIONS_API_REGENERATE_CONFIRM,
  SESSIONS_API_REGENERATE_HINT,
  SESSIONS_API_SHARE_HINT,
  copyConfigEnabled,
  mutationRefusalText,
  parsePortInput,
  portFieldValue,
  regenerateEnabled,
  sessionsApiStatusLine,
  sessionsApiStatusTone,
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
  agentProjectsOff(key: string): Promise<CommunicationMutationResult>;
}

export interface SessionsApiPaneProps {
  bridge?: CommunicationBridge;
}

const COPY_CLIENTS: ReadonlyArray<{ client: CommunicationCopyClient; label: string }> = [
  { client: "claude-code", label: "Claude Code" },
  { client: "codex", label: "Codex" },
  { client: "generic", label: "Generic" },
];

function copyClientLabel(client: CommunicationCopyClient): string {
  return COPY_CLIENTS.find((entry) => entry.client === client)?.label ?? client;
}

export interface SessionsApiPaneViewProps {
  view: CommunicationView;
  envControlled: boolean;
  error: string | null;
  portText: string;
  copyClient: CommunicationCopyClient;
  copied: { label: string; note: string } | null;
  confirmingRegenerate: boolean;
  onToggle(enabled: boolean): void;
  onAddFolder(): void;
  onRemoveFolder(workspace: string): void;
  onPortText(text: string): void;
  onApplyPort(): void;
  onAgentProjectOff(key: string): void;
  onDefaultAccess(access: "off" | "on"): void;
  onCopyClient(client: CommunicationCopyClient): void;
  onCopy(client: CommunicationCopyClient, label: string): void;
  onRegenerateAsk(): void;
  onRegenerateConfirm(): void;
  onRegenerateCancel(): void;
}

/** Presentational body: every value arrives as a prop, so the render is testable without state or effects. */
export function SessionsApiPaneView(props: SessionsApiPaneViewProps) {
  const { view, envControlled, error, portText, copyClient, copied, confirmingRegenerate } = props;
  const status = view.status;
  const editable = settingsEditable(envControlled);
  const shared = status.sessions;
  const defaultOn = view.defaultSessionAccess === "on";
  return (
    <section className="settings-section sessions-api-pane" aria-label="Sessions API">
      {error && (
        <div className="mcp-problem-strip" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="settings-field">
        <div className="settings-field-row sessions-api-enable-row">
          <button
            type="button"
            role="switch"
            aria-checked={view.enabled}
            aria-labelledby="sessions-api-enable-caption"
            className={`settings-switch${view.enabled ? " settings-switch-on" : ""}`}
            disabled={!editable}
            onClick={() => props.onToggle(!view.enabled)}
          >
            <span className="settings-switch-thumb" />
          </button>
          <span id="sessions-api-enable-caption" className="settings-switch-caption">{SESSIONS_API_ENABLE_LABEL}</span>
          <span
            className={`settings-secret-status settings-secret-status-${sessionsApiStatusTone(status, envControlled)} sessions-api-status`}
            aria-live="polite"
          >
            {sessionsApiStatusLine(status, envControlled)}
          </span>
        </div>
        {envControlled && <p className="settings-field-hint">{SESSIONS_API_ENV_NOTE}</p>}
      </div>

      {view.enabled && (
        <section className="sessions-api-connect" aria-label="Connect an agent">
          <div className="settings-section-title">Connect an agent</div>
          <ol className="sessions-api-steps">
            <li className="sessions-api-step">
              <div className="sessions-api-step-body">
                <div className="sessions-api-step-title">Choose which sessions to share</div>
                <p className="settings-field-hint">{SESSIONS_API_SHARE_HINT.replace("{count}", String(shared))}</p>
              </div>
            </li>
            <li className="sessions-api-step">
              <div className="sessions-api-step-body">
                <div className="sessions-api-step-title">Copy the config for your agent</div>
                <div className="sessions-api-copy-row">
                  <div className="connection-drawer-segmented" role="group" aria-label="Agent">
                    {COPY_CLIENTS.map(({ client, label }) => (
                      <button
                        key={client}
                        type="button"
                        className={`connection-drawer-segmented-btn${copyClient === client ? " connection-drawer-segmented-btn-selected" : ""}`}
                        aria-pressed={copyClient === client}
                        onClick={() => props.onCopyClient(client)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="settings-button settings-button-primary"
                    disabled={!copyConfigEnabled(status, envControlled)}
                    onClick={() => props.onCopy(copyClient, copyClientLabel(copyClient))}
                  >
                    Copy config
                  </button>
                </div>
                <p className="settings-field-hint">{SESSIONS_API_NODE_HINT}</p>
                {copied && (
                  <div className="settings-notice-ok sessions-api-copied">
                    <p>{`Copied the ${copied.label} config to the clipboard. It points at the adapter and the discovery file; it holds no token.`}</p>
                    {copied.note !== "" && <pre>{copied.note}</pre>}
                  </div>
                )}
              </div>
            </li>
            <li className="sessions-api-step">
              <div className="sessions-api-step-body">
                <div className="sessions-api-step-title">Paste it into your agent's MCP settings and restart the agent.</div>
              </div>
            </li>
          </ol>
        </section>
      )}

      <details className="connection-drawer-advanced sessions-api-advanced">
        <summary className="settings-section-title">Advanced</summary>

        <div className="sessions-api-row sessions-api-folders">
          <div className="sessions-api-row-main">
            <span className="settings-field-label">Allowed folders (optional)</span>
            <div className="sessions-api-row-control">
              <button type="button" className="settings-button" disabled={!editable} onClick={() => props.onAddFolder()}>Add folder…</button>
            </div>
          </div>
          {view.workspaces.length > 0 && (
            <ul className="sessions-api-folder-list">
              {view.workspaces.map((workspace) => {
                const missing = view.missingWorkspaces.includes(workspace);
                return (
                  <li key={workspace} className={missing ? "sessions-api-folder-missing" : undefined}>
                    <span className="sessions-api-folder-path">{workspace}</span>
                    {missing && (
                      <span className="settings-secret-status settings-secret-status-danger sessions-api-folder-state">
                        {SESSIONS_API_FOLDER_MISSING_LABEL}
                      </span>
                    )}
                    <button type="button" className="settings-button" disabled={!editable} onClick={() => props.onRemoveFolder(workspace)}>Remove</button>
                    {missing && <p className="settings-field-hint">{SESSIONS_API_FOLDER_MISSING_NOTE}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="settings-field-hint" title={SESSIONS_API_FOLDER_NOTE}>{SESSIONS_API_FOLDER_HINT}</p>
        </div>

        <div className="sessions-api-row sessions-api-agent-projects">
          <div className="sessions-api-row-main">
            <span className="settings-field-label">{SESSIONS_API_AGENT_PROJECTS_LABEL}</span>
          </div>
          {view.agentProjects.length > 0 ? (
            <ul className="sessions-api-folder-list">
              {view.agentProjects.map((project) => (
                <li key={project.key}>
                  <span className="sessions-api-folder-path" title={project.displayPath}>{project.name} · {project.displayPath}</span>
                  <span className="sessions-api-row-control">
                    {/* The state first, then the action that changes it — a bare "Off" read as the state. */}
                    <span className="settings-secret-status settings-secret-status-ok sessions-api-agent-project-state">
                      {SESSIONS_API_AGENT_PROJECT_ON}
                    </span>
                    <button
                      type="button"
                      className="settings-button"
                      aria-label={`Turn off agents opening tasks in ${project.name}`}
                      disabled={!editable}
                      onClick={() => props.onAgentProjectOff(project.key)}
                    >
                      {SESSIONS_API_AGENT_PROJECT_TURN_OFF}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-field-hint">{SESSIONS_API_AGENT_PROJECTS_EMPTY}</p>
          )}
          <p className="settings-field-hint">{SESSIONS_API_AGENT_PROJECTS_HINT}</p>
        </div>

        <div className="sessions-api-row">
          {/* Label and input stay in ONE control group: with `space-between` the
              label drifted to the far left and the empty input read as unlabelled. */}
          <div className="sessions-api-row-control">
            <label className="settings-field-label" htmlFor="sessions-api-port">Port</label>
            <input
              id="sessions-api-port"
              className="settings-field-input sessions-api-port-input"
              type="text"
              inputMode="numeric"
              value={portText}
              disabled={!editable}
              onChange={(event) => props.onPortText(event.target.value)}
            />
            <button type="button" className="settings-button" disabled={!editable} onClick={() => props.onApplyPort()}>Apply</button>
          </div>
          <p className="settings-field-hint">{SESSIONS_API_PORT_HINT}</p>
        </div>

        <div className="sessions-api-row">
          <div className="sessions-api-row-main">
            <span id="sessions-api-default-caption" className="settings-field-label">New sessions shared by default</span>
            <div className="sessions-api-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={defaultOn}
                aria-labelledby="sessions-api-default-caption"
                className={`settings-switch${defaultOn ? " settings-switch-on" : ""}`}
                disabled={!editable}
                onClick={() => props.onDefaultAccess(defaultOn ? "off" : "on")}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>
        </div>

        <div className="sessions-api-row">
          {!confirmingRegenerate ? (
            <>
              <div className="sessions-api-row-main">
                <span className="settings-field-label">Regenerate token</span>
                <div className="sessions-api-row-control">
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={!regenerateEnabled(status, envControlled)}
                    onClick={() => props.onRegenerateAsk()}
                  >
                    Regenerate token
                  </button>
                </div>
              </div>
              <p className="settings-field-hint">{SESSIONS_API_REGENERATE_HINT}</p>
            </>
          ) : (
            <div role="group" aria-label="Confirm token regeneration" className="sessions-api-confirm">
              <p className="settings-field-hint">{SESSIONS_API_REGENERATE_CONFIRM}</p>
              <div className="sessions-api-row-control">
                <button type="button" className="settings-button settings-button-danger" onClick={() => props.onRegenerateConfirm()}>Regenerate now</button>
                <button type="button" className="settings-button" onClick={() => props.onRegenerateCancel()}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </details>

      <p className="settings-field-hint sessions-api-footer">{SESSIONS_API_FOOTER}</p>
    </section>
  );
}

export function SessionsApiPane({ bridge = window.anycode.communication }: SessionsApiPaneProps) {
  const [view, setView] = useState<CommunicationView | null>(null);
  const [envControlled, setEnvControlled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portText, setPortText] = useState("");
  const [copyClient, setCopyClient] = useState<CommunicationCopyClient>("claude-code");
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
      copyClient={copyClient}
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
      onAgentProjectOff={(key) => void bridge.agentProjectsOff(key).then(take)}
      onDefaultAccess={(access) => void bridge.setDefaultAccess(access).then(take)}
      onCopyClient={setCopyClient}
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
