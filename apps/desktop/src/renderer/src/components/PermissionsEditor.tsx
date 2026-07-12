/**
 * Grouped always-allow rules editor (Settings "Permissions" pane, slice
 * P7.16 §4.1/§5 W3, design/slice-P7.16-cut.md). Replaces the flat
 * `Bash <pattern> ×` dump that used to live inline in SettingsScreen.tsx
 * (moved verbatim there by W2 as an interim step) with: rules grouped by
 * exact tool name (`groupAlwaysAllowRules`, ../permission-rules.ts), a tool
 * icon per group, a mono pattern per row — or an explicit italic "all uses"
 * pill for a pattern-less rule (the bug this slice fixes: a bare
 * `{toolName:"Edit"}` rule used to render as the unlabelled "Edit ✕"), a
 * labelled remove affordance, and a manual-add form at the bottom.
 *
 * The manual-add form deliberately flows through `buildAlwaysAllowRule`
 * (./PermissionModal.js) — the SAME builder the permission modal's "Always
 * allow" checkbox uses — so the W1-FIX Bash env-prefix sanitizer (§4.2)
 * covers hand-typed patterns for free; this component never constructs a
 * `PermissionRuleAddRequest` by hand.
 *
 * Every exported helper below is pure (or, for `submitPermissionAdd`, takes
 * the store as an explicit argument) so it's testable without DOM rendering
 * — this package's vitest config runs `environment: "node"` (see
 * SettingsScreen.test.ts's docstring), so PermissionsEditor.test.ts covers
 * these helpers directly, the same discipline as every other component test
 * in this directory.
 */
import { useState, type ComponentType, type SVGProps } from "react";
import { useStore } from "zustand";
import type { AlwaysAllowRule, SettingsMutationResult } from "../../../shared/settings.js";
import { useSettingsStore, type SettingsStoreApi } from "../settings-store.js";
import { groupAlwaysAllowRules } from "../permission-rules.js";
import { buildAlwaysAllowRule } from "./PermissionModal.js";
import { FileIcon, Gear, Globe, Terminal, X } from "./icons.js";

type SettingsIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * The four tools `PermissionModal.formatPermissionTitle`/`TITLE_ACTIONS`
 * already know a verb for — the manual-add datalist's baseline options even
 * when no rule of that tool exists yet (§4.1: "the four known tools").
 */
export const KNOWN_TOOL_NAMES: readonly string[] = ["Bash", "Read", "Write", "Edit"];

/** Local tool→icon map (§4.1) — deliberately not shared with any other component; this pane is its only consumer. */
export function ruleToolIcon(toolName: string): SettingsIcon {
  switch (toolName) {
    case "Bash":
      return Terminal;
    case "Read":
    case "Write":
    case "Edit":
      return FileIcon;
    case "WebFetch":
    case "WebSearch":
      return Globe;
    default:
      return Gear;
  }
}

/** True iff the rule carries a non-empty pattern — the gate between the mono pattern span and the "all uses" pill. */
export function ruleHasPattern(rule: AlwaysAllowRule): boolean {
  return typeof rule.pattern === "string" && rule.pattern.length > 0;
}

/** Display text for a rule's pattern cell — NEVER blank (the "Edit ×" bug this slice fixes). */
export function ruleDisplayPattern(rule: AlwaysAllowRule): string {
  return ruleHasPattern(rule) ? (rule.pattern as string) : "all uses";
}

/** `aria-label` for a row's remove button — always names both the tool and the (possibly "all uses") pattern. */
export function ruleRemoveAriaLabel(rule: AlwaysAllowRule): string {
  return `Remove ${rule.toolName} rule ${ruleDisplayPattern(rule)}`;
}

/**
 * Datalist options for the manual-add tool field: every tool name already
 * present in `rules` (first-appearance order), then any of `KNOWN_TOOL_NAMES`
 * not already covered — so a fresh install with zero rules still offers the
 * four known tools.
 */
export function permissionToolOptions(rules: readonly AlwaysAllowRule[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const rule of rules) {
    if (!seen.has(rule.toolName)) {
      seen.add(rule.toolName);
      options.push(rule.toolName);
    }
  }
  for (const known of KNOWN_TOOL_NAMES) {
    if (!seen.has(known)) {
      seen.add(known);
      options.push(known);
    }
  }
  return options;
}

/** Add-button gate: a blank/whitespace-only tool name disables Add — the pattern field is always optional. */
export function canSubmitPermissionAdd(toolName: string): boolean {
  return toolName.trim().length > 0;
}

/**
 * Manual-add submit: routes through `buildAlwaysAllowRule` (the corrected,
 * W1-FIX sanitized builder) before calling `store.getState().addRule` — so a
 * hand-typed Bash pattern gets the same env-prefix stripping as the
 * permission modal's checkbox. Returns `null` (no bridge call) when the tool
 * name is blank, mirroring `canSubmitPermissionAdd`'s gate.
 */
export async function submitPermissionAdd(
  store: SettingsStoreApi,
  toolName: string,
  pattern: string,
): Promise<SettingsMutationResult | null> {
  const trimmedTool = toolName.trim();
  if (!trimmedTool) {
    return null;
  }
  return store.getState().addRule(buildAlwaysAllowRule(trimmedTool, pattern));
}

export interface PermissionsEditorProps {
  store?: SettingsStoreApi;
}

const RULE_ADD_DATALIST_ID = "settings-permission-tool-options";

export function PermissionsEditor({ store = useSettingsStore }: PermissionsEditorProps) {
  const snapshot = useStore(store, (s) => s.snapshot);
  const [toolInput, setToolInput] = useState("");
  const [patternInput, setPatternInput] = useState("");

  // Unreachable from SettingsScreen (it early-returns its own loading row
  // before any pane renders) — a null guard, not a loading state, same
  // convention as ProviderSettings' own snapshot guard.
  if (!snapshot) {
    return null;
  }

  const readOnly = snapshot.readOnly;
  const rules = snapshot.settings.permissions.alwaysAllow;
  const groups = groupAlwaysAllowRules(rules);
  const toolOptions = permissionToolOptions(rules);
  const canAdd = !readOnly && canSubmitPermissionAdd(toolInput);

  async function handleAdd(): Promise<void> {
    const result = await submitPermissionAdd(store, toolInput, patternInput);
    if (result?.ok) {
      setToolInput("");
      setPatternInput("");
    }
  }

  async function handleRemove(rule: AlwaysAllowRule): Promise<void> {
    await store.getState().removeRule(rule);
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Always-allow rules</div>

      {groups.length === 0 && (
        <div className="settings-rule-empty">
          No rules yet — use "Always allow" on a permission prompt to add one.
        </div>
      )}

      {groups.length > 0 && (
        <div className="settings-rule-groups">
          {groups.map((group) => {
            const GroupIcon = ruleToolIcon(group.toolName);
            return (
              <div key={group.toolName} className="settings-rule-group">
                <div className="settings-rule-group-header">
                  <GroupIcon className="settings-rule-group-icon" />
                  <span className="settings-rule-group-name settings-rule-tool">{group.toolName}</span>
                </div>
                <div className="settings-rule-list">
                  {group.rules.map((rule, index) => (
                    <div key={`${rule.toolName}:${rule.pattern ?? ""}:${index}`} className="settings-rule-row">
                      <span className="settings-rule-pattern-cell">
                        {ruleHasPattern(rule) ? (
                          <span className="settings-rule-pattern settings-mcp-name">{rule.pattern}</span>
                        ) : (
                          <span className="settings-rule-allpill">all uses</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="settings-rule-remove"
                        aria-label={ruleRemoveAriaLabel(rule)}
                        disabled={readOnly}
                        onClick={() => void handleRemove(rule)}
                      >
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="settings-rule-add">
        <input
          type="text"
          list={RULE_ADD_DATALIST_ID}
          className="settings-field-input settings-rule-add-tool"
          placeholder="Tool (e.g. Bash)"
          aria-label="Tool name"
          value={toolInput}
          disabled={readOnly}
          onChange={(e) => setToolInput(e.target.value)}
        />
        <datalist id={RULE_ADD_DATALIST_ID}>
          {toolOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <input
          type="text"
          className="settings-field-input settings-mcp-name settings-rule-add-pattern"
          placeholder="Pattern (optional)"
          aria-label="Pattern"
          value={patternInput}
          disabled={readOnly}
          onChange={(e) => setPatternInput(e.target.value)}
        />
        <button
          type="button"
          className="settings-button settings-button-primary"
          disabled={!canAdd}
          onClick={() => void handleAdd()}
        >
          Add
        </button>
      </div>
    </section>
  );
}
