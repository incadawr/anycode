/** Isolate all home-based discovery in the smoke's main and host processes. */
export function isolatedSmokeHome(env, home) {
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ANYCODE_")));
  return {
    ...cleanEnv,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    XDG_STATE_HOME: home,
    ANYCODE_PROFILE_HOME: home,
    ANYCODE_MCP_IMPORT_HOME: home,
    ANYCODE_SKILLS_IMPORT_HOME: home,
    ANYCODE_SUBAGENTS_HOME: home,
    ANYCODE_CODEX_PROFILES_HOME: home,
  };
}
