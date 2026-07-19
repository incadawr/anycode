/**
 * Whether a spawned `claude` child gets an explicit `CLAUDE_CONFIG_DIR`, and to
 * what — the single resolver every spawn site (doctor, engine, login) goes
 * through, so they can never disagree about which profile they are talking to.
 *
 * Ambient is the product default (owner pivot from live dogfood): Claude Code
 * binds OAuth credentials to the config dir, so an isolated AnyCode profile is
 * signed OUT even while the user's own terminal (`~/.claude`) is signed IN.
 * "Use my Claude subscription" means the user's EXISTING login, so by default
 * no `CLAUDE_CONFIG_DIR` is set at all and the CLI resolves its own ambient
 * `~/.claude` exactly like a terminal invocation would. A non-blank `override`
 * keeps the isolated-profile capability available as an explicit opt-in.
 */
export function resolveClaudeConfigDir(override?: string): string | undefined {
  if (override === undefined) return undefined;
  const trimmed = override.trim();
  return trimmed === "" ? undefined : trimmed;
}
