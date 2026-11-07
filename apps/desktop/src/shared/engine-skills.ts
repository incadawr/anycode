/** App-owned catalog, independent of filesystem discovery and Native overrides.
 * skills.disabled uses the source id for both aliases. File skills with the
 * same source name do not replace this catalog in external engine tabs.
 */
export const ENGINE_BUILTIN_SKILLS = [
  {
    id: "anycode-setup",
    claude: "anycode-app:anycode-setup",
    codex: "anycode-app-setup",
    description: "Help configure AnyCode using its documentation and approved tools.",
  },
  {
    id: "using-browser-preview",
    claude: "anycode-app:using-browser-preview",
    codex: "anycode-app-browser-preview",
    description: "Inspect local pages with the AnyCode browser preview.",
  },
  {
    id: "control-browser",
    claude: "anycode-app:control-browser",
    codex: "anycode-app-control-browser",
    description: "Navigate and interact with the AnyCode browser preview.",
  },
] as const;

export type EngineBuiltinSkillId = (typeof ENGINE_BUILTIN_SKILLS)[number]["id"];
export type BuiltinSkillEngine = "claude" | "codex";
/** CLI-reported means metadata recognition, not proof of model use. */
export const ENGINE_SKILL_STATUSES = ["prepared", "cli-reported", "unavailable"] as const;
export type EngineSkillStatus = (typeof ENGINE_SKILL_STATUSES)[number];
