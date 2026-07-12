/**
 * Skills enable/disable settings (design slice-P7.20-cut.md §5 W1). Skills are
 * default-ENABLED by existence; the ONLY persisted state is a disable-list
 * `skills.disabled: string[]` in the shared `.anycode/config.json` (project +
 * user scope). This module reads that list fail-soft (boot path) and patches it
 * atomically, touching ONLY the `skills.disabled` subtree so every sibling
 * config key (mcpServers/hooks/telemetry/…) is preserved byte-semantically.
 *
 * Boot byte-invariance: absent/empty `skills.disabled` ⇒ an EMPTY set ⇒
 * discovery unfiltered ⇒ result/port/prompt-section byte-identical to today.
 */

import type { FileSystemPort } from "../ports/file-system.js";
import {
  atomicWriteJson,
  isPlainObject,
  readRawConfig,
  serializeConfigWrite,
} from "../util/config-file.js";

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir. */
export function anycodeConfigPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/**
 * Reads `skills.disabled` from a single config file fail-soft: a missing file, a
 * malformed file, a missing/nonarray `skills.disabled`, or any read/parse error
 * all contribute NOTHING (an empty contribution) rather than throwing — this
 * runs on the boot path. Only string entries are kept.
 */
async function readDisabledFrom(fs: FileSystemPort, path: string): Promise<string[]> {
  try {
    if (!(await fs.exists(path))) {
      return [];
    }
    const raw = await fs.readFile(path);
    if (raw.trim() === "") {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return [];
    }
    const skills = parsed.skills;
    if (!isPlainObject(skills)) {
      return [];
    }
    const disabled = skills.disabled;
    if (!Array.isArray(disabled)) {
      return [];
    }
    return disabled.filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/**
 * Loads the union of disabled skill names across project + user config
 * (`<ws>/.anycode/config.json` and `<home>/.anycode/config.json`). workspace ===
 * home collapses to a single read (same "load once" dedup as the roots recipe).
 * Fail-soft throughout; returns an empty set when nothing is disabled.
 */
export async function loadDisabledSkills(
  fs: FileSystemPort,
  opts: { workspace: string; home: string },
): Promise<Set<string>> {
  const { workspace, home } = opts;
  const paths =
    workspace === home
      ? [anycodeConfigPath(workspace)]
      : [anycodeConfigPath(workspace), anycodeConfigPath(home)];

  const disabled = new Set<string>();
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    for (const name of await readDisabledFrom(fs, path)) {
      disabled.add(name);
    }
  }
  return disabled;
}

/**
 * Patches ONLY `skills.disabled` in one config file: adds `name` when disabling,
 * removes it when enabling. Every other top-level key AND every other `skills.*`
 * sub-key is preserved byte-semantically; the write is atomic (tmp+rename,
 * mode-preserve) and per-path serialized via the shared config queue (so it
 * never races an MCP patch on the same file). A no-op change (already in the
 * desired state) still rewrites the file harmlessly but does not corrupt siblings.
 */
export async function setSkillEnabled(
  fs: FileSystemPort,
  configPath: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  await serializeConfigWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);

    const existingSkills = config.skills;
    const skills: Record<string, unknown> = isPlainObject(existingSkills) ? existingSkills : {};
    config.skills = skills;

    const existingDisabled = skills.disabled;
    const current = Array.isArray(existingDisabled)
      ? existingDisabled.filter((n): n is string => typeof n === "string")
      : [];

    let next: string[];
    if (enabled) {
      next = current.filter((n) => n !== name);
    } else {
      next = current.includes(name) ? current : [...current, name];
    }
    skills.disabled = next;

    await atomicWriteJson(fs, configPath, config);
  });
}

/**
 * Removes `name` from `skills.disabled` in one config file if present (no-op
 * when absent). Used by delete to avoid leaving an orphan disabled-list entry
 * for a skill that no longer exists. Never creates the key when absent.
 */
export async function removeDisabledEntry(
  fs: FileSystemPort,
  configPath: string,
  name: string,
): Promise<void> {
  await serializeConfigWrite(configPath, async () => {
    const config = await readRawConfig(fs, configPath);
    const skills = config.skills;
    if (!isPlainObject(skills)) {
      return;
    }
    const disabled = skills.disabled;
    if (!Array.isArray(disabled)) {
      return;
    }
    const filtered = disabled.filter((n) => n !== name);
    if (filtered.length === disabled.length) {
      return; // not present — leave the file untouched.
    }
    skills.disabled = filtered;
    await atomicWriteJson(fs, configPath, config);
  });
}
