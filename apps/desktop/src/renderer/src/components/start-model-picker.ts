/**
 * TASK.131 — pure decision logic for the New Session model picker.
 *
 * The picker's FORM is a drill-down (owner decision 17.08, replacing the
 * two-pane rail and the horizontal tab row that preceded it): the root level
 * offers three popular models plus one row per connection GROUP, clicking a
 * group opens that group's models as a new level, and a model that declares
 * an effort vocabulary gets an effort level of its own. Everything the form
 * decides — which models are popular, which groups exist and in what order,
 * which effort levels a model even has, how tall the popover may grow — is a
 * pure function here, unit-tested the same way `StartScreen.tsx`'s own
 * exported helpers are (this package's vitest runs `environment: "node"`, so
 * components are not rendered in tests).
 *
 * The JSX in StartScreen.tsx consumes this module; the CSS consumes the px
 * numbers via inline styles the JSX sets.
 */
import type {
  CatalogSummary,
  CustomProviderRecord,
  ProviderConnection,
} from "../../../shared/settings.js";
import type { SessionSummary } from "../../../shared/tabs.js";
import { connectionDisplayName } from "./ConnectionTile.js";
import { providerModelsFor } from "./ModelPill.js";

// ── D4: catalog-first ordering ──

/**
 * The display order for one connection's offered models (TASK.131 D4): the
 * provider catalog's own order — deliberately curated fresh-first
 * (`catalog-data.ts` lays `glm-5.3` before `glm-4.5`) — is authoritative;
 * live-fetched ids the catalog doesn't know append AFTER it, in the
 * provider's own (alphabetical) order. A live list that exactly covers the
 * catalog ids re-orders them back to catalog order; unknown ids never
 * displace known ones. Exported for unit testing.
 */
export function orderModelsByCatalog(
  catalogModels: readonly { id: string; name?: string }[] | undefined,
  offered: readonly { id: string; name?: string }[],
): { id: string; name?: string }[] {
  const byId = new Map(offered.map((m) => [m.id, m]));
  const ordered: { id: string; name?: string }[] = [];
  for (const entry of catalogModels ?? []) {
    const hit = byId.get(entry.id);
    if (hit !== undefined) {
      ordered.push(hit);
      byId.delete(entry.id);
    }
  }
  for (const leftover of byId.values()) {
    ordered.push(leftover);
  }
  return ordered;
}

/**
 * `providerModelsFor` + D4 ordering in one step: the connection's offered
 * models (live list, else catalog, else curated custom subset — that
 * resolution stays `providerModelsFor`'s own, not duplicated), re-ordered
 * catalog-first. `undefined` propagates (no offered list at all). Exported
 * for unit testing.
 */
export function connectionOfferedModels(
  connection: ProviderConnection,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
): readonly { id: string; name?: string }[] | undefined {
  const resolved = providerModelsFor(connection.providerId, catalog, custom, connection.models);
  if (resolved === undefined) {
    return undefined;
  }
  const catalogHit = catalog?.find((entry) => entry.id === connection.providerId)?.models;
  return orderModelsByCatalog(catalogHit, resolved);
}

// ── D1: groups (filter + order) ──

/** One connection's group — a row on the picker's root level, a level of its own once opened. */
export interface StartModelMenuGroup {
  /** The connection's real id — always defined, even for the active connection's group. */
  connectionId: string;
  /** The connection's provider id. */
  providerId: string;
  /** Group row text — `connectionDisplayName`'s auto-naming, the SAME label Settings/Welcome already show. */
  label: string;
  /**
   * TASK.131 D2: a muted disambiguator for connections whose auto-label
   * collides (two unlabeled `custom` connections both named "Custom") — the
   * connection's own baseUrl host, or `undefined` when the label is already
   * unique or the connection declares no baseUrl. Rendered beside the label,
   * never part of the label itself.
   */
  subtitle: string | undefined;
  items: StartModelMenuItem[];
}

/** One selectable row inside a `StartModelMenuGroup`. */
export interface StartModelMenuItem {
  id: string;
  name: string;
  /**
   * True exactly for the item matching BOTH axes of the current pair
   * (connection id + model id); the same model id in two different
   * connections' groups marks current only on the actually-current one.
   */
  current: boolean;
}

/**
 * TASK.131 D1 (owner live smoke 16.08): the group set and ORDER.
 * Filtering: a connection whose offered list resolves EMPTY is excluded — the
 * smoke showed three 0-model connections occupying the TOP of the list, each
 * clicking into a blank pane. (The current pair's connection survives with its
 * current-model row so the checkmark's pair is always reachable.)
 * Ordering: the current pair's connection first (where the user's next pick
 * most plausibly is), then DESCENDING offered-model count (the smoke's `9`
 * connection sat under three empties), ties broken by the settings order.
 * Stable: JS `sort` is stable and the comparator only crosses the tie boundary
 * on equal counts. Exported for unit testing.
 */
export function buildStartModelGroups(
  connections: readonly ProviderConnection[],
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  current: { connectionId: string | undefined; modelId: string },
): StartModelMenuGroup[] {
  const groups: StartModelMenuGroup[] = [];
  // D2 pre-pass: label collision counts must see ALL connections before any
  // group is built — a single pass would miss the collision for every
  // connection processed before its twin.
  const labelCounts = new Map<string, number>();
  for (const connection of connections) {
    const label = connectionDisplayName(
      connection,
      catalog?.find((entry) => entry.id === connection.providerId)?.name ?? "Custom",
      connections,
    );
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  for (const connection of connections) {
    const label = connectionDisplayName(
      connection,
      catalog?.find((entry) => entry.id === connection.providerId)?.name ?? "Custom",
      connections,
    );
    const isCurrentConnection = connection.id === current.connectionId;
    const offered = connectionOfferedModels(connection, catalog, custom);
    let items: StartModelMenuItem[];
    if (isCurrentConnection) {
      // Mirrors the pre-existing current-connection behavior: the current
      // model is always present (appended when the catalog doesn't carry it)
      // so the checkmark's row exists even for an empty/absent list.
      items = (offered ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, current: false }));
      if (!items.some((m) => m.id === current.modelId)) {
        items.push({ id: current.modelId, name: current.modelId, current: false });
      }
      for (const item of items) {
        item.current = item.id === current.modelId;
      }
    } else if (offered !== undefined && offered.length > 0) {
      items = offered.map((m) => ({ id: m.id, name: m.name ?? m.id, current: false }));
    } else {
      continue; // D1: 0-model connections leave the picker entirely.
    }
    const subtitle =
      (labelCounts.get(label) ?? 0) > 1 && connection.baseUrl ? connectionBaseUrlHost(connection.baseUrl) : undefined;
    groups.push({
      connectionId: connection.id,
      providerId: connection.providerId,
      label,
      subtitle,
      items,
    });
  }
  const currentId = current.connectionId;
  return groups.sort((a, b) => {
    if (a.connectionId === currentId) {
      return b.connectionId === currentId ? 0 : -1;
    }
    if (b.connectionId === currentId) {
      return 1;
    }
    return b.items.length - a.items.length;
  });
}

/**
 * TASK.131 D2: the host part of a connection's baseUrl, for the muted
 * disambiguator two connections with colliding auto-labels carry. `undefined`
 * for a malformed URL (the raw string is never shown — it can carry a path or
 * credentials). Exported for unit testing.
 */
export function connectionBaseUrlHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

// ── root level: the popular picks ──

/** One row of the root level's popular strip: a model, plus the group it will be picked from. */
export interface StartModelPopularRow {
  connectionId: string;
  modelId: string;
  name: string;
  /** The owning group's label — two connections can offer the same model id, so the row says which one it means. */
  groupLabel: string;
  current: boolean;
}

/** How many sessions back `deriveRecentModelIds` looks for the popularity count. */
export const START_MODEL_RECENT_WINDOW = 30;

/**
 * The model ids of the user's most recent sessions, newest first (TASK.131
 * D6). "Popular" is measured from the user's OWN history rather than a
 * curated constant in code — the constant was what made the strip disappear
 * for a user whose providers it did not happen to name (owner live smoke
 * 16.08: «пропали избранные»). Windowed so a long-abandoned model cannot
 * outvote this month's by sheer accumulated count. Exported for unit testing.
 */
export function deriveRecentModelIds(
  sessions: readonly SessionSummary[],
  window: number = START_MODEL_RECENT_WINDOW,
): string[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, window)
    .map((session) => session.model)
    .filter((model) => model !== "");
}

/**
 * TASK.131 D6 + owner decision 17.08 ("топ 3 популярных"): the root level's
 * three quick picks. Ranked by how often the model appears in the recent
 * session window (ties → the more recently used one), each mapped to a group
 * that actually offers it — the CURRENT connection's group when it does, so a
 * quick pick never silently switches connection under the user; otherwise the
 * first group in `groups` order that offers it. Ids no connected group offers
 * are dropped (a model from a since-deleted connection, or a Codex session's
 * own model id).
 *
 * The list is then topped up from the FIRST group's own catalog order
 * (current connection first, fresh models first) so a user with no history
 * still gets three real picks instead of an empty strip. Exported for unit
 * testing.
 */
export function buildStartModelPopularRows(
  groups: readonly StartModelMenuGroup[],
  recentModelIds: readonly string[],
  currentConnectionId: string | undefined,
  limit = 3,
): StartModelPopularRow[] {
  const counts = new Map<string, { count: number; firstSeen: number }>();
  recentModelIds.forEach((id, index) => {
    const hit = counts.get(id);
    if (hit === undefined) {
      counts.set(id, { count: 1, firstSeen: index });
    } else {
      hit.count += 1;
    }
  });
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].firstSeen - b[1].firstSeen)
    .map(([id]) => id);

  const rows: StartModelPopularRow[] = [];
  const taken = new Set<string>();
  function offer(modelId: string): void {
    if (rows.length >= limit || taken.has(modelId)) {
      return;
    }
    const owner =
      groups.find((group) => group.connectionId === currentConnectionId && group.items.some((m) => m.id === modelId)) ??
      groups.find((group) => group.items.some((m) => m.id === modelId));
    const item = owner?.items.find((m) => m.id === modelId);
    if (owner === undefined || item === undefined) {
      return;
    }
    taken.add(modelId);
    rows.push({
      connectionId: owner.connectionId,
      modelId,
      name: item.name,
      groupLabel: owner.label,
      current: item.current,
    });
  }
  for (const id of ranked) {
    offer(id);
  }
  for (const item of groups[0]?.items ?? []) {
    offer(item.id);
  }
  return rows;
}

// ── effort: the vocabulary belongs to the MODEL ──

/**
 * The legacy effort vocabulary a reasoning model without its own
 * `effortLevels` accepts — the exact fallback core's own
 * `resolveEffortLevels` (`packages/core/src/provider/capabilities.ts`)
 * applies, duplicated here because the renderer never imports core.
 */
export const START_MODEL_DEFAULT_EFFORTS: readonly string[] = ["off", "low", "medium", "high"];

/**
 * TASK.131 (owner decision 17.08: «effort у разных моделей по-разному
 * определяется»): the effort levels ONE model accepts, or `undefined` when it
 * accepts none and the picker must not show an effort level at all.
 *
 * The vocabulary belongs to the model, never to the app: `catalog-data.ts`
 * gives `glm-5.2` off/high/max, `k3` low/high/max, `kimi-for-coding`
 * low/medium/high, Claude off/low/medium/high, `deepseek-reasoner` off/high,
 * and most models nothing at all. This mirrors core's `resolveEffortLevels`
 * rule exactly — not reasoning-capable ⇒ no vocabulary; reasoning-capable
 * without an explicit list ⇒ the legacy four — so the picker can only ever
 * offer a level the host would also accept (host-side `resolveReasoningEffort`
 * fails closed on anything else).
 *
 * A model the catalog does not know (a live-fetched id) has no declared
 * vocabulary and therefore no effort level: guessing one would offer levels
 * the host would then reject. Exported for unit testing.
 */
export function startModelEffortLevels(
  providerId: string | undefined,
  modelId: string,
  catalog: CatalogSummary | undefined,
): readonly string[] | undefined {
  const matched = catalog
    ?.find((entry) => entry.id === providerId)
    ?.models.find((model) => model.id === modelId);
  if (matched?.reasoning !== true) {
    return undefined;
  }
  return matched.effortLevels ?? START_MODEL_DEFAULT_EFFORTS;
}

/**
 * The effort a draft should carry after its model changed (TASK.131): the
 * previous pick when the NEW model's vocabulary also contains it, else
 * `undefined` — "no explicit pick", which lets the connection's own persisted
 * effort stand. Never silently coerces to another level: a pick the new model
 * cannot honor is dropped, not translated. Exported for unit testing.
 */
export function carryDraftEffort(
  currentEffort: string | undefined,
  efforts: readonly string[] | undefined,
): string | undefined {
  if (currentEffort === undefined || efforts === undefined || !efforts.includes(currentEffort)) {
    return undefined;
  }
  return currentEffort;
}

/**
 * The effort the picker DISPLAYS for the pair it is about to start
 * (TASK.131): the draft's own pick when it has one, else the effort the
 * target connection already persists (`ProviderConnection.reasoningEffort` —
 * what the session would boot with if the user never opened this level), else
 * the vocabulary's own first level. `undefined` only when the model declares
 * no vocabulary, which is exactly when no effort level is rendered. Exported
 * for unit testing.
 */
export function resolveStartModelEffort(
  draftEffort: string | undefined,
  connectionEffort: string | undefined,
  efforts: readonly string[] | undefined,
): string | undefined {
  if (efforts === undefined || efforts.length === 0) {
    return undefined;
  }
  if (draftEffort !== undefined && efforts.includes(draftEffort)) {
    return draftEffort;
  }
  if (connectionEffort !== undefined && efforts.includes(connectionEffort)) {
    return connectionEffort;
  }
  return efforts[0];
}

// ── popover geometry: the popover moves, it does not grow a scrollbar ──

/** One row's height budget — `.start-model-item`/`.start-model-row`'s pinned `min-height` in app.css. */
export const START_MODEL_ROW_HEIGHT_PX = 30;
/** One divider's height budget — `.start-model-divider`'s 1px rule plus its margins. */
export const START_MODEL_DIVIDER_PX = 9;
/** The popover's own vertical padding (top + bottom). */
export const START_MODEL_MENU_PADDING_PX = 8;
/** The gap the popover keeps from the window edge it hangs toward. */
export const START_MODEL_MENU_MARGIN_PX = 12;

/**
 * A level's rendered height in px, from its row and divider counts
 * (TASK.131). Used only as the DEMAND side of the flip decision — the
 * popover is never given this as a fixed height, so an estimate that is a
 * pixel or two off can at worst flip a popover that had exactly one row of
 * slack. Exported for unit testing.
 */
export function startModelLevelHeightPx(rowCount: number, dividerCount = 0): number {
  return rowCount * START_MODEL_ROW_HEIGHT_PX + dividerCount * START_MODEL_DIVIDER_PX + START_MODEL_MENU_PADDING_PX;
}

/**
 * Whether the popover hangs ABOVE the chip instead of below it (TASK.131).
 * Down is the default (the popover's anchor grammar); it flips up only when
 * the space below the chip cannot hold the tallest level the user can reach
 * while the space above holds more. The decision is made ONCE per open,
 * against the tallest level, so drilling in never makes the popover jump
 * across its own chip. Pure: callers pass measured px. Exported for unit
 * testing.
 */
export function startModelMenuFlipsUp(
  viewportHeight: number,
  chip: { top: number; bottom: number },
  tallestLevelPx: number,
  gapPx: number,
): boolean {
  const below = viewportHeight - chip.bottom - gapPx - START_MODEL_MENU_MARGIN_PX;
  const above = chip.top - gapPx - START_MODEL_MENU_MARGIN_PX;
  return below < tallestLevelPx && above > below;
}

/**
 * The popover's max height in px: the room ACTUALLY available on the side it
 * hangs toward — measured from the chip's BOTTOM edge when it hangs down and
 * from its TOP edge when it hangs up — never more.
 *
 * This is a `max-height`, not a height: a level shorter than the room renders
 * at its natural size with no scrollbar at all, which is the owner's standing
 * requirement («попап не должен был скроллбокс порождать»). The predecessor
 * clamped this value UP to a minimum row count, which is how the popover came
 * to run past the window's bottom edge on the live smoke — a floor cannot
 * create room that isn't there. Exported for unit testing.
 */
export function startModelMenuMaxHeightPx(
  viewportHeight: number,
  chip: { top: number; bottom: number },
  flipUp: boolean,
  gapPx: number,
): number {
  const room = flipUp
    ? chip.top - gapPx - START_MODEL_MENU_MARGIN_PX
    : viewportHeight - chip.bottom - gapPx - START_MODEL_MENU_MARGIN_PX;
  return Math.max(Math.round(room), START_MODEL_ROW_HEIGHT_PX);
}
