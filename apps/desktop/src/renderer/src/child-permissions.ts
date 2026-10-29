/**
 * GitHub #17 slice E: child permission asks answered from the
 * PARENT's window.
 *
 * The child's real permission request already reaches the renderer on the
 * child's own tab connection — nothing here invents a permission channel. A
 * child tab's store holds the live `permission` ask, exactly like a root
 * tab's; these helpers only (1) pick the child ask the parent's window should
 * show and (2) answer it on the CHILD's connection with the child's real
 * requestId.
 *
 * Deliberately pure and side-effect free: every store, relation table and
 * sender is injected, so tests drive the production selectors/responses with
 * fakes. The host broker stays the final authority — a stale ask is refused
 * here rather than optimistically cleared, and the child's own
 * `permission_settled` is what removes the dialog.
 */
import { childRelationKey, type ChildRelation } from "./child-sessions.js";
import type { PermissionUiRequest, TranscriptBlock } from "./store.js";
import type { EnginePresentation, UiToHostMessage } from "../../shared/protocol.js";
import { buildPermissionAllowMessage } from "./components/PermissionModal.js";

/** One live child ask the parent's window may present. */
export interface ChildPermissionOwner {
  childTabId: string;
  childSessionId: string;
  spawnToolCallId: string;
  request: PermissionUiRequest;
}

/** The small slice of a tab store these helpers read. */
export interface ChildPermissionStoreView {
  permission: PermissionUiRequest | null;
  connection: string;
  engine: EnginePresentation | null;
  /** The child's canonical workspace — the dialog shows the real path it works in. */
  workspace: string | null;
}

export interface ChildPermissionStore {
  getState(): ChildPermissionStoreView;
}

/**
 * Every live related child of `parentSessionId` that currently has a pending
 * permission ask, in relation-REGISTRATION order. A relation whose parent
 * session merely shares a string prefix never matches: the composite key is
 * validated as a whole (`childRelationKey(parent, spawn)`), not by prefix
 * alone. A gone/unready child store is skipped — its ask cannot be answered
 * from here anyway.
 */
export function collectChildPermissions(
  parentSessionId: string,
  relations: ReadonlyMap<string, ChildRelation>,
  getStore: (childTabId: string) => ChildPermissionStore | undefined,
): ChildPermissionOwner[] {
  const owners: ChildPermissionOwner[] = [];
  for (const [key, relation] of relations) {
    if (!key.startsWith(childRelationKey(parentSessionId, ""))) continue;
    if (!relation.live) continue;
    const spawnToolCallId = key.slice(childRelationKey(parentSessionId, "").length);
    // Whole-key validation: a different parent whose id happens to share this
    // prefix produces a key that does not equal the rebuilt pair.
    if (childRelationKey(parentSessionId, spawnToolCallId) !== key) continue;
    const store = getStore(relation.childTabId);
    if (store === undefined) continue;
    const state = store.getState();
    if (state.connection !== "ready" || state.permission === null) continue;
    owners.push({
      childTabId: relation.childTabId,
      childSessionId: relation.childSessionId,
      spawnToolCallId,
      request: state.permission,
    });
  }
  return owners;
}

/**
 * The stable key of one (child, ask) pair: the dialog remounts and a repeat
 * submission latch resets on a change, so an old button or keyboard callback
 * can never answer the NEXT ask. Child tab first: two children can use
 * identical requestIds.
 */
export function childPermissionSubmissionKey(childTabId: string, requestId: string): string {
  return `${childTabId}\u0000${requestId}`;
}

/** Header label for a forwarded child ask — the dialog names its owner. */
export function childPermissionOwnerLabel(
  childSessionId: string,
  spawnToolCallId?: string,
  transcript: readonly TranscriptBlock[] = [],
  backgroundChildren: readonly { childSessionId: string; description: string }[] = [],
): string {
  const call = transcript.find((block) => block.kind === "tool_call" && block.toolCallId === spawnToolCallId);
  const input = call?.kind === "tool_call" && typeof call.input === "object" && call.input !== null
    ? (call.input as { description?: unknown }).description : undefined;
  const candidates = [call?.kind === "tool_call" ? call.subagent?.description : undefined, input,
    backgroundChildren.find((child) => child.childSessionId === childSessionId)?.description];
  const description = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return `Subagent: ${description?.trim() ?? childSessionId}`;
}

/**
 * Watches every live related child store for ask/settle/connection changes.
 * Recomputes IMMEDIATELY on subscribe (closing the read/subscribe race: the ask
 * may have arrived while the relation list was rebuilt), then on every child
 * store change. Returns one cleanup that unsubscribes every listener — called
 * on relation change, tab switch and unmount, so a re-registered relation
 * never doubles the listeners.
 */
export function subscribeChildPermissions(
  parentSessionId: string,
  relations: ReadonlyMap<string, ChildRelation>,
  getStore: (childTabId: string) => ChildPermissionStore | undefined,
  onChange: (owners: ChildPermissionOwner[]) => void,
): () => void {
  const recompute = (): void => {
    onChange(collectChildPermissions(parentSessionId, relations, getStore));
  };
  const unsubscribes: Array<() => void> = [];
  for (const relation of relations.values()) {
    if (!relation.live) continue;
    const store = getStore(relation.childTabId) as
      | (ChildPermissionStore & { subscribe?: (listener: () => void) => () => void })
      | undefined;
    if (store?.subscribe === undefined) continue;
    unsubscribes.push(store.subscribe(recompute));
  }
  recompute();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * Answers one child's ask on the CHILD's own connection. Re-reads the store
 * immediately before sending and requires the same live requestId, so a click
 * delivered after the ask settled (or after a newer ask replaced it) sends
 * nothing. Returns false for every stale/unready/absent case.
 */
export function respondChildPermission(
  owner: ChildPermissionOwner,
  behavior: "allow" | "deny",
  getStore: (childTabId: string) => ChildPermissionStore | undefined,
  sendToTab: (childTabId: string, message: UiToHostMessage) => void,
  remember?: { pattern?: string },
): boolean {
  const store = getStore(owner.childTabId);
  if (store === undefined) return false;
  const state = store.getState();
  if (state.connection !== "ready") return false;
  if (state.permission === null || state.permission.requestId !== owner.request.requestId) return false;
  sendToTab(
    owner.childTabId,
    behavior === "allow"
      ? buildPermissionAllowMessage(state.permission.requestId, state.permission.toolName, remember)
      : { type: "permission_response", requestId: state.permission.requestId, behavior: "deny" },
  );
  return true;
}

/**
 * The ask to forward right now, if any. Priority: the root's OWN ask always
 * wins (it is shown by the root's own modal); a child whose pane is currently
 * displayed is suppressed because that pane shows the very same dialog; then
 * the first pending child in registration order.
 */
export function selectForwardedChildPermission(input: {
  rootHasOwnPermission: boolean;
  owners: readonly ChildPermissionOwner[];
  /** spawnToolCallIds of children whose pane is currently displayed (split's expanded row, or the single child layout). */
  displayedChildSpawnToolCallIds: readonly string[];
}): ChildPermissionOwner | null {
  if (input.rootHasOwnPermission) return null;
  const pending = input.owners.find(
    (owner) => !input.displayedChildSpawnToolCallIds.includes(owner.spawnToolCallId),
  );
  return pending ?? null;
}
