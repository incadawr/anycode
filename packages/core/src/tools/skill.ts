/**
 * Skill tool (Phase 3 slice 3.3, design §2.7/§3.4): loads the full body of a
 * discovered skill by name via ctx.skills (a SkillPort) and returns it as a
 * normal tool result. Read-only — a skill is instructions, not an effect, so the
 * effect rubicon stays on the effectful tools the model runs AFTER reading it.
 *
 * The port is populated by the discovery/wiring layer (task 3.3.2 + the
 * extensions bootstrap); this handler only consumes the frozen SkillPort
 * contract. Absence of the port is the fail-closed lock (mirror of Agent without
 * a SubagentPort). The handler never throws — every path is a ToolResult.
 */

import type { ToolDefinition, ToolMetadata } from "../types/tools.js";
import { SKILL_BODY_MAX_BYTES } from "../types/config.js";
import { skillInputSchema, type SkillInput, type SkillOutput } from "./schemas.js";

/** Bodies are already discovered/capped; the load is a single fresh file read. */
const SKILL_TIMEOUT_MS = 30_000;

const metadata: ToolMetadata = {
  name: "Skill",
  description:
    "Load the full instructions of a named skill discovered from the workspace and user configuration.",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: SKILL_TIMEOUT_MS,
  maxOutputBytes: SKILL_BODY_MAX_BYTES,
};

export const skillTool: ToolDefinition<SkillInput, SkillOutput> = {
  metadata,
  inputSchema: skillInputSchema,
  handler: async (input, ctx) => {
    // Fail-closed lock (design §3.4): no port => skills are unavailable, exactly
    // like the Agent tool without a SubagentPort.
    if (!ctx.skills) {
      return { ok: false, error: "Skill: skills are unavailable in this context." };
    }

    // Load ONLY by discovery-snapshot key — the model supplies no paths, so
    // there is no path-traversal surface. A vanished/unknown name is a
    // handler-level invalid_input carrying the available names.
    const loaded = await ctx.skills.load(input.name);
    if (!loaded) {
      const available = ctx.skills.list().map((meta) => meta.name);
      return {
        ok: false,
        errorKind: "invalid_input",
        error:
          available.length > 0
            ? `Unknown skill "${input.name}". Available skills: ${available.join(", ")}.`
            : `Unknown skill "${input.name}". No skills are available.`,
      };
    }

    return {
      ok: true,
      output: {
        name: loaded.meta.name,
        source: loaded.meta.source,
        body: loaded.body,
        truncated: loaded.truncated,
      },
    };
  },
  formatResultForModel: (result) => {
    if (!result.ok) {
      return result.error ?? "Skill: failed to load the skill.";
    }
    const output = result.output;
    if (!output) {
      return "";
    }
    return output.truncated
      ? `${output.body}\n[skill body truncated at ${SKILL_BODY_MAX_BYTES} bytes]`
      : output.body;
  },
};
