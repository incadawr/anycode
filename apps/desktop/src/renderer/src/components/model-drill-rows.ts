/**
 * TASK.106 cut-2 §D4/§D3 — the drill-down picker's pure decision layer for a
 * RUNNING session (the New Session screen's own equivalent lives inline in
 * StartScreen.tsx over `start-model-picker.ts`).
 *
 * Same rules, different context: the start screen picks a pair for a session
 * that does not exist yet (a draft), whereas here the pair belongs to a tab
 * that is already attached to a host. That difference shows up in exactly two
 * places, and both are decided here rather than in the JSX:
 *
 * - picking a model from the tab's OWN connection is the pre-existing
 *   `set_model` path, while picking one from ANOTHER connection is a rebind
 *   (§D1: shutdown + respawn on the resume path) — `pickSessionDrillRow`;
 * - a rebind carries the current effort only when the TARGET model's own
 *   vocabulary contains it, and otherwise resets it EXPLICITLY (§D3, spec §4
 *   item 4: nothing is substituted silently) — `resolveRebindEffort`.
 *
 * Everything else — which groups exist and in what order, which models are
 * popular, which effort levels a model even has — is `start-model-picker.ts`'s
 * already-tested logic, imported rather than re-derived. This package's vitest
 * runs `environment: "node"`, so these are plain functions with no React in
 * sight; `model-drill-menu.tsx` renders whatever they return.
 */
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../../shared/settings.js";
import { EFFORT_LABELS } from "./ModelPill.js";
import {
  buildStartModelGroups,
  buildStartModelPopularRows,
  resolveStartModelEffort,
  startModelEffortLevels,
  type StartModelMenuGroup,
  type StartModelPopularRow,
} from "./start-model-picker.js";

/**
 * One focusable row of whatever level the drill-down is showing — the same
 * five shapes `StartScreen.tsx`'s `StartModelMenuRow` declares, under a name
 * that does not tie the shared component to the start screen. Every level is
 * a flat list of these so the roving-focus keyboard stays ONE code path.
 */
export type ModelDrillRow =
  | { kind: "popular"; connectionId: string; modelId: string; name: string; groupLabel: string; current: boolean }
  | { kind: "group"; connectionId: string; label: string; subtitle: string | undefined; count: number }
  | { kind: "effort-open"; value: string }
  | { kind: "model"; connectionId: string; modelId: string; name: string; current: boolean }
  | { kind: "effort"; value: string; current: boolean };

/** Which level of the drill-down is on screen. `group` carries the connection whose models it lists. */
export type ModelDrillPage = { kind: "root" } | { kind: "group"; connectionId: string } | { kind: "effort" };

/**
 * An effort level's human-readable label — ModelPill's own `EFFORT_LABELS`
 * table (the SAME wording both pickers already show), falling back to the raw
 * level for a vocabulary entry that table does not name (a catalog model may
 * declare any level string). Exported for unit testing.
 */
export function modelDrillEffortLabel(level: string): string {
  return EFFORT_LABELS[level as keyof typeof EFFORT_LABELS] ?? level;
}

/** Inputs of `buildSessionDrillRows` — every axis explicit, nothing read from a store. */
export interface SessionDrillArgs {
  connections: readonly ProviderConnection[];
  catalog: CatalogSummary | undefined;
  custom: readonly CustomProviderRecord[] | undefined;
  /** The tab's pinned connection (`pinnedConnection.connectionId`), or the active one for an unpinned tab. */
  currentConnectionId: string | undefined;
  /** The tab's live model (`state.model`) — the pair's other axis. */
  currentModelId: string;
  /** Model ids of the user's recent sessions, newest first — the caller derives them (`deriveRecentModelIds`). */
  recentModelIds: readonly string[];
  /** Which level is on screen; omitted = the root level. */
  page?: ModelDrillPage;
  /** The tab's live reasoning effort (`state.reasoningEffort`), if any. */
  currentEffort?: string;
}

/** What `buildSessionDrillRows` hands the component (rows) and its caller (the pieces the rows were built from). */
export interface SessionDrillRows {
  rows: ModelDrillRow[];
  groups: StartModelMenuGroup[];
  popular: StartModelPopularRow[];
  /** The CURRENT pair's effort vocabulary — `undefined` hides the effort level entirely. */
  efforts: readonly string[] | undefined;
  /** The effort the picker displays for the current pair; `undefined` exactly when `efforts` is. */
  effort: string | undefined;
}

/**
 * TASK.106 cut-2 §D4: the drill-down's rows for a running tab.
 *
 * The group set spans EVERY connected connection (that is the cut's whole
 * point — a running session can move to another provider), with the tab's own
 * connection first and its current model checkmarked; the root level then
 * carries the three popular picks, one row per group, and — only when the
 * current model declares a vocabulary — the effort row. Drilling into a group
 * lists that group's models; drilling into effort lists the levels.
 *
 * The current pair passed down to `buildStartModelGroups` is the TAB's pair
 * (pin + live model), not the app's active connection, so a pinned session
 * never checkmarks somebody else's row. Exported for unit testing.
 */
export function buildSessionDrillRows(args: SessionDrillArgs): SessionDrillRows {
  const page = args.page ?? { kind: "root" };
  const groups = buildStartModelGroups(args.connections, args.catalog, args.custom, {
    connectionId: args.currentConnectionId,
    modelId: args.currentModelId,
  });
  const popular = buildStartModelPopularRows(groups, args.recentModelIds, args.currentConnectionId);
  const currentConnection = args.connections.find((connection) => connection.id === args.currentConnectionId);
  const efforts = startModelEffortLevels(currentConnection?.providerId, args.currentModelId, args.catalog);
  const effort = resolveStartModelEffort(args.currentEffort, currentConnection?.reasoningEffort, efforts);

  let rows: ModelDrillRow[];
  if (page.kind === "group") {
    const open = groups.find((group) => group.connectionId === page.connectionId);
    rows = (open?.items ?? []).map((item) => ({
      kind: "model" as const,
      connectionId: page.connectionId,
      modelId: item.id,
      name: item.name,
      current: item.current,
    }));
  } else if (page.kind === "effort") {
    rows = (efforts ?? []).map((level) => ({ kind: "effort" as const, value: level, current: level === effort }));
  } else {
    rows = [
      ...popular.map((row) => ({
        kind: "popular" as const,
        connectionId: row.connectionId,
        modelId: row.modelId,
        name: row.name,
        groupLabel: row.groupLabel,
        current: row.current,
      })),
      ...groups.map((group) => ({
        kind: "group" as const,
        connectionId: group.connectionId,
        label: group.label,
        subtitle: group.subtitle,
        count: group.items.length,
      })),
      ...(effort !== undefined ? [{ kind: "effort-open" as const, value: effort }] : []),
    ];
  }
  return { rows, groups, popular, efforts, effort };
}

/** What activating a model/popular row means for a RUNNING tab (§D3/§D6). */
export type SessionDrillPick =
  | { kind: "set_model"; modelId: string }
  | { kind: "rebind"; connectionId: string; modelId: string };

/**
 * TASK.106 cut-2 §D3: the verb behind a picked pair.
 *
 * The tab's OWN connection keeps the pre-existing, cheap path — `set_model` on
 * the live host, no respawn, no transcript reload. Any other connection means
 * the provider is baked into a different fork env (§D1), so the pick is a
 * rebind: the target connection's model is written first, then the host is
 * shut down and respawned on the resume path.
 *
 * An UNPINNED tab (`currentConnectionId === undefined`) treats every row as
 * foreign — there is no known connection the live host provably belongs to,
 * and fail-closed here means "go through the rebind path", whose own main-side
 * guards (`same_connection`, `not_ready`, …) are the real backstop. Exported
 * for unit testing.
 */
export function pickSessionDrillRow(args: {
  currentConnectionId: string | undefined;
  row: { kind: "popular" | "model"; connectionId: string; modelId: string };
}): SessionDrillPick {
  if (!isForeignPick(args.row.connectionId, args.currentConnectionId)) {
    return { kind: "set_model", modelId: args.row.modelId };
  }
  return { kind: "rebind", connectionId: args.row.connectionId, modelId: args.row.modelId };
}

/** What happens to the current reasoning effort when a rebind moves the session to another model. */
export interface RebindEffortDecision {
  /** The effort to carry over — set only when the target model's own vocabulary contains it. */
  carried: string | undefined;
  /** The effort the target connection is reset to when the current one cannot be honored. */
  resetTo: string | undefined;
  /** True exactly when the current effort was dropped — the UI must SAY so (§D5's ledger note). */
  dropped: boolean;
}

/**
 * TASK.106 cut-2 §D3 (spec §4 item 4 — "nothing is substituted silently"): the
 * effort a rebind writes onto the target connection.
 *
 * The vocabulary belongs to the MODEL, so the question is only ever whether
 * the TARGET model accepts the level the session is running at:
 * - no vocabulary at all (the target model is not reasoning-capable, or the
 *   catalog knows nothing about it) ⇒ nothing to carry and nothing to reset —
 *   an effort written here would be one the host would reject anyway;
 * - the level is in the vocabulary ⇒ it carries over untouched;
 * - it is not ⇒ the effort is RESET, never translated to a neighbouring level:
 *   the target connection's own persisted effort when that one is valid, else
 *   the vocabulary's first entry (`resolveStartModelEffort`'s rule), and
 *   `dropped` tells the caller to name the reset in the transcript.
 *
 * A session with no effort at all (`currentEffort === undefined`) has nothing
 * to lose, so it is never reported as dropped. Exported for unit testing.
 */
export function resolveRebindEffort(args: {
  currentEffort: string | undefined;
  targetProviderId: string;
  targetModelId: string;
  catalog: CatalogSummary | undefined;
  targetConnectionEffort: string | undefined;
}): RebindEffortDecision {
  const efforts = startModelEffortLevels(args.targetProviderId, args.targetModelId, args.catalog);
  if (args.currentEffort === undefined || efforts === undefined) {
    return { carried: undefined, resetTo: undefined, dropped: false };
  }
  if (efforts.includes(args.currentEffort)) {
    return { carried: args.currentEffort, resetTo: undefined, dropped: false };
  }
  return {
    carried: undefined,
    resetTo: resolveStartModelEffort(undefined, args.targetConnectionEffort, efforts),
    dropped: true,
  };
}

/**
 * Whether picking this row would SWITCH connection — the predicate behind both
 * the rebind decision above and the muted group label a popular row carries
 * (a pick from the connection already in use needs no annotation; repeating
 * today's connection on every row is pure noise). An unpinned tab has no
 * "own" connection, so every row reads as foreign. Exported for unit testing.
 */
export function isForeignPick(connectionId: string, currentConnectionId: string | undefined): boolean {
  return currentConnectionId === undefined || connectionId !== currentConnectionId;
}
