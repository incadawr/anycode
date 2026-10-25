/**
 * Plugin install dialog (Taskana 4732 S1-C, design 4732 §4/§6; reconciled to
 * the S1-B wire contract): the two-phase install flow's renderer half.
 * Phase 1 (`source`/`url`) picks a source — file/folder carry NO path (main
 * opens its own picker; path custody), URL is typed here, git is stage-2
 * disabled. Phase `prepare` shows a spinner while main stages + validates.
 * Phase `confirm` renders the consent sheet: name, version, source, sha256
 * prefix, derived capabilities, a red row per MCP server (command + args),
 * and the "Install and allow MCP servers" consent checkbox (design §4).
 * Phase `error` shows the refusal message inline.
 *
 * The S1-B preview carries `engines` (range string), `hasHooks`, and
 * `mcpServers: {name, command, args}`; the command line shown on a red row
 * is joined here from command+args (main never sends env values).
 *
 * Pure label/state helpers live in plugins-pane-model.ts; this file is the
 * DOM wiring only (same split as McpServersPane/McpFormDialog).
 */
import { useEffect, useRef, useState } from "react";
import type { PluginInstallPreview, PluginInstallSource } from "../../../shared/plugins-config.js";
import { installMenuOptions, mcpServerCommandLine, pluginsRefusalMessage, sheetHasMcpServers, sheetPrimaryLabel } from "./plugins-pane-model.js";
import { Warning, X } from "./icons.js";

/** The dialog's stage machine — the pane drives it, this component renders it. */
export type InstallDialogStage =
  | { phase: "source" }
  | { phase: "url"; url: string }
  | { phase: "prepare"; source: PluginInstallSource; preview: null }
  | { phase: "confirm"; source: PluginInstallSource; preview: PluginInstallPreview; token: string; error?: string }
  | { phase: "error"; source: PluginInstallSource; error: string };

export interface PluginInstallDialogProps {
  stage: InstallDialogStage;
  onPickSource: (source: PluginInstallSource) => void;
  onSubmitUrl: (url: string) => void;
  onCommit: (token: string, allowMcp: boolean) => void;
  onClose: () => void;
}

export function PluginInstallDialog({ stage, onPickSource, onSubmitUrl, onCommit, onClose }: PluginInstallDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [urlValue, setUrlValue] = useState("");
  const [allowMcp, setAllowMcp] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  // Reset the consent checkbox whenever a fresh preview arrives.
  useEffect(() => {
    if (stage.phase === "confirm") {
      setAllowMcp(false);
    }
  }, [stage]);

  return (
    <dialog
      ref={dialogRef}
      className="mcp-form-dialog plugins-install-dialog"
      aria-label="Install plugin"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mcp-dialog-header">
        <span className="mcp-dialog-title">Install plugin</span>
        <button type="button" className="mcp-problem-dismiss" aria-label="Close" onClick={onClose}>
          <X />
        </button>
      </div>
      <InstallDialogBody
        stage={stage}
        urlValue={urlValue}
        allowMcp={allowMcp}
        onUrlValueChange={setUrlValue}
        onAllowMcpChange={setAllowMcp}
        onPickSource={onPickSource}
        onSubmitUrl={onSubmitUrl}
        onCommit={onCommit}
        onClose={onClose}
      />
    </dialog>
  );
}

/**
 * The dialog's hook-FREE presentational body — every phase renders from
 * props alone (the wrapper owns the dialog element, the URL field, and the
 * consent checkbox state). Exported so the render test can call it directly
 * under this package's no-jsdom vitest config (same direct-call idiom the
 * ConnectionDrawer test uses for its own pure subrenders).
 */
export interface InstallDialogBodyProps {
  stage: InstallDialogStage;
  urlValue: string;
  allowMcp: boolean;
  onUrlValueChange: (value: string) => void;
  onAllowMcpChange: (checked: boolean) => void;
  onPickSource: (source: PluginInstallSource) => void;
  onSubmitUrl: (url: string) => void;
  onCommit: (token: string, allowMcp: boolean) => void;
  onClose: () => void;
}

export function InstallDialogBody({
  stage,
  urlValue,
  allowMcp,
  onUrlValueChange,
  onAllowMcpChange,
  onPickSource,
  onSubmitUrl,
  onCommit,
  onClose,
}: InstallDialogBodyProps) {
  const options = installMenuOptions();

  return (
    <>
      <div className="mcp-dialog-body" data-plugins-install-phase={stage.phase}>
        {stage.phase === "source" && (
          <div className="plugins-install-menu">
            <p className="mcp-row-hint">
              Pick where the plugin comes from. Archives are verified and extracted by the app —
              the renderer never sees a filesystem path.
            </p>
            {options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="settings-button plugins-install-option"
                disabled={option.disabled}
                onClick={() => {
                  if (option.source.kind === "url") {
                    return; // url goes through the typed field below
                  }
                  onPickSource(option.source);
                }}
              >
                {option.label}
              </button>
            ))}
            <label className="settings-field">
              <span className="settings-field-label">Archive URL (.tgz, https only)</span>
              <div className="plugins-url-row">
                <input
                  className="settings-field-input"
                  type="url"
                  placeholder="https://example.com/plugin-1.0.0.tgz"
                  value={urlValue}
                  onChange={(e) => onUrlValueChange(e.target.value)}
                />
                <button
                  type="button"
                  className="settings-button settings-button-primary"
                  disabled={!/^https:\/\//.test(urlValue.trim())}
                  onClick={() => onSubmitUrl(urlValue.trim())}
                  data-plugins-url-prepare-disabled={!/^https:\/\//.test(urlValue.trim())}
                >
                  Prepare
                </button>
              </div>
            </label>
          </div>
        )}

        {stage.phase === "prepare" && <div className="settings-mcp-empty">Preparing — staging and validating the plugin…</div>}

        {stage.phase === "error" && (
          <div className="plugins-install-error" role="alert">
            <Warning />
            <span>{stage.error}</span>
            <button type="button" className="settings-button" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {stage.phase === "confirm" && (
          <>
            <div className="plugins-confirm-head">
              <span className="mcp-row-name settings-mcp-name">{stage.preview.displayName || stage.preview.name}</span>
              <span className="mcp-badge">{stage.preview.version}</span>
              {stage.preview.sha256Prefix !== undefined && (
                <span className="mcp-badge mcp-badge-user" title="Archive checksum prefix">
                  sha256 {stage.preview.sha256Prefix}…
                </span>
              )}
            </div>
            {stage.preview.description !== undefined && (
              <div className="mcp-row-hint" title={stage.preview.description}>
                {stage.preview.description}
              </div>
            )}
            <div className="plugins-confirm-row">
              <span className="settings-field-label">Source</span>
              <span>{describeSourceForSheet(stage.source, stage.preview)}</span>
            </div>
            {stage.preview.engines !== undefined && (
              <div className="plugins-confirm-row">
                <span className="settings-field-label">Requires AnyCode</span>
                <span>{stage.preview.engines}</span>
              </div>
            )}
            <div className="plugins-confirm-row">
              <span className="settings-field-label">Capabilities</span>
              <span>{stage.preview.capabilities.length === 0 ? "none" : stage.preview.capabilities.join(", ")}</span>
            </div>

            {sheetHasMcpServers(stage.preview) ? (
              <div className="plugins-mcp-consent">
                <div className="settings-field-label">MCP servers this plugin would start</div>
                {stage.preview.mcpServers.map((server) => (
                  <div key={server.name} className="plugins-mcp-server-row" role="alert">
                    <span className="settings-mcp-name">{server.name}</span>
                    <span className="mcp-row-line2">{mcpServerCommandLine(server)}</span>
                  </div>
                ))}
                <p className="mcp-row-hint">
                  These processes do not start until you allow them, and a changed command needs
                  fresh approval.
                </p>
              </div>
            ) : (
              <p className="mcp-row-hint">This plugin declares no MCP servers.</p>
            )}
            {stage.preview.hasHooks && (
              <p className="mcp-row-hint plugins-hooks-note">
                This plugin declares hooks — they stay inactive until a future stage enables them
                with their own consent.
              </p>
            )}

            {stage.error !== undefined && (
              <div className="mcp-problem-strip" role="alert">
                <span>{stage.error}</span>
              </div>
            )}
          </>
        )}
      </div>
      {stage.phase === "confirm" && (
        <div className="mcp-dialog-actions">
          <button type="button" className="settings-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="settings-button settings-button-primary"
            disabled={stage.error !== undefined}
            onClick={() => onCommit(stage.token, allowMcp)}
            data-plugins-allow-mcp={allowMcp}
          >
            {sheetPrimaryLabel(stage.preview, allowMcp)}
          </button>
          {sheetHasMcpServers(stage.preview) && (
            <label className="mcp-consent-row">
              <input
                type="checkbox"
                checked={allowMcp}
                onChange={(e) => onAllowMcpChange(e.target.checked)}
                disabled={stage.error !== undefined}
              />
              Allow this plugin's MCP servers to start
            </label>
          )}
        </div>
      )}
    </>
  );
}

/** The sheet's source line — request kind + the preview's resolved provenance. */
export function describeSourceForSheet(
  source: PluginInstallSource,
  preview: PluginInstallPreview,
): string {
  if (source.kind === "official") {
    return "AnyCode plugin index (signed)";
  }
  switch (preview.source.kind) {
    case "url":
      return preview.source.url;
    case "file":
      return "local archive file";
    case "folder":
      return "linked folder (dev)";
    default:
      return preview.source.kind;
  }
}

/** Re-exported for tests: the refusal copy used by the error stage. */
export { pluginsRefusalMessage as installRefusalMessage };
