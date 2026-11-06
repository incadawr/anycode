import { engineSwitchTargetSchema, type EngineSwitchTarget } from "../shared/protocol.js";

/** All configuration is supplied by main-owned resolvers, never by the renderer. */
export interface EngineSwitchResolutionDeps<Config> {
  ready(target: EngineSwitchTarget): Promise<boolean>;
  resolve(target: EngineSwitchTarget): Promise<Config | undefined>;
}

export type EngineSwitchResolution<Config> =
  | { ok: true; target: EngineSwitchTarget; config: Config }
  | { ok: false; reason: "invalid_target" | "not_ready" };

/** Validate the untrusted selection before consulting any privileged resolver. */
export async function resolveEngineSwitchTarget<Config>(
  selection: unknown,
  deps: EngineSwitchResolutionDeps<Config>,
): Promise<EngineSwitchResolution<Config>> {
  const parsed = engineSwitchTargetSchema.safeParse(selection);
  if (!parsed.success) return { ok: false, reason: "invalid_target" };
  try {
    if (!(await deps.ready(parsed.data))) return { ok: false, reason: "not_ready" };
    const config = await deps.resolve(parsed.data);
    if (config === undefined) return { ok: false, reason: "not_ready" };
    return { ok: true, target: parsed.data, config };
  } catch {
    return { ok: false, reason: "not_ready" };
  }
}
