/**
 * Pure model of the peer-projects dialog: ordering, search, the disabled
 * reasons and the copy.
 *
 * No React, no bridge, no policy: the caller owns the authoritative view and
 * performs every write. This file only answers "what does the dialog show
 * and why is a control disabled", so the same rules can be unit-tested
 * without a DOM.
 *
 * The peer view carries no recency information, so the order is
 * deterministic: granted peers first, then name, then key. Two folders with
 * the same basename stay distinct rows — the key is the identity.
 */
import type { NativeProjectView } from "../../../shared/session-peer-view.js";

/** Why a peer's control cannot be used right now, in precedence order. */
export type PeerBlockedReason =
  | "busy"
  | "current_untrusted"
  | "current_off"
  | "peer_untrusted"
  | "peer_off";

export const peersDialogText = {
  title: "Peer projects",
  searchLabel: "Search projects",
  searchPlaceholder: "Search by name or path",
  /** The search matched nothing. */
  noMatch: "No projects found",
  /** There is no other known project at all. */
  noPeers: "No other projects are known yet. Open a project in another tab to share sessions with it.",
  loading: "Loading…",
  reason: {
    busy: "Saving…",
    current_untrusted: "This folder is not trusted",
    current_off: "Native session access is off for this folder",
    peer_untrusted: "That folder is not trusted",
    peer_off: "Native session access is off for that folder",
  } as Record<PeerBlockedReason, string>,
};

/**
 * Granted peers first, then name (locale order), then key as the stable
 * tie-break — two folders named `app` never swap places between renders.
 */
export function sortPeers(peers: readonly NativeProjectView[]): NativeProjectView[] {
  return [...peers].sort((a, b) => {
    if (a.granted !== b.granted) return a.granted ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.key.localeCompare(b.key);
  });
}

/**
 * Case-insensitive match on the peer name or on the full key (the path).
 * An empty query keeps every peer.
 */
export function filterPeers(peers: readonly NativeProjectView[], query: string): NativeProjectView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...peers];
  return peers.filter(peer =>
    peer.name.toLowerCase().includes(needle) || peer.key.toLowerCase().includes(needle));
}

/** Configured grants — not a claim that the peers are reachable right now. */
export function countGranted(peers: readonly NativeProjectView[]): number {
  return peers.filter(peer => peer.granted).length;
}

/**
 * Why granting a peer is impossible, in the fixed precedence: a running save
 * wins over trust, trust wins over the native-access switch.
 */
export function grantBlockedReason(
  project: NativeProjectView,
  peer: NativeProjectView,
  busy = false,
): PeerBlockedReason | undefined {
  if (busy) return "busy";
  if (!project.trusted) return "current_untrusted";
  if (!project.enabled) return "current_off";
  if (!peer.trusted) return "peer_untrusted";
  if (!peer.enabled) return "peer_off";
  return undefined;
}

/**
 * Revoking stays possible even when one of the projects is off or untrusted:
 * only a running save blocks it.
 */
export function revokeBlockedReason(busy = false): PeerBlockedReason | undefined {
  return busy ? "busy" : undefined;
}

/** The reason shown for a row, or `undefined` when the control is usable. */
export function rowBlockedReason(
  project: NativeProjectView,
  peer: NativeProjectView,
  busy = false,
): PeerBlockedReason | undefined {
  return peer.granted ? revokeBlockedReason(busy) : grantBlockedReason(project, peer, busy);
}

/**
 * The reason a row shows. A granted peer stays operable, but it still names
 * the reason it cannot be used right now (an inactive grant).
 */
export function rowReason(
  project: NativeProjectView,
  peer: NativeProjectView,
  busy = false,
): PeerBlockedReason | undefined {
  if (!peer.granted) return grantBlockedReason(project, peer, busy);
  if (busy) return "busy";
  return grantBlockedReason(project, peer, false);
}

/** Grants that are saved but cannot be used at the moment. */
export function inactiveGrants(
  project: NativeProjectView,
  peers: readonly NativeProjectView[],
): Array<{ peer: NativeProjectView; reason: PeerBlockedReason }> {
  const inactive: Array<{ peer: NativeProjectView; reason: PeerBlockedReason }> = [];
  for (const peer of peers) {
    if (!peer.granted) continue;
    const reason = grantBlockedReason(project, peer, false);
    if (reason) inactive.push({ peer, reason });
  }
  return inactive;
}

/**
 * The reason every not-yet-granted row shares, when there are at least two of
 * them and they all agree. The dialog shows it once above the list instead of
 * repeating it on each row; rows whose reason differs keep their own.
 */
export function commonRowReason(
  project: NativeProjectView,
  rows: readonly NativeProjectView[],
  busy = false,
): { reason: PeerBlockedReason; count: number } | undefined {
  const open = rows.filter(peer => !peer.granted);
  if (open.length < 2) return undefined;
  const reason = grantBlockedReason(project, open[0]!, busy);
  if (!reason) return undefined;
  return open.every(peer => grantBlockedReason(project, peer, busy) === reason)
    ? { reason, count: open.length }
    : undefined;
}

/** The line above the list for a reason that every open row shares. */
export function commonReasonLine(reason: PeerBlockedReason, count: number): string {
  const text = peersDialogText.reason[reason];
  return reason === "busy" ? text : `${count} projects cannot be enabled: ${text}`;
}

/**
 * The deterministic tail of a path. The home directory is never abbreviated
 * to `~` — the renderer does not know it — so the tail is what stays visible
 * and the full key is always available next to it.
 */
export function shortenPath(path: string, segments = 2): string {
  if (!path) return path;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

/** The summary line: how many peers are allowed, not whether they work right now. */
export function grantedSummary(peers: readonly NativeProjectView[]): string {
  const granted = countGranted(peers);
  const total = peers.length;
  if (total === 0) return "No peer projects are known.";
  if (total === 1) return granted ? "The other project is allowed to communicate with this one." : "The other project is not allowed to communicate with this one.";
  return granted === 0
    ? `None of the ${total} projects are allowed to communicate with this one.`
    : `${granted} of ${total} projects are allowed to communicate with this one.`;
}

/** Explains an allowed project that is inactive right now (and why). */
export function inactiveGrantNote(
  project: NativeProjectView,
  peers: readonly NativeProjectView[],
): string | undefined {
  const inactive = inactiveGrants(project, peers);
  if (!inactive.length) return undefined;
  const reasons = [...new Set(inactive.map(entry => peersDialogText.reason[entry.reason]))];
  const count = inactive.length;
  return `${count} allowed ${count === 1 ? "project is" : "projects are"} not active right now (${reasons.join("; ")}).`;
}
