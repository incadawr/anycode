import assert from "node:assert/strict";
import { join } from "node:path";

/** Remove inherited application and platform profile overrides before assigning isolated paths. */
export function isolatedSmokeEnv(source, profile) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^ANYCODE_/i.test(key) || /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_.*|GIT_.*|NPM_CONFIG_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|BASH_ENV|ENV|ZDOTDIR|TMPDIR|TMP|TEMP|CODEX_.*|CLAUDE_.*|ELECTRON_.*|REMOTE_DEBUGGING_PORT)$/i.test(key)) delete env[key];
  }
  return {
    ...env,
    ...(source.ANYCODE_API_KEY ? { ANYCODE_API_KEY: source.ANYCODE_API_KEY } : {}),
    ...(source.ANYCODE_BASE_URL ? { ANYCODE_BASE_URL: source.ANYCODE_BASE_URL } : {}),
    TMPDIR: join(profile, "tmp"),
    TMP: join(profile, "tmp"),
    TEMP: join(profile, "tmp"),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: join(profile, "appdata"),
    LOCALAPPDATA: join(profile, "localappdata"),
    XDG_CONFIG_HOME: join(profile, "xdg-config"),
    XDG_DATA_HOME: join(profile, "xdg-data"),
    XDG_CACHE_HOME: join(profile, "xdg-cache"),
    XDG_STATE_HOME: join(profile, "xdg-state"),
    ANYCODE_MCP_IMPORT_HOME: profile,
    ANYCODE_SKILLS_IMPORT_HOME: profile,
    ANYCODE_SUBAGENTS_HOME: profile,
    ANYCODE_PROFILE_HOME: profile,
    ANYCODE_CODEX_PROFILES_HOME: join(profile, "codex-profiles"),
    ANYCODE_TELEMETRY_DIR: join(profile, "telemetry"),
  };
}

/** Launch through the exact environment used by the smoke. */
export function launchReloadSmoke(spawn, source, profile, workspace, port, unavailableEngine) {
  return spawn("pnpm", ["--filter", "@anycode/desktop", "dev"], {
    env: {
      ...isolatedSmokeEnv(source, profile),
      ANYCODE_AUTOMATION: "1", ANYCODE_WORKSPACE: workspace,
      REMOTE_DEBUGGING_PORT: String(port),
      ANYCODE_USER_DATA_DIR: join(profile, "user-data"),
      ANYCODE_DB_PATH: join(profile, "db.sqlite"),
      ANYCODE_AUTOMATION_INFO: join(profile, "automation.json"),
      ANYCODE_SETTINGS_PATH: join(profile, "settings.json"),
      ANYCODE_SECRETS_PATH: join(profile, "secrets.json"),
      ANYCODE_CODEX_BIN: unavailableEngine, ANYCODE_CLAUDE_BIN: unavailableEngine,
      CODEX_HOME: join(profile, "codex-home"), CLAUDE_CONFIG_DIR: join(profile, "claude-home"),
    },
    stdio: ["ignore", "inherit", "inherit"], detached: true,
  });
}

/** Runs in the renderer via CDP; include the collapsed stack's root anchor. */
export function readGroupDom() {
  return [...document.querySelectorAll('.agent-message-stack')].map((group) => ({
    expanded: group.querySelector('.agent-message-stack-toggle')?.getAttribute('aria-expanded') === 'true',
    header: group.querySelector('.agent-message-stack-name')?.textContent ?? null,
    preview: group.querySelector('.agent-message-preview')?.textContent ?? null,
    blockIds: [group, ...group.querySelectorAll('[data-block-id]')]
      .filter((node) => node.hasAttribute('data-block-id'))
      .map((node) => node.getAttribute('data-block-id')),
  }));
}

/** Check only values actually present in the before and after renderer snapshots. */
export function assertReloadSnapshot(before, after) {
  assert.equal(after.tabs.length, before.tabs.length, "Open session count changed across reload");
  for (const original of before.tabs) {
    const restored = after.tabs.find((tab) => tab.tabId === original.tabId);
    assert(restored, `Tab ${original.tabId} disappeared across reload`);
    assert.equal(restored.sessionId, original.sessionId, `Session changed for ${original.tabId}`);
    assert.equal(restored.title ?? null, original.title ?? null, `Title changed for ${original.tabId}`);
    assert.equal(after.states[original.tabId]?.connection, "ready", `Session ${original.tabId} did not reconnect`);
  }
}
