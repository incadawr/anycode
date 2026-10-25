/**
 * state.json hardening (Taskana 4732 S1-B executor addendum): re-validate
 * the `plugins` record keys against the manifest name pattern and every
 * `active`/`previous` as a STRICT semver BEFORE any store path is built
 * from them, so `.store/<name>/<active>` can never escape the store root.
 * Invalid entries are dropped with a problem (fail-soft, mirrors every
 * sibling discovery subsystem); the drop persists on the next state write.
 */

import { PLUGIN_NAME_RE } from "@anycode/core/plugins-admin";
import { isValidSemver } from "@anycode/core/plugins-admin";
import type { PluginStateEntry, PluginsState } from "@anycode/core/plugins-admin";

/**
 * A version string that can be embedded in a store path: a strict semver
 * (digits.digits.digits, optional prerelease/build) — no `/`, no `..`, no
 * separators at all. Belt AND suspenders: isValidSemver already rejects
 * those, the explicit `-1`/`.` checks document the path-safety intent.
 */
export function isStoreVersionSafe(version: string): boolean {
  if (version.includes("/") || version.includes("\\") || version.includes("..")) {
    return false;
  }
  if (version === "." || version === "..") {
    return false;
  }
  return isValidSemver(version);
}

/** True when a state `plugins` key is a safe manifest name (name-pattern, no separators). */
export function isStoreNameSafe(name: string): boolean {
  return PLUGIN_NAME_RE.test(name);
}

/**
 * Drops every invalid `plugins` entry (bad name key, unsafe active/previous,
 * non-store-safe source path shapes) collecting one problem per drop. The
 * input state is NOT mutated; `disabled`/`removedDefaults` entries with
 * unsafe names are dropped the same way.
 */
export function sanitizePluginState(state: PluginsState, inheritedProblems: string[] = []): { state: PluginsState; problems: string[] } {
  const problems = [...inheritedProblems];
  const plugins: Record<string, PluginStateEntry> = {};
  for (const [name, entry] of Object.entries(state.plugins)) {
    if (!isStoreNameSafe(name)) {
      problems.push(`Plugin state entry ${JSON.stringify(name)} dropped: name does not match the manifest name pattern`);
      continue;
    }
    if (entry.source.kind !== "local" && !isStoreVersionSafe(entry.active)) {
      problems.push(`Plugin "${name}" dropped: active version ${JSON.stringify(entry.active)} is not a strict semver`);
      continue;
    }
    if (entry.previous !== undefined && entry.source.kind !== "local" && !isStoreVersionSafe(entry.previous)) {
      problems.push(`Plugin "${name}" dropped: previous version ${JSON.stringify(entry.previous)} is not a strict semver`);
      continue;
    }
    if (entry.source.kind === "local" && !entry.source.path.startsWith("/")) {
      problems.push(`Plugin "${name}" dropped: local source path is not absolute`);
      continue;
    }
    plugins[name] = entry;
  }
  const disabled = state.disabled.filter((name) => {
    if (isStoreNameSafe(name)) return true;
    problems.push(`Disabled-list entry ${JSON.stringify(name)} dropped: invalid name`);
    return false;
  });
  const removedDefaults = state.removedDefaults.filter((name) => {
    if (isStoreNameSafe(name)) return true;
    problems.push(`removedDefaults entry ${JSON.stringify(name)} dropped: invalid name`);
    return false;
  });
  return { state: { ...state, plugins, disabled, removedDefaults }, problems };
}
