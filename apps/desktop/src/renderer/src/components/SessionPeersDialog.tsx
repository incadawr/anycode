/**
 * The peer-projects dialog: which other projects this session may talk to.
 *
 * The dialog is a plain Modal — it is owned by the caller, so closing the
 * menu that opened it cannot unmount the dialog under the user.
 *
 * It renders the peers only (the current project is named once, in the
 * header) and holds no policy of its own: the caller owns the authoritative
 * view, performs the write and hands the refreshed view back. Every rule
 * that decides what is shown lives in `session-peers-dialog-model.ts`.
 */
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { Modal, SearchInput, Switch } from "../ui/index.js";
import type { NativeProjectView, SessionPeerView } from "../../../shared/session-peer-view.js";
import {
  commonReasonLine,
  commonRowReason,
  filterPeers,
  grantedSummary,
  inactiveGrantNote,
  peersDialogText,
  rowBlockedReason,
  rowReason,
  shortenPath,
  sortPeers,
} from "./session-peers-dialog-model.js";

export interface SessionPeersDialogProps {
  /** The dialog is rendered only while open. */
  open: boolean;
  onClose(): void;
  /** The tab whose peers are shown — a new tab starts with a clean search. */
  tabId: string;
  /** The authoritative peer view of the caller. */
  view?: SessionPeerView;
  /** A save is running — the controls are locked while it does. */
  busy: boolean;
  /** The last save error, shown verbatim. */
  error?: string;
  /** Ask the caller to write one peer grant. */
  onChange(peerKey: string, enabled: boolean): void;
}

export function SessionPeersDialog({ open, onClose, tabId, view, busy, error, onChange }: SessionPeersDialogProps) {
  useOverlayFlag(open);
  const [query, setQuery] = useState("");
  const searchHost = useRef<HTMLDivElement>(null);
  // The search field takes the initial focus. SearchInput does not forward a
  // ref, so the input is looked up inside the host it renders in.
  const initialFocus = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() { return searchHost.current?.querySelector<HTMLInputElement>("input") ?? null; },
  }), []);

  // The query belongs to one opening of one tab: another tab starts clean, a
  // save inside the same opening keeps what the user typed.
  useEffect(() => { setQuery(""); }, [open, tabId]);

  const project = view?.project;
  const knownPeers = useMemo(() => view?.peers ?? [], [view]);
  const rows = useMemo(() => sortPeers(filterPeers(knownPeers, query)), [knownPeers, query]);
  const commonId = useId();

  if (!open) return null;
  // One line in the header: the tail of the path, like the rows; the full key
  // is the tooltip.
  const subtitle = project ? `Current project: ${project.name} — ${shortenPath(project.key)}` : undefined;
  const note = project ? inactiveGrantNote(project, knownPeers) : undefined;
  const common = project ? commonRowReason(project, rows, busy) : undefined;

  return (
    <Modal open={open} onClose={onClose} title={peersDialogText.title} subtitle={subtitle}
      subtitleTitle={project?.key}
      initialFocusRef={initialFocus} className="session-peers-dialog">
      <div className="session-peers">
        <div ref={searchHost} className="session-peers-search">
          <SearchInput value={query} onValueChange={setQuery} label={peersDialogText.searchLabel}
            placeholder={peersDialogText.searchPlaceholder} />
        </div>
        {view && knownPeers.length > 0 && <p className="session-peers-summary">{grantedSummary(knownPeers)}</p>}
        {note && <p className="session-peers-note">{note}</p>}
        {common && <p id={commonId} className="session-peers-common-reason">{commonReasonLine(common.reason, common.count)}</p>}
        {error && <div role="alert" className="session-peers-error">{error}</div>}
        {!project && !error && <p className="session-peers-empty">{peersDialogText.loading}</p>}
        {project && knownPeers.length === 0 && <p className="session-peers-empty">{peersDialogText.noPeers}</p>}
        {project && knownPeers.length > 0 && rows.length === 0 && (
          <p className="session-peers-empty">{peersDialogText.noMatch}</p>
        )}
        {project && rows.map(peer => (
          <PeerRow key={peer.key} project={project} peer={peer} busy={busy} onChange={onChange}
            commonId={common && !peer.granted ? commonId : undefined} />
        ))}
      </div>
    </Modal>
  );
}

function PeerRow({ project, peer, busy, onChange, commonId }: {
  project: NativeProjectView;
  peer: NativeProjectView;
  busy: boolean;
  onChange(peerKey: string, enabled: boolean): void;
  /** Set when the row's reason is shown once above the list: the row points at that line. */
  commonId?: string;
}) {
  const [focused, setFocused] = useState(false);
  const reasonId = useId();
  const blocked = rowBlockedReason(project, peer, busy);
  const reason = rowReason(project, peer, busy);
  const reasonText = reason ? peersDialogText.reason[reason] : undefined;
  // Every row is the same grid (name, path, switch); the reason is a second
  // line under the path so it never takes width from the name or the path.
  const ownReason = reasonText && !commonId;
  return (
    <div className="session-peers-row" role="group" aria-label={`${peer.name} — ${peer.key}`}
      data-granted={peer.granted ? "true" : "false"}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <span className="session-peers-row-name" title={peer.name}>{peer.name}</span>
      {/* The tail of the path keeps the row on one line; the full key is
          revealed when the row takes the focus. */}
      <span className="session-peers-row-path" title={peer.key} tabIndex={0}>{focused ? peer.key : shortenPath(peer.key)}</span>
      {ownReason && (
        <span id={reasonId} className="session-peers-row-reason">
          {reason === "busy" ? reasonText : peer.granted ? `Currently inactive: ${reasonText}` : reasonText}
        </span>
      )}
      <span className="session-peers-row-switch">
        <Switch checked={peer.granted} disabled={blocked !== undefined && blocked !== "busy"} aria-disabled={busy || undefined} describedBy={commonId ?? (ownReason ? reasonId : undefined)}
          aria-label={`Communication with ${peer.name} (${peer.key})`}
          onCheckedChange={enabled => { if (!busy) onChange(peer.key, enabled); }} />
      </span>
    </div>
  );
}
