/**
 * ConnectionTile (TASK.45 W12, cut §"Компактная сетка подключений"): one
 * selectable tile in the Provider pane's grid — provider name/label, default
 * model, health status dot+TEXT (never color alone), a selected/default
 * marker, and an overflow menu (Edit · Replace key/Sign in-out · Check ·
 * Delete). Clicking the tile BODY makes the connection the default for NEW
 * core sessions (design §4: it must never retarget an already-open session);
 * Edit/Replace key are reached only through the menu, never a body click.
 *
 * Structural note: the select action and the menu trigger are SIBLING
 * `<button>`s (a `<button>` cannot nest another interactive element) — the
 * tile's outer element is a plain `role="group"` container, mirroring
 * ModelPill's popover-trigger-as-sibling pattern.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { CatalogSummaryEntry, ProviderConnection, ProviderHealthStatus, SecretKey, SecretStatus } from "../../../shared/settings.js";
import { Check, Ellipsis, Pencil, Trash } from "./icons.js";
import { nextRovingIndex } from "./ModeMenu.js";

/** Short, human status text for each `ProviderHealthStatus` (task §3 table) — status is ALWAYS paired with this text, never color alone. */
export const HEALTH_LABEL: Record<ProviderHealthStatus, string> = {
  needs_credential: "Needs credential",
  unchecked: "Unchecked",
  ready: "Ready",
  auth_invalid: "Key invalid",
  forbidden: "Forbidden",
  rate_limited: "Rate limited",
  unreachable: "Unreachable",
  misconfigured: "Misconfigured",
};

export type HealthTone = "ok" | "warn" | "danger" | "muted";

/** Tone per the task §3 table: red only for a DISCRIMINATED credential failure (auth_invalid/forbidden) — 429/timeout/5xx/bad-model never paint red. */
export const HEALTH_TONE: Record<ProviderHealthStatus, HealthTone> = {
  needs_credential: "muted",
  unchecked: "muted",
  ready: "ok",
  auth_invalid: "danger",
  forbidden: "danger",
  rate_limited: "warn",
  unreachable: "warn",
  misconfigured: "warn",
};

/**
 * The status a tile actually shows: `needs_credential` OVERRIDES any stale
 * `lastHealth` the moment the credential is absent (a cleared/never-set key
 * must never keep showing a prior `ready`/`auth_invalid` reading) — mirrors
 * `computeProviderReady`'s own "credential set" gate. A present-but-
 * undecryptable vault entry (`set: true`, `source: "none"` — TASK.45 W12-FIX
 * §4) is equally unusable at runtime and gets the SAME treatment, never a
 * stale `ready`/`auth_invalid` reading either. Otherwise the connection's
 * advisory `lastHealth.status`, or `unchecked` when it has never been probed.
 */
export function connectionHealthStatus(
  connection: ProviderConnection,
  credentialStatus: SecretStatus | undefined,
): ProviderHealthStatus {
  if (!credentialStatus?.set || credentialStatus.source === "none") {
    return "needs_credential";
  }
  return connection.lastHealth?.status ?? "unchecked";
}

/** `{text, tone}` for a resolved `ProviderHealthStatus` — the one place a tile/menu maps status to presentation. */
export function describeConnectionHealth(status: ProviderHealthStatus): { text: string; tone: HealthTone } {
  return { text: HEALTH_LABEL[status], tone: HEALTH_TONE[status] };
}

/** The vault key a connection's credential lives under — renderer-side mirror of `main/host-env.ts`'s `connectionSecretKey` (value-only, no import — same precedent as every other `SecretKey` template literal). Shared leaf helper: both SettingsScreen.tsx (credential-status lookup) and ConnectionDrawer.tsx (the write/clear target) import it from here to avoid a two-file import cycle. */
export function connectionSecretKey(connectionId: string, authKind: "api_key" | "oauth"): SecretKey {
  return authKind === "oauth" ? `provider.connection.${connectionId}.oauth` : `provider.connection.${connectionId}.apiKey`;
}

/**
 * Auto-naming (task §"Компактная сетка"): a custom `label` always wins;
 * otherwise the catalog/template name, disambiguated with a trailing ordinal
 * ("OpenAI", "OpenAI 2", …) among UNLABELED connections of the SAME
 * `providerId`, in their array order — matches the task's own example.
 */
export function connectionDisplayName(
  connection: ProviderConnection,
  catalogName: string,
  allConnections: readonly ProviderConnection[],
): string {
  if (connection.label) {
    return connection.label;
  }
  const sameProviderUnlabeled = allConnections.filter((c) => c.providerId === connection.providerId && !c.label);
  const index = sameProviderUnlabeled.findIndex((c) => c.id === connection.id);
  return index <= 0 ? catalogName : `${catalogName} ${index + 1}`;
}

export interface ConnectionTileProps {
  connection: ProviderConnection;
  /** The catalog entry for `connection.providerId`; `undefined` for the bare/custom bucket (no catalog pick). */
  catalogEntry: CatalogSummaryEntry | undefined;
  displayName: string;
  credentialStatus: SecretStatus | undefined;
  selected: boolean;
  /** True while an explicit "Check" probe for this connection is in flight (disables the menu item, shows "Checking…"). */
  checking: boolean;
  /** Settings.json is a newer version than this binary understands — every mutating action (select/edit/replace/check/delete) disables, same posture as every other pane. */
  readOnly: boolean;
  tabIndex: number;
  tileRef?: (el: HTMLButtonElement | null) => void;
  onSelect(): void;
  onEdit(): void;
  onReplaceKey(): void;
  onCheck(): void;
  onDelete(): void;
  onKeyDownRoving(event: KeyboardEvent<HTMLButtonElement>): void;
}

export function ConnectionTile({
  connection,
  catalogEntry,
  displayName,
  credentialStatus,
  selected,
  checking,
  readOnly,
  tabIndex,
  tileRef,
  onSelect,
  onEdit,
  onReplaceKey,
  onCheck,
  onDelete,
  onKeyDownRoving,
}: ConnectionTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const healthStatus = connectionHealthStatus(connection, credentialStatus);
  const described = describeConnectionHealth(healthStatus);
  const providerName = catalogEntry?.name ?? "Custom";
  const authKind = catalogEntry?.authKind ?? "api_key";
  const replaceKeyLabel = authKind === "oauth" ? (credentialStatus?.set ? "Sign out" : "Sign in") : "Replace key";

  useEffect(() => {
    if (!menuOpen) {
      setConfirmingDelete(false);
      return;
    }
    firstMenuItemRef.current?.focus();
    function onMouseDown(event: MouseEvent): void {
      if (menuRootRef.current && !menuRootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpen]);

  // Fail-closed focus (mirrors ConsentDialog's own discipline): switching from
  // the action list to the delete-confirm sub-view re-anchors focus onto
  // Cancel — without this, focus would otherwise drop to <body> the instant
  // the "Delete" menu item it was sitting on unmounts.
  useEffect(() => {
    if (confirmingDelete) {
      confirmCancelRef.current?.focus();
    }
  }, [confirmingDelete]);

  function closeMenu(returnFocus: boolean): void {
    setMenuOpen(false);
    if (returnFocus) {
      menuTriggerRef.current?.focus();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (confirmingDelete) {
      return;
    }
    const items = Array.from(
      menuRootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[nextRovingIndex(current, 1, items.length)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[nextRovingIndex(current, -1, items.length)]?.focus();
    }
  }

  return (
    <div
      className={`connection-tile${selected ? " connection-tile-selected" : ""}`}
      role="group"
      aria-label={`${displayName} connection`}
      data-connection-id={connection.id}
    >
      <button
        type="button"
        ref={tileRef}
        className="connection-tile-select"
        tabIndex={tabIndex}
        aria-pressed={selected}
        disabled={readOnly}
        onClick={onSelect}
        onKeyDown={onKeyDownRoving}
      >
        <div className="connection-tile-header">
          <span className="connection-tile-provider">{providerName}</span>
          {selected && (
            <span className="connection-tile-selected-marker" title="Default for new sessions">
              <Check className="connection-tile-selected-icon" aria-hidden="true" />
            </span>
          )}
        </div>
        <div className="connection-tile-name">{displayName}</div>
        <div className="connection-tile-model">{connection.model || "Default model"}</div>
        <div className={`connection-tile-status connection-tile-status-${described.tone}`}>
          <span className="connection-tile-status-dot" aria-hidden="true" />
          <span>{checking ? "Checking…" : described.text}</span>
        </div>
      </button>

      <div className="connection-tile-menu" ref={menuRootRef} onKeyDown={onMenuKeyDown}>
        <button
          type="button"
          ref={menuTriggerRef}
          className="connection-tile-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${displayName} actions`}
          disabled={readOnly}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Ellipsis aria-hidden="true" />
        </button>
        {menuOpen && !confirmingDelete && (
          <div className="connection-tile-menu-popover" role="menu" aria-label={`${displayName} actions`}>
            <button
              type="button"
              ref={firstMenuItemRef}
              role="menuitem"
              className="connection-tile-menu-item"
              onClick={() => {
                closeMenu(false);
                onEdit();
              }}
            >
              <Pencil aria-hidden="true" /> Edit
            </button>
            <button
              type="button"
              role="menuitem"
              className="connection-tile-menu-item"
              onClick={() => {
                closeMenu(false);
                onReplaceKey();
              }}
            >
              {replaceKeyLabel}
            </button>
            <button
              type="button"
              role="menuitem"
              className="connection-tile-menu-item"
              disabled={checking || !credentialStatus?.set}
              onClick={() => {
                closeMenu(false);
                onCheck();
              }}
            >
              Check
            </button>
            <button
              type="button"
              role="menuitem"
              className="connection-tile-menu-item connection-tile-menu-danger"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash aria-hidden="true" /> Delete
            </button>
          </div>
        )}
        {menuOpen && confirmingDelete && (
          <div className="connection-tile-menu-popover connection-tile-confirm" role="menu" aria-label={`Confirm delete ${displayName}`}>
            <p className="connection-tile-confirm-text">Delete this connection?</p>
            <div className="connection-tile-confirm-actions">
              <button type="button" ref={confirmCancelRef} className="settings-button" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="settings-button settings-button-danger"
                onClick={() => {
                  closeMenu(true);
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
