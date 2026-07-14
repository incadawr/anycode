/**
 * SkillPort (Phase 3 slice 3.3, design §2.1). Skills are discovered SKILL.md
 * files: their metadata (name + description) is advertised in a capped
 * system-prompt section, and the body is loaded LAZILY by name through the
 * Skill tool. Exposed as a PORT so the Skill tool (tools/, a layer below the
 * discovery/wiring) reaches the discovery snapshot without importing it;
 * absence of the port in a ToolContext is the fail-closed lock (the Skill tool
 * returns an "unavailable" error-outcome, exactly like Agent without a
 * SubagentPort).
 */

/** One discovered skill's advertised metadata (body is loaded lazily). */
export interface SkillMeta {
  /** Unique post-dedupe name, ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ */
  name: string;
  /** Frontmatter description, capped at SKILL_DESCRIPTION_MAX_CHARS. */
  description: string;
  /** "project" | "user" | "plugin:<pluginName>" | "builtin" (data, not a closed union). */
  source: string;
  /** Absolute SKILL.md path, or a `builtin://...` URI for an in-memory skill. */
  path: string;
}

export interface LoadedSkill {
  meta: SkillMeta;
  /** Skill body (frontmatter stripped), capped at SKILL_BODY_MAX_BYTES (UTF-8 safe). */
  body: string;
  truncated: boolean;
}

export interface SkillPort {
  /** Boot-time discovery snapshot (static for the session, mirrors the MCP registry ruling). */
  list(): SkillMeta[];
  /** Lazy body load by name; fresh read every call; undefined for an unknown name. */
  load(name: string): Promise<LoadedSkill | undefined>;
}
