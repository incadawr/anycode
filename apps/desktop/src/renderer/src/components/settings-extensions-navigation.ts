import type { SettingsPaneId } from "./SettingsScreen.js";

export type SettingsPaneSelection = { pane: SettingsPaneId; tabId: string; scope: "project" | "user" };
export type SettingsPaneSelectionDetail = SettingsPaneId | SettingsPaneSelection;
export type SettingsPaneRequest = SettingsPaneSelection & { token: number };

/** The rail supplies its allowlist; the event never carries a filesystem path. */
export function parseSettingsPaneSelection(detail: unknown, panes: readonly SettingsPaneId[]): SettingsPaneSelectionDetail | null {
  const isPane = (value: unknown): value is SettingsPaneId => typeof value === "string" && panes.includes(value as SettingsPaneId);
  if (isPane(detail)) return detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const record = detail as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !["pane", "tabId", "scope"].every((key) => Object.hasOwn(record, key))) return null;
  if (!isPane(record.pane) || typeof record.tabId !== "string" || !record.tabId.trim()
    || (record.scope !== "project" && record.scope !== "user")) return null;
  return { pane: record.pane, tabId: record.tabId, scope: record.scope };
}
