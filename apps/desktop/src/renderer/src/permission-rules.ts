/**
 * Pure grouping helper for the Settings "Permissions" editor (slice P7.16
 * §4.1, design/slice-P7.16-cut.md). Replaces the flat always-allow rule dump
 * with a per-tool grouped view: `groupAlwaysAllowRules` buckets rules by
 * EXACT `toolName` — never normalized, same law as PermissionModal's
 * `formatPermissionTitle` (a mis-cased/unknown tool name is its own group,
 * not folded into a known one). Group order is first-appearance order in the
 * input array; in-group order is stored order — both preserved by a single
 * forward pass with no sort, so the render is a faithful reflection of
 * `settings.permissions.alwaysAllow` (the persisted array) rather than an
 * alphabetized or otherwise reordered view.
 */
import type { AlwaysAllowRule } from "../../shared/settings.js";

export interface RuleGroup {
  toolName: string;
  rules: AlwaysAllowRule[];
}

export function groupAlwaysAllowRules(rules: readonly AlwaysAllowRule[]): RuleGroup[] {
  const groups: RuleGroup[] = [];
  const byTool = new Map<string, RuleGroup>();
  for (const rule of rules) {
    let group = byTool.get(rule.toolName);
    if (!group) {
      group = { toolName: rule.toolName, rules: [] };
      byTool.set(rule.toolName, group);
      groups.push(group);
    }
    group.rules.push(rule);
  }
  return groups;
}
