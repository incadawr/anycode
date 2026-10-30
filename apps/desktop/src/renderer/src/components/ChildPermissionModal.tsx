/**
 * GitHub #17 slice E: the parent window answers a CHILD
 * session's permission ask.
 *
 * Mounted once in the parent context; embedded child surfaces delegate their
 * requests to this presenter. It presents the existing
 * `PermissionModal` — same risk badge, tool input, Write/Edit preview,
 * keyboard handling — with an owner label naming the child, and answers on the
 * child's own tab connection through the pure helpers in
 * `child-permissions.ts`. No layout switch, no tab switch, no new broker.
 */
import { useEffect, useRef, useState } from "react";
import { PermissionModal, buildAlwaysAllowRule, canRememberPermission } from "./PermissionModal.js";
import {
  collectChildPermissions,
  childPermissionOwnerLabel,
  childPermissionSubmissionKey,
  respondChildPermission,
  selectForwardedChildPermission,
  subscribeChildPermissions,
  type ChildPermissionStore,
} from "../child-permissions.js";
import { childRelationStore } from "../child-sessions.js";
import { tabRegistry } from "../tab-registry.js";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import { useTabStore } from "../tab-context.js";

/** Store lookup through the tab registry, narrowed to what these helpers read. */
function childStore(tabId: string): ChildPermissionStore | undefined {
  return tabRegistry.getStore(tabId) as unknown as ChildPermissionStore | undefined;
}

export function ConnectedChildPermissionModal() {
  const rootHasOwn = useTabStore((state) => state.permission !== null);
  const parentSessionId = useTabStore((state) => state.sessionId);
  const transcript = useTabStore((state) => state.transcript);
  const backgroundChildren = useTabStore((state) => state.backgroundChildren);
  const relations = childRelationStore((state) => state.relations);
  const [, setRevision] = useState(0);
  // Read the current parent and relations on every render, so switching root
  // tabs cannot briefly expose the previous root's child request.
  const owners = parentSessionId === null ? [] : collectChildPermissions(parentSessionId, relations, childStore);
  // One submission per (child, request): a second click on a stale dialog must
  // never answer a newer ask.
  const submitted = useRef<string | null>(null);

  // Subscribe to each live child's OWN store. Recomputing immediately on
  // subscribe closes the read/subscribe race (the ask may have arrived while
  // the relation list was being rebuilt); the cleanup drops every listener on
  // relation change, tab switch and unmount.
  useEffect(() => {
    if (parentSessionId === null) {
      return undefined;
    }
    // The live relation map, read at recompute time (a relation registered
    // after this effect ran still lists through the next subscription pass).
    return subscribeChildPermissions(parentSessionId, relations, childStore, () => setRevision((revision) => revision + 1));
  }, [parentSessionId, relations]);

  const forwarded = selectForwardedChildPermission({
    rootHasOwnPermission: rootHasOwn,
    owners,
    displayedChildSpawnToolCallIds: [],
  });

  const shownTabId = forwarded?.childTabId;
  const shownRequestId = forwarded?.request.requestId;
  useEffect(() => {
    if (!shownTabId || !shownRequestId) return;
    const sendVisibility = (visible: boolean) => tabRegistry.sendToTab(shownTabId, { type: "approval_visibility", requestId: shownRequestId, visible });
    const update = () => sendVisibility(!document.hidden && document.hasFocus());
    const blur = () => sendVisibility(false);
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", blur);
      sendVisibility(false);
    };
  }, [shownTabId, shownRequestId]);

  // Keep the preview WebContentsView from covering the approval while it shows.
  useOverlayFlag(forwarded !== null);

  const unattendedChildren = parentSessionId === null ? [] : [...relations.entries()]
    .filter(([key, relation]) => key.startsWith(`${parentSessionId}\u0000`) && (relation.live ? childStore(relation.childTabId)?.getState().unattended : relation.approvalExpired))
    .map(([key, relation]) => ({ ...relation, spawnToolCallId: key.slice(parentSessionId.length + 1) }));
  const statuses = unattendedChildren.map((child) => (
    <div className="banner banner-info approval-status" role="status" key={child.childTabId}>
      {childPermissionOwnerLabel(child.childSessionId, child.spawnToolCallId, transcript, backgroundChildren)}:
      {child.live ? " an unanswered request expired. New approval requests are being denied automatically." : " an unanswered request expired before this subagent finished."}
      {child.live
        ? <button type="button" onClick={() => tabRegistry.sendToTab(child.childTabId, { type: "approval_recover" })}>Ask me again</button>
        : <button type="button" onClick={() => childRelationStore.getState().dismissApprovalExpired(parentSessionId!, child.spawnToolCallId)}>Dismiss</button>}
    </div>
  ));
  if (forwarded === null) {
    return <>{statuses}</>;
  }

  const childState = childStore(forwarded.childTabId)?.getState();
  const allowRemember = canRememberPermission(childState?.engine ?? null);
  const submissionKey = childPermissionSubmissionKey(forwarded.childTabId, forwarded.request.requestId);
  const claim = (): boolean => {
    if (submitted.current === submissionKey) return false;
    submitted.current = submissionKey;
    return true;
  };

  function handleAllow(remember?: { pattern?: string }): void {
    if (!forwarded || !claim()) return;
    const answered = respondChildPermission(forwarded, "allow", childStore, (childTabId, message) =>
      tabRegistry.sendToTab(childTabId, message),
    remember);
    if (!answered) {
      submitted.current = null;
      return;
    }
    if (allowRemember && remember) {
      const rule = buildAlwaysAllowRule(forwarded.request.toolName, remember.pattern);
      void window.anycode.settings.addRule(rule).catch((error: unknown) => {
        console.warn("[ChildPermissionModal] addRule failed — rule remains session-only", error);
      });
    }
  }

  function handleDeny(): void {
    if (!forwarded || !claim()) return;
    const answered = respondChildPermission(forwarded, "deny", childStore, (childTabId, message) =>
      tabRegistry.sendToTab(childTabId, message),
    );
    if (!answered) submitted.current = null;
  }

  return (
    <>
    {statuses}
    <PermissionModal
      // A new ask for the same or another child remounts the dialog, so no
      // stale button or keyboard handler can answer it.
      key={submissionKey}
      request={forwarded.request}
      onAllow={handleAllow}
      onDeny={handleDeny}
      allowRemember={allowRemember}
      workspace={childState?.workspace ?? null}
      ownerLabel={childPermissionOwnerLabel(forwarded.childSessionId, forwarded.spawnToolCallId, transcript, backgroundChildren)}
    />
    </>
  );
}
