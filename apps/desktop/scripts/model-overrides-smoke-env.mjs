import { join } from "node:path";

export function buildSmokeEnv(parent, profile, port, binary) {
  const env = {
    ...parent,
    ANYCODE_AUTOMATION: "1", ANYCODE_SUBAGENTS_HOME: profile, REMOTE_DEBUGGING_PORT: String(port),
    ANYCODE_USER_DATA_DIR: join(profile, "user-data"), ANYCODE_DB_PATH: join(profile, "db.sqlite"),
    ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
    ANYCODE_SETTINGS_PATH: join(profile, "settings.json"), ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
    ANYCODE_CODEX_BIN: binary, ANYCODE_CLAUDE_BIN: binary,
    CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
  };
  for (const key of ["ANYCODE_API_KEY", "ANYCODE_MODEL", "ANYCODE_BASE_URL", "ANYCODE_PROVIDER", "ANYCODE_TRANSPORT", "ANYCODE_REASONING_EFFORT", "ANYCODE_EFFORT_LEVELS", "ANYCODE_CONTEXT_WINDOW", "ANYCODE_CONTEXT_WINDOW_MODEL"]) delete env[key];
  return env;
}
