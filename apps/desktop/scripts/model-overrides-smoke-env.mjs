import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function buildSmokeEnv(parent, profile, port, binary) {
  const env = {
    ...Object.fromEntries(["TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(key => parent[key] !== undefined).map(key => [key, parent[key]])),
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(process.execPath)}`,
    ANYCODE_AUTOMATION: "1", ANYCODE_ISOLATED_SMOKE: "1", ANYCODE_ISOLATED_ROOT: profile, ANYCODE_EXPECTED_DESKTOP_ROOT: resolve(dirname(fileURLToPath(import.meta.url)), ".."), ANYCODE_SMOKE_IDENTITY: randomUUID(), ANYCODE_SUBAGENTS_HOME: profile, ANYCODE_PROFILE_HOME: profile, ANYCODE_CODEX_PROFILES_HOME: profile, ANYCODE_MCP_IMPORT_HOME: profile, ANYCODE_SKILLS_IMPORT_HOME: profile, ANYCODE_TELEMETRY_DIR: join(profile, "telemetry"), REMOTE_DEBUGGING_PORT: String(port),
    ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
    ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
    ANYCODE_CODEX_BIN: binary, ANYCODE_CLAUDE_BIN: binary,
    CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
  };
  for (const key of ["ANYCODE_API_KEY", "ANYCODE_MODEL", "ANYCODE_BASE_URL", "ANYCODE_PROVIDER", "ANYCODE_TRANSPORT", "ANYCODE_REASONING_EFFORT", "ANYCODE_EFFORT_LEVELS", "ANYCODE_CONTEXT_WINDOW", "ANYCODE_CONTEXT_WINDOW_MODEL"]) delete env[key];
  return env;
}
