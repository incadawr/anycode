import { readFileSync } from "node:fs";
import { parseSettings } from "../settings/schema.js";
import { resolveProfileRoles } from "../shared/role-profiles.js";
import type { AnycodeSettings } from "../shared/settings.js";

/** Read the main process's settings file each time a role route is resolved. */
export function readRoleSettings(path: string, projectRoot: string): AnycodeSettings["roles"] {
  try {
    const parsed = parseSettings(JSON.parse(readFileSync(path, "utf8")));
    return parsed.status === "ok" ? resolveProfileRoles(parsed.settings, projectRoot) : undefined;
  } catch {
    return undefined;
  }
}
