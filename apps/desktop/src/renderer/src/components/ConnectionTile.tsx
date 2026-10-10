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

export const LAST_HEALTH_TTL_MS: Readonly<Record<"rate_limited" | "other", number>> = {
  rate_limited: 60 * 60 * 1000, // 1 hour — a 429 reading goes stale fast
  other: 24 * 60 * 60 * 1000, // 24 hours for every other status
};

/** What `observeLastHealth` reports about a connection's advisory `lastHealth` — pure display input, never mutated. */
export interface LastHealthObservation {
  /** The advisory status to SHOW: the observed status when fresh, `unchecked` otherwise (stale/invalid/absent). */
  status: ProviderHealthStatus;
  /** True when a `lastHealth` observation exists at all (valid or not). */
  observed: boolean;
  /** Fresh within its status's TTL — a valid timestamp AT or BEYOND its TTL is stale, and an invalid timestamp is never fresh. */
  fresh: boolean;
  /** Age in ms since the observation, clamped to ≥ 0; `undefined` when absent or unparseable. */
  ageMs: number | undefined;
  /** Compact human age ("just now", "5m ago", "3h ago", "4d ago"); "age unknown" when the timestamp is unparseable; "" when no observation. */
  compactAge: string;
  /** Historical tooltip text for the tile's status element (identifies the previous status, its age, staleness). */
  title: string;
}

/**
 * Pure observation-age/freshness for a connection's advisory `lastHealth`
 * (TASK.140): TTL is 1 hour for `rate_limited` (a 429 reading goes stale fast)
 * and 24 hours for every other status; at or beyond the TTL the observation is
 * stale and the tile must fall back to `unchecked`. A missing or unparseable
 * timestamp is never treated as fresh — it yields `unchecked` with unknown age.
 * Negative ages (clock skew / future timestamps) clamp to zero. Never mutates
 * `lastHealth` or its connection.
 */
export function observeLastHealth(
  lastHealth: ProviderConnection["lastHealth"],
  /** Explicit numeric now — keeps this pure and deterministically testable. */
  now: number,
): LastHealthObservation {
  if (!lastHealth) {
    return {
      status: "unchecked",
      observed: false,
      fresh: false,
      ageMs: undefined,
      compactAge: "",
      title: "Never checked",
    };
  }
  const parsed = Date.parse(lastHealth.at);
  if (!Number.isFinite(parsed)) {
    return {
      status: "unchecked",
      observed: true,
      fresh: false,
      ageMs: undefined,
      compactAge: "age unknown",
      title: `Previous observation: ${HEALTH_LABEL[lastHealth.status]}, age unknown`,
    };
  }
  const ageMs = Math.max(0, now - parsed);
  const ttl = lastHealth.status === "rate_limited" ? LAST_HEALTH_TTL_MS.rate_limited : LAST_HEALTH_TTL_MS.other;
  const fresh = ageMs < ttl;
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(ageMs / 3_600_000);
  const days = Math.floor(ageMs / 86_400_000);
  const compactAge = ageMs < 60_000 ? "just now" : minutes < 60 ? `${minutes}m ago` : hours < 24 ? `${hours}h ago` : `${days}d ago`;
  const staleNote = fresh ? "" : " (stale)";
  return {
    status: fresh ? lastHealth.status : "unchecked",
    observed: true,
    fresh,
    ageMs,
    compactAge,
    title: `Previous observation: ${HEALTH_LABEL[lastHealth.status]}, ${compactAge}${staleNote}`,
  };
}

/**
 * The status a tile actually shows. `needs_credential` OVERRIDES any
 * `lastHealth` the moment the credential is absent (a cleared/never-set key
 * must never keep showing a prior `ready`/`auth_invalid` reading) — mirrors
 * `computeProviderReady`'s own "credential set" gate. A present-but-
 * undecryptable vault entry (`set: true`, `source: "none"` — TASK.45 W12-FIX
 * §4) is equally unusable at runtime and gets the SAME treatment, never a
 * stale `ready`/`auth_invalid` reading either. Otherwise the connection's
 * advisory `lastHealth.status` — but only while that observation is FRESH
 * (TASK.140: 1h TTL for `rate_limited`, 24h otherwise; see
 * `observeLastHealth`) — falling back to `unchecked` for a stale, invalid or
 * absent observation. `now` defaults to the current clock; the tile passes its
 * minute-ticking local `now` state so an open tile ages on its own.
 */
export function connectionHealthStatus(
  connection: ProviderConnection,
  credentialStatus: SecretStatus | undefined,
  /** True when no credential is expected at all (catalog `authOptional` — vLLM — or the connection's own "no API key" declaration): an absent key is then a non-event, never a `needs_credential` nag. */
  keyless = false,
  now = Date.now(),
): ProviderHealthStatus {
  if (!keyless && (!credentialStatus?.set || credentialStatus.source === "none")) {
    return "needs_credential";
  }
  return observeLastHealth(connection.lastHealth, now).status;
}

/** `{text, tone}` for a resolved `ProviderHealthStatus` — the one place a tile/menu maps status to presentation. */
export function describeConnectionHealth(status: ProviderHealthStatus): { text: string; tone: HealthTone } {
  return { text: HEALTH_LABEL[status], tone: HEALTH_TONE[status] };
}

/** The vault key a connection's credential lives under — renderer-side mirror of `main/host-env.ts`'s `connectionSecretKey` (value-only, no import — same precedent as every other `SecretKey` template literal). Shared leaf helper: both SettingsScreen.tsx (credential-status lookup) and ConnectionDrawer.tsx (the write/clear target) import it from here to avoid a two-file import cycle. */
export function connectionSecretKey(connectionId: string, authKind: "api_key" | "oauth"): SecretKey {
  return authKind === "oauth" ? `provider.connection.${connectionId}.oauth` : `provider.connection.${connectionId}.apiKey`;
}

/** True when a providerId names a user-created custom-provider RECORD (`custom:<slug>`) — renderer-side mirror of `main/host-env.ts`'s `isCustomProviderRecordId` (value-only, no import). Distinct from the builtin `custom` SENTINEL (the bare literal). */
export function isCustomRecordProviderId(providerId: string): boolean {
  return providerId.startsWith("custom:");
}

/** The vault key a custom provider's ONE shared credential lives under — renderer-side mirror of `main/host-env.ts`'s `customProviderSecretKey` (value-only, no import). One key per PROVIDER, covering every connection that points at it. */
export function customProviderSecretKey(providerId: string): SecretKey {
  return `provider.${providerId}.apiKey`;
}

/**
 * The vault key that gates a connection's credential in the UI (TASK.58): a
 * `custom:<slug>` connection routes at the custom provider's OWN shared key
 * (`provider.<id>.apiKey`, exactly what `main/host-env.ts`'s `activeCredential`
 * reads for a custom id), every other connection at its own connection-scoped
 * key. `authKind` only matters for the non-custom (catalog) branch — a custom
 * provider is always `api_key`.
 */
export function connectionCredentialKey(
  connectionId: string,
  providerId: string,
  authKind: "api_key" | "oauth",
): SecretKey {
  return isCustomRecordProviderId(providerId)
    ? customProviderSecretKey(providerId)
    : connectionSecretKey(connectionId, authKind);
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

/** The exact `{text, title, tone}` a tile's status element renders — pure, so tests cover the real selection (TASK.140). */
export interface TileStatusPresentation {
  text: string;
  title: string | undefined;
  tone: HealthTone;
}

/**
 * Pure presentation the tile's status element displays (TASK.140). `checking`
 * wins first ("Checking…", no title). A credential override keeps
 * `Needs credential` as the CURRENT status but still reports the previous
 * observation — its age (or "age unknown"), staleness marked, in the text (or
 * the title when compactness requires it). Otherwise a fresh observation shows
 * its status + compact age inline; a stale/unparseable one falls back to
 * Unchecked with the historical title naming the previous status, its age and
 * staleness.
 */
export function tileStatusPresentation(
  healthStatus: ProviderHealthStatus,
  observation: LastHealthObservation | undefined,
  checking: boolean,
): TileStatusPresentation {
  if (checking) {
    return { text: "Checking…", title: undefined, tone: describeConnectionHealth(healthStatus).tone };
  }
  const described = describeConnectionHealth(healthStatus);
  // Credential override: the tile names the current blocker; the previous
  // observation (status, age, stale mark) stays in the title — never dropped,
  // never presented as current.
  if (healthStatus === "needs_credential" && observation?.observed) {
    return { text: described.text, title: observation.title, tone: described.tone };
  }
  if (!observation || !observation.observed) {
    return { text: described.text, title: undefined, tone: described.tone };
  }
  if (observation.fresh) {
    return { text: `${described.text} (${observation.compactAge})`, title: `Checked ${observation.compactAge}`, tone: described.tone };
  }
  return { text: described.text, title: observation.title, tone: described.tone };
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

  // Local clock (TASK.140): re-rendered every minute so an open tile AGES on
  // its own — a fresh `ready` decays to `unchecked` with no settings write and
  // no user action. Cleanup clears the interval on unmount.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const healthStatus = connectionHealthStatus(
    connection,
    credentialStatus,
    catalogEntry?.authOptional === true || connection.authOptional === true,
    now,
  );
  // The tile's exact display selection lives in the pure
  // `tileStatusPresentation` (tested directly); the component only supplies
  // its inputs. `checking` suppresses the observation display entirely.
  const presentation = tileStatusPresentation(
    healthStatus,
    checking ? undefined : observeLastHealth(connection.lastHealth, now),
    checking,
  );
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
        <div
          className={`connection-tile-status connection-tile-status-${presentation.tone}`}
          title={presentation.title}
        >
          <span className="connection-tile-status-dot" aria-hidden="true" />
          <span>{presentation.text}</span>
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
