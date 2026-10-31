/**
 * Taskana 4704 §3.9 (part B) — pure editable-draft model for the role editor
 * shared by RolePickerDialog (first run) and the Settings Roles pane. Same
 * discipline as role-presets.ts: every list mutation is a plain exported
 * function over a draft, so the node-env vitest covers the behavior without
 * jsdom; the JSX only renders and forwards.
 *
 * A draft mirrors the persisted shape (RoleConfig per role) plus the UI-only
 * model/effort text per entry. Entries are addressed by
 * `role + "primary" | fallbackIndex`.
 */
import type { RoleConfig, RoleRouteEntry } from "../../shared/settings.js";
import { ROLE_PRESET_ROLES, sameRoleRoutes, type PresetRole } from "./role-presets.js";

export const ROLE_EFFORT_LEVELS = ["", "off", "low", "medium", "high", "xhigh", "max"] as const;

export type RoleEffortLevel = (typeof ROLE_EFFORT_LEVELS)[number];

/** Editable draft of one route entry (model/effort kept as raw strings). */
export interface DraftEntry {
  /** "" means "not set" — omitted from the persisted entry. */
  engine: "" | "codex" | "claude";
  connection: string;
  provider?: string;
  model: string;
  /** UI-only Custom selection; travels with the entry through reorder/remove. */
  customModel?: boolean;
  effort: RoleEffortLevel;
}

/** Editable draft of one role: primary + fallbacks. */
export interface DraftRole {
  primary: DraftEntry;
  fallbacks: DraftEntry[];
}

export type RolesDraft = Record<PresetRole, DraftRole>;

/** Draft entry from a persisted entry (absent -> blank entry). */
export function toDraftEntry(entry: RoleRouteEntry | undefined): DraftEntry {
  return {
    engine: entry?.engine ?? "",
    connection: entry?.connection ?? "",
    ...(entry?.provider ? { provider: entry.provider } : {}),
    model: entry?.engine && entry.model === "default" ? "" : entry?.model ?? "",
    effort: (entry?.effort ?? "") as RoleEffortLevel,
  };
}

/** Draft from persisted roles (a missing role starts from the blank entry). */
export function toDraft(roles: Partial<Record<PresetRole, RoleConfig>>): RolesDraft {
  const out = {} as RolesDraft;
  for (const role of ["orchestrator", "planner", "executor", "reviewer", "explore"] as const) {
    const config = roles[role];
    out[role] = {
      primary: toDraftEntry(config?.primary),
      fallbacks: (config?.fallbacks ?? []).map(toDraftEntry),
    };
  }
  return out;
}

/** Persisted entry from a draft entry (empty strings dropped; XOR enforced by trim). */
export function fromDraftEntry(entry: DraftEntry): RoleRouteEntry {
  const out: RoleRouteEntry = {};
  if (entry.engine !== "") {
    out.engine = entry.engine;
  }
  if (entry.connection.trim() !== "") {
    out.connection = entry.connection.trim();
  }
  if (entry.provider?.trim()) {
    out.provider = entry.provider.trim();
  }
  if (entry.model.trim() !== "" && !(entry.engine !== "" && entry.model.trim() === "default")) {
    out.model = entry.model.trim();
  }
  if (entry.effort !== "") {
    out.effort = entry.effort;
  }
  return out;
}

/** A route may select at most one engine, connection, or provider. */
export function entryRouteValid(entry: DraftEntry): boolean {
  return Number(entry.engine !== "") + Number(entry.connection.trim() !== "") + Number(Boolean(entry.provider?.trim())) <= 1;
}

/** The whole draft's validity: every entry must be route-valid. */
export function draftValid(draft: RolesDraft): boolean {
  for (const role of Object.keys(draft) as PresetRole[]) {
    const config = draft[role];
    if (!entryRouteValid(config.primary)) {
      return false;
    }
    for (const fallback of config.fallbacks) {
      if (!entryRouteValid(fallback)) {
        return false;
      }
    }
  }
  return true;
}

/** Draft -> the persisted `roles` payload shape (undefined model dropped etc.). */
export function fromDraft(draft: RolesDraft): { roles: Partial<Record<PresetRole, RoleConfig>> } {
  const roles: Partial<Record<PresetRole, RoleConfig>> = {};
  for (const role of Object.keys(draft) as PresetRole[]) {
    const config: RoleConfig = { primary: fromDraftEntry(draft[role].primary) };
    // `fallbacks: []` round-trips as ABSENT — an empty array and a missing
    // key mean the same thing ("no fallbacks") and the preset/edited shapes
    // must stay comparable.
    if (draft[role].fallbacks.length > 0) {
      config.fallbacks = draft[role].fallbacks.map(fromDraftEntry);
    }
    roles[role] = config;
  }
  return { roles };
}

function customFlag(entry: DraftEntry): boolean {
  return entry.customModel === true;
}

/**
 * Same user-visible CHOICE between two drafts. Route equality alone is not
 * enough: `customModel` is UI-only and `fromDraft` drops it, so a draft whose
 * model select sits on "Custom…" with nothing typed yet compares equal to its
 * seed. The first-run dialog must treat that as an edit (the input is open on
 * purpose), otherwise a readiness change replaces the draft and closes it.
 */
export function sameDraftChoice(a: RolesDraft, b: RolesDraft): boolean {
  if (!sameRoleRoutes(fromDraft(a).roles, fromDraft(b).roles)) {
    return false;
  }
  for (const role of ROLE_PRESET_ROLES) {
    if (customFlag(a[role].primary) !== customFlag(b[role].primary)) {
      return false;
    }
    const aFallbacks = a[role].fallbacks;
    const bFallbacks = b[role].fallbacks;
    if (aFallbacks.length !== bFallbacks.length) {
      return false;
    }
    for (let index = 0; index < aFallbacks.length; index += 1) {
      if (customFlag(aFallbacks[index]!) !== customFlag(bFallbacks[index]!)) {
        return false;
      }
    }
  }
  return true;
}

// ── per-entry list mutations (the dialog's add/remove/move) ──

export function addFallback(draft: RolesDraft, role: PresetRole): RolesDraft {
  return {
    ...draft,
    [role]: { ...draft[role], fallbacks: [...draft[role].fallbacks, toDraftEntry(undefined)] },
  };
}

export function removeFallback(draft: RolesDraft, role: PresetRole, index: number): RolesDraft {
  return {
    ...draft,
    [role]: { ...draft[role], fallbacks: draft[role].fallbacks.filter((_, i) => i !== index) },
  };
}

export function moveFallback(draft: RolesDraft, role: PresetRole, index: number, delta: -1 | 1): RolesDraft {
  const fallbacks = [...draft[role].fallbacks];
  const target = index + delta;
  if (target < 0 || target >= fallbacks.length) {
    return draft;
  }
  const [moved] = fallbacks.splice(index, 1);
  fallbacks.splice(target, 0, moved!);
  return { ...draft, [role]: { ...draft[role], fallbacks } };
}

/** Patch one entry (primary when index === null). */
export function patchEntry(draft: RolesDraft, role: PresetRole, index: number | null, patch: Partial<DraftEntry>): RolesDraft {
  if (index === null) {
    return { ...draft, [role]: { ...draft[role], primary: { ...draft[role].primary, ...patch } } };
  }
  const fallbacks = draft[role].fallbacks.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
  return { ...draft, [role]: { ...draft[role], fallbacks } };
}
