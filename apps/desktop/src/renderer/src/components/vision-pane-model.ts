/**
 * TASK.198 срез E2a — pure decision logic for the Vision settings panel: which
 * connection may act as the fallback recognizer, what its proxy path actually
 * is, which models to suggest, and whether the fallback currently reads as
 * "on". Same discipline as start-model-picker.ts/ProxyRefPicker.ts: this
 * package's vitest runs `environment: "node"` (no jsdom), so every decision
 * the panel needs is a plain function here and the JSX (a later slice) only
 * renders what these return.
 *
 * Every rule below is a RENDERER-SIDE MIRROR of main's authoritative resolver
 * (`apps/desktop/src/main/host-env.ts`, `resolveRecognizerConfig`) — never a
 * second policy. Where this module cannot see what main sees (see the
 * `authKindFor` and `VisionCatalogModelHint.imageInput` doc comments below for
 * the two concrete gaps), the missing fact is an INPUT PARAMETER rather than a
 * guess, so a caller that does not have it yet gets an honest "no answer" —
 * never a fabricated one.
 */
import type {
  AnycodeSettings,
  CatalogSummary,
  ProviderConnection,
} from "../../../shared/settings.js";
import { readProxyScope } from "../../../shared/proxy.js";
import { connectionById } from "../../../shared/settings.js";
import { connectionDisplayName } from "./ConnectionTile.js";

// ── auth kind (mirrors host-env.ts resolveRecognizerConfig lines ~1179-1183) ──

/**
 * The recognizer's fail-closed reason for an OAuth-authenticated candidate
 * connection — `resolveRecognizerConfig` returns `undefined` for it (the
 * static-credential requirement below), and this string is the panel's own
 * rendering of that SAME refusal, never a second rule.
 */
export const RECOGNIZER_OAUTH_DISABLED_REASON =
  "This connection signs in with OAuth. The recognizer needs a static API key it can send with every InspectImage call, and only an OAuth connection's own broker can refresh an OAuth token — a background fallback call has no session to refresh it through.";

/**
 * Whether a candidate recognizer connection authenticates with an API key or
 * OAuth — a byte-for-byte port of host-env.ts's own inline rule:
 * ```
 * const providerId = connection.providerId;
 * const kind = providerId === "" ? "api_key" : (authKindFor?.(providerId) ?? "api_key");
 * ```
 * Two tonicities are load-bearing and pinned by this module's tests:
 *  - a bare/legacy connection (`providerId === ""`) is ALWAYS `api_key` and
 *    never consults `authKindFor` at all (mirrors `activeCredential`'s own
 *    posture for the same bucket, per host-env.ts's own comment);
 *  - an id `authKindFor` cannot answer (`undefined` — an unknown/legacy
 *    providerId, or a catalog projection that has not loaded yet) degrades to
 *    `api_key`, never to `oauth` — the runtime is fail-OPEN here (it would
 *    rather register a recognizer that later 401s than silently disable one
 *    that would have worked), and the panel must read the same id the same
 *    way or it would show a connection as blocked that the runtime accepts.
 *
 * `authKindFor` is an INPUT here (not resolved internally against a catalog)
 * because this module found no snapshot field that is unambiguously the
 * renderer's own copy of host-env.ts's `authKindFor` — see this file's
 * "auth-kind source" note in the accompanying report. The renderer DOES carry
 * `CatalogSummaryEntry.authKind` (`shared/settings.ts:654`, populated by
 * `entry.auth.kind` in `main/settings-ipc.ts`'s `projectCatalogSummary`,
 * consumed the same way by ConnectionTile.tsx/SettingsScreen.tsx's own
 * `catalogEntry?.authKind ?? "api_key"` idiom) — a caller wiring this pane can
 * derive `authKindFor` as `(providerId) => catalog.find((e) => e.id ===
 * providerId)?.authKind`, but deciding that is the wiring session's call, not
 * this module's.
 */
export function resolveRecognizerAuthKind(
  connection: Pick<ProviderConnection, "providerId">,
  authKindFor: (providerId: string) => "api_key" | "oauth" | undefined,
): "api_key" | "oauth" {
  const providerId = connection.providerId;
  return providerId === "" ? "api_key" : (authKindFor(providerId) ?? "api_key");
}

// ── proxy divergence (warns; never blocks — resolveRecognizerConfig has no proxy refusal) ──

/**
 * A connection's DECLARED proxy rung, read but not resolved: `proxyRef` when
 * present, else the legacy `proxyUrl` string, else "nothing declared — inherit
 * the app rung". Built from `readProxyScope`'s `{ref, legacyUrl}` pair
 * (`shared/proxy.ts`) rather than reading `ProviderConnection.proxyRef`/
 * `proxyUrl` directly, so the "`proxyRef` beats `proxyUrl` on the SAME
 * connection" precedence is the registry's own rule, not a second copy of it.
 *
 * Deliberately NOT the resolved URL/profile: a snapshot masks a legacy
 * string's userinfo (`user:***@host:port`), so two connections with different
 * real passwords would compare equal on the resolved value and this module
 * has no compactor for that; comparing the DECLARED rung side-steps it
 * entirely, exactly as the task asks.
 */
export type DeclaredProxyRung =
  | { kind: "inherit" }
  | { kind: "ref"; value: string }
  | { kind: "legacy"; value: string };

/** Turns `readProxyScope`'s `{ref, legacyUrl}` pair into a `DeclaredProxyRung`. */
export function declaredProxyRung(scope: { ref?: string; legacyUrl?: string }): DeclaredProxyRung {
  if (scope.ref !== undefined) {
    return { kind: "ref", value: scope.ref };
  }
  if (scope.legacyUrl !== undefined) {
    return { kind: "legacy", value: scope.legacyUrl };
  }
  return { kind: "inherit" };
}

/** Structural equality of two declared rungs — same kind, and same value when the kind carries one. */
export function sameDeclaredProxyRung(a: DeclaredProxyRung, b: DeclaredProxyRung): boolean {
  if (a.kind === "inherit") {
    return b.kind === "inherit";
  }
  return a.kind === b.kind && a.value === (b as { value: string }).value;
}

/**
 * The Vision panel's proxy note for one candidate connection (task §2): the
 * recognizer's `ask()` call rides the HOST FORK's ambient env, which carries
 * the PRIMARY connection's proxy (`hostForkProxyChain`, `shared/proxy.ts`) —
 * never the recognizer connection's own. `resolveRecognizerConfig` has
 * exactly four refusals (absent setting, dangling connectionId, oauth kind,
 * blank resolved baseUrl) and a divergent proxy is not among them, so this is
 * a WARNING the panel shows beside an otherwise-selectable item, never a
 * reason to disable it.
 *
 * `undefined` when: the candidate IS the default connection (no divergence is
 * possible), or the two connections' DECLARED rungs are the same (both
 * inherit, both `direct`, both the same profile id or the same legacy
 * string). Otherwise names the default connection by its own display label
 * and says where the traffic actually goes.
 */
export function visionConnectionProxyWarning(
  settings: AnycodeSettings,
  candidateConnectionId: string,
  defaultConnectionId: string,
  defaultConnectionLabel: string,
): string | undefined {
  if (candidateConnectionId === defaultConnectionId) {
    return undefined;
  }
  const candidateRung = declaredProxyRung(
    readProxyScope(settings, { kind: "connection", connectionId: candidateConnectionId }),
  );
  const defaultRung = declaredProxyRung(
    readProxyScope(settings, { kind: "connection", connectionId: defaultConnectionId }),
  );
  if (sameDeclaredProxyRung(candidateRung, defaultRung)) {
    return undefined;
  }
  return (
    `Image-recognition requests do not use this connection's own proxy — they ride the ambient proxy of ` +
    `${defaultConnectionLabel}, the default connection, instead.`
  );
}

// ── connection list for the <select> (task §1) ──

/** One row of the recognizer connection `<select>`. */
export interface VisionConnectionOption {
  id: string;
  /** `connectionDisplayName`'s own auto-naming — the same label Settings/Welcome/the Start picker already show for this connection. */
  label: string;
  /** False for exactly one category: an OAuth-authenticated connection. */
  selectable: boolean;
  /** Present only when `selectable` is false. */
  disabledReason?: string;
  /** Present only when `selectable` is true AND the declared proxy rung diverges from the default connection's. Never implies the item is disabled. */
  proxyWarning?: string;
}

/** The catalog display name a `connectionDisplayName` call needs for one connection, or the "Custom" fallback for a bare/custom-record connection with no catalog hit — same idiom as start-model-picker.ts's own inline lookup. */
export function visionConnectionLabel(
  connection: ProviderConnection,
  catalog: CatalogSummary | undefined,
  allConnections: readonly ProviderConnection[],
): string {
  const catalogName = catalog?.find((entry) => entry.id === connection.providerId)?.name ?? "Custom";
  return connectionDisplayName(connection, catalogName, allConnections);
}

/**
 * Every connection the recognizer `<select>` offers, in `settings.provider.
 * connections` storage order, each carrying its own selectability + reason and
 * (when applicable) its proxy note. The default connection's own row is
 * included like any other — the proxy warning naturally never fires for it
 * (`visionConnectionProxyWarning`'s same-id short-circuit).
 */
export function visionConnectionOptions(
  settings: AnycodeSettings,
  catalog: CatalogSummary | undefined,
  authKindFor: (providerId: string) => "api_key" | "oauth" | undefined,
): VisionConnectionOption[] {
  const connections = settings.provider.connections;
  const labels = new Map(connections.map((c) => [c.id, visionConnectionLabel(c, catalog, connections)] as const));
  const defaultConnectionId = settings.provider.activeConnectionId;
  const defaultLabel = defaultConnectionId !== undefined ? labels.get(defaultConnectionId) : undefined;

  return connections.map((connection) => {
    const label = labels.get(connection.id) ?? connection.id;
    if (resolveRecognizerAuthKind(connection, authKindFor) === "oauth") {
      return { id: connection.id, label, selectable: false, disabledReason: RECOGNIZER_OAUTH_DISABLED_REASON };
    }
    const proxyWarning =
      defaultConnectionId !== undefined && defaultLabel !== undefined
        ? visionConnectionProxyWarning(settings, connection.id, defaultConnectionId, defaultLabel)
        : undefined;
    return {
      id: connection.id,
      label,
      selectable: true,
      ...(proxyWarning !== undefined ? { proxyWarning } : {}),
    };
  });
}

// ── model hints for <input list> + <datalist> (task §3) — UNION, not replace ──

/**
 * The minimal shape this module needs from one catalog model entry.
 *
 * `imageInput` is declared here even though `CatalogSummaryEntry.models`
 * (`shared/settings.ts:670`) does NOT currently project it: core's own catalog
 * carries the flag per model (`packages/core/src/provider/catalog.ts:42`,
 * populated in `catalog-data.ts`), but the main-side projection into the wire
 * type (`projectCatalogSummary`, `main/settings-ipc.ts`) drops it before the
 * snapshot reaches the renderer — confirmed by reading both functions; this is
 * a gap, not an oversight this module should paper over.
 *
 * Declaring the field OPTIONAL here keeps this function callable with
 * TODAY's real `CatalogSummary` (a value missing an optional property is
 * structurally assignable — TypeScript treats the absent property as
 * `undefined`, never a type error) so nothing needs to change here the day
 * the wire gap closes; until then every real snapshot yields `imageInput ===
 * undefined` for every model, so the catalog half of `visionModelHints`
 * contributes NOTHING and only the live `connection.models[]` half offers
 * suggestions — safe (free text still works, per the task's own §3 rationale
 * for `openrouter`/`vllm`/`custom`), but not yet useful for a model the
 * catalog actually knows supports vision. Wiring this pane for real should
 * either extend `CatalogSummaryEntry.models[]`/`projectCatalogSummary` with
 * `imageInput`, or supply an equivalent structurally-compatible array from
 * elsewhere — that decision is intentionally left to the caller.
 */
export interface VisionCatalogModelHint {
  id: string;
  name?: string;
  imageInput?: boolean;
}

/** One suggested model id, with the display label to show for it. */
export interface VisionModelHint {
  id: string;
  label: string;
}

/**
 * The datalist suggestions for the recognizer's model field (task §3):
 * catalog models of `providerId` with `imageInput: true`, UNIONED with the
 * candidate connection's live-fetched `connection.models[]` — NOT one
 * replacing the other.
 *
 * This is the deliberate anti-canon fix to `ModelPill.tsx`'s
 * `providerModelsFor`, which REPLACES the catalog list wholesale the moment a
 * live list is non-empty (`if (connectionModels !== undefined &&
 * connectionModels.length > 0) { return connectionModels.map(...) }`) — the
 * live TASK.106/131 defect where a working model vanishes from a picker
 * because the live fetch did not happen to include it. Here, a catalog model
 * already known to support vision NEVER disappears just because the
 * connection's live list is non-empty and does not happen to repeat it.
 *
 * The `imageInput: true` filter applies ONLY to the catalog half — a live id
 * carries no modality information at all, and silently dropping live ids
 * because their modality is unknown would reproduce the exact defect above in
 * a new shape. A live id that duplicates a catalog id already included keeps
 * the CATALOG's display name (dedup by id); a live id with no catalog match
 * is offered under its own raw id, exactly like `providerModelsFor` already
 * does for an unmatched live id.
 */
export function visionModelHints(
  providerId: string | undefined,
  catalog: CatalogSummary | undefined,
  connectionModels: readonly string[] | undefined,
): VisionModelHint[] {
  const catalogModels: readonly VisionCatalogModelHint[] =
    catalog?.find((entry) => entry.id === providerId)?.models ?? [];
  const hints = new Map<string, string>();
  for (const model of catalogModels) {
    if (model.imageInput === true) {
      hints.set(model.id, model.name ?? model.id);
    }
  }
  for (const id of connectionModels ?? []) {
    if (!hints.has(id)) {
      hints.set(id, id);
    }
  }
  return [...hints.entries()].map(([id, label]) => ({ id, label }));
}

// ── panel state (task §4) — no "half-configured" middle state ──

/** Whether the vision fallback currently reads as configured, and what it points at when it does. */
export type VisionFallbackState = { enabled: false } | { enabled: true; connectionId: string; modelId: string };

/**
 * The panel's own read of `settings.recognizer` (task §4) — mirrors
 * `resolveRecognizerConfig`'s first three early-exits exactly (absent
 * `settings.recognizer`, a `connectionId` that no longer resolves to a
 * connection, an OAuth connection) so the panel never shows "on" for a
 * configuration the runtime would treat as disabled, and never invents an
 * intermediate "half-configured" reading for any of them — every one of these
 * three collapses to the SAME `{enabled:false}`, exactly like the runtime's
 * doc comment: "all read as 'fallback disabled' at resolve time... never a
 * corrupt-settings state."
 *
 * Deliberately does NOT replicate `resolveRecognizerConfig`'s fourth refusal
 * (the resolved baseUrl comes back blank after the catalog/custom-provider
 * fallback) — that requires the same catalog+custom-record resolution main
 * does, which is out of scope for a settings-only read; the task's own §4
 * spec lists exactly the three states this function covers.
 */
export function visionFallbackState(
  settings: AnycodeSettings,
  authKindFor: (providerId: string) => "api_key" | "oauth" | undefined,
): VisionFallbackState {
  const setting = settings.recognizer;
  if (setting === undefined) {
    return { enabled: false };
  }
  const connection = connectionById(settings, setting.connectionId);
  if (connection === undefined) {
    return { enabled: false };
  }
  if (resolveRecognizerAuthKind(connection, authKindFor) === "oauth") {
    return { enabled: false };
  }
  return { enabled: true, connectionId: setting.connectionId, modelId: setting.modelId };
}

// ── Save/Probe submit gate (task §5 — a mirror of main's own refusal, not extra strictness) ──

/**
 * Whether the panel's Save/Probe buttons must refuse the current draft — a
 * RENDERER-SIDE MIRROR of `handleRecognizerSet`'s own refusal
 * (`main/settings-ipc.ts`): a blank/whitespace-only `modelId` after `trim()`,
 * or no connection chosen yet at all.
 *
 * `handleRecognizerSet` also refuses a `connectionId` that fails to resolve
 * against the live `provider.connections` graph, but the panel's own
 * `<select>` can never SUBMIT such a value — every real option it offers is
 * built from that same graph (`visionConnectionOptions`) — so the empty
 * string the `<select>`'s own "nothing chosen yet" placeholder carries is the
 * only unresolvable value this function needs to catch on that side.
 *
 * `recognizerProbe`'s own request schema (`main/recognizer-probe.ts`) is
 * looser still — it refuses only the LITERAL empty string, not a
 * whitespace-only one — so mirroring the STRICTER `handleRecognizerSet` rule
 * here for BOTH buttons is deliberate: a probe on a whitespace-only model id
 * would not be refused up front by main, but would still fail once
 * `resolveRecognizerConfig` tries to use it, so gating it here saves a round
 * trip to a failure the user did not cause on purpose.
 */
export function visionSubmitDisabled(connectionId: string, modelId: string): boolean {
  return connectionId === "" || modelId.trim() === "";
}
