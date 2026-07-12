/**
 * Telemetry user-scope enable toggle (slice P7.22/F19, design slice-P7.22-cut.md
 * §2-D2): a 1:1 mirror of skills/settings.ts's `setSkillEnabled` patcher, over
 * the EXISTING `telemetry.enabled` key in `<home>/.anycode/config.json` — no new
 * setting is invented. Patches ONLY `telemetry.enabled`; every sibling top-level
 * key (mcpServers/skills/hooks/…) AND every sibling `telemetry.*` key (e.g. a
 * user-set `dir`) is preserved value-semantically. Atomic write, serialized per
 * path so this never races an MCP/skills/hooks patch on the same file.
 */

import type { FileSystemPort } from "../ports/file-system.js";
import { atomicWriteJson, isPlainObject, readRawConfig, serializeConfigWrite } from "../util/config-file.js";

/** `<home>/.anycode/config.json`, tolerating a trailing separator on home. */
export function userTelemetryConfigPath(home: string): string {
  return `${home.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/**
 * Patches ONLY `telemetry.enabled` in the user-scope config file, creating the
 * `telemetry` section (and the file itself) when absent. Every other top-level
 * key and every sibling `telemetry.*` key (e.g. `dir`) is preserved.
 */
export async function setUserTelemetryEnabled(
  fs: FileSystemPort,
  home: string,
  enabled: boolean,
): Promise<void> {
  const path = userTelemetryConfigPath(home);
  await serializeConfigWrite(path, async () => {
    const config = await readRawConfig(fs, path);

    const existingTelemetry = config.telemetry;
    const telemetry: Record<string, unknown> = isPlainObject(existingTelemetry) ? existingTelemetry : {};
    config.telemetry = telemetry;

    telemetry.enabled = enabled;

    await atomicWriteJson(fs, path, config);
  });
}
