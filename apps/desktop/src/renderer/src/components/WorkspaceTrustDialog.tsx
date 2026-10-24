/**
 * Project-trust dialog (Taskana 4736). Shown when the host reports that a
 * folder's own spawn declarations (project MCP servers, hooks, LSP servers,
 * project-tier plugin MCP) are waiting for a decision. Copy follows
 * BinaryTrustDialog: a native controlled <dialog>, Esc writes nothing.
 *
 * The answer is `{ tabId, decision }` only. Main resolves the folder and the
 * hash from the tab's own record, so this component never sends or displays a
 * hash, and the rows show command lines and env KEY names (never values).
 */
import { useEffect, useRef } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { useTabStore, useTabStoreApi } from "../tab-context.js";
import type { WorkspaceTrustRequest } from "../store.js";
import type { WorkspaceTrustDecideRequest, WorkspaceTrustDecision } from "../../../shared/workspace-trust.js";

export interface WorkspaceTrustCopy {
  title: string;
  intro: string;
  changedLine: string | null;
  rows: string[];
  buttons: readonly ["Trust", "Trust once", "Don't trust"];
}

/** Dialog copy as data, so the node-env tests pin the exact strings. */
export function describeWorkspaceTrust(request: WorkspaceTrustRequest): WorkspaceTrustCopy {
  const count = request.items.length;
  return {
    title: "Trust this project's configuration?",
    intro:
      `This folder declares ${count} process${count === 1 ? "" : "es"} that would start with your permissions, ` +
      `straight from its project files. Folder: ${request.workspace}`,
    changedLine:
      request.state === "changed"
        ? "This folder's project configuration changed since you last decided. Review it again before you trust it."
        : null,
    rows: request.items.map((item) => {
      const env = item.envKeys.length > 0 ? ` (env: ${item.envKeys.join(", ")})` : "";
      return `[${item.kind}] ${item.name}: ${item.commandLine}${env}`;
    }),
    buttons: ["Trust", "Trust once", "Don't trust"],
  };
}

/** The only thing the dialog sends back: the tab and the answer. */
export function workspaceTrustDecisionRequest(
  tabId: string,
  decision: WorkspaceTrustDecision,
): WorkspaceTrustDecideRequest {
  return { tabId, decision };
}

export interface WorkspaceTrustDialogProps {
  tabId: string;
  request: WorkspaceTrustRequest | null;
  /** Called after the answer is sent (or the dialog is dismissed without one). */
  onDone(): void;
}

export function WorkspaceTrustDialog({ tabId, request, onDone }: WorkspaceTrustDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const open = request !== null;
  useOverlayFlag(open);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) declineRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const copy = describeWorkspaceTrust(request);

  const answer = (decision: WorkspaceTrustDecision): void => {
    void window.anycode.workspaceTrust.decide(workspaceTrustDecisionRequest(tabId, decision));
    onDone();
  };

  return (
    <dialog
      ref={dialogRef}
      className="consent-dialog"
      aria-label={copy.title}
      data-workspace-trust-dialog="true"
      data-trust-state={request.state}
      onCancel={(event) => {
        // Esc writes nothing; the question returns on the next ui_ready.
        event.preventDefault();
        onDone();
      }}
    >
      <div className="consent-dialog-header">
        <span className="consent-dialog-title">{copy.title}</span>
      </div>
      <div className="consent-dialog-body">
        <p>{copy.intro}</p>
        {copy.changedLine !== null && <p>{copy.changedLine}</p>}
        <ul>
          {copy.rows.map((row) => (
            <li key={row}>
              <code>{row}</code>
            </li>
          ))}
        </ul>
      </div>
      <div className="consent-dialog-actions">
        <button ref={declineRef} type="button" onClick={() => answer("deny")}>
          {copy.buttons[2]}
        </button>
        <button type="button" onClick={() => answer("once")}>
          {copy.buttons[1]}
        </button>
        <button type="button" onClick={() => answer("trust")}>
          {copy.buttons[0]}
        </button>
      </div>
    </dialog>
  );
}

/** Reads this tab's pending question and mounts the dialog; clears it locally once answered. */
export function WorkspaceTrustPrompt({ tabId }: { tabId: string }) {
  const request = useTabStore((state) => state.workspaceTrust);
  const api = useTabStoreApi();
  return (
    <WorkspaceTrustDialog
      tabId={tabId}
      request={request}
      onDone={() => api.setState({ workspaceTrust: null })}
    />
  );
}
