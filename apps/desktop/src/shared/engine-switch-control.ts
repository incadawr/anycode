import { z } from "zod";
import { engineSwitchTargetSchema, type EngineSwitchTarget } from "./protocol.js";

export const ENGINE_SWITCH_CONTROL = "anycode:engine-switch";
export const ENGINE_SWITCH_RESPONSE = "anycode:engine-switch-response";
const correlation = { requestId: z.string().min(1).max(128), generation: z.number().int().positive() };
export const engineSwitchControlSchema = z.discriminatedUnion("phase", [
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("prepare"), target: engineSwitchTargetSchema }).strict(),
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("commit"), identity: z.object({ model: z.string().min(1).max(128), mode: z.string().min(1).max(128), externalSessionRef: z.string().min(1).max(512).optional() }).strict() }).strict(),
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("status") }).strict(),
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("abort") }).strict(),
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("retire") }).strict(),
]);
export type EngineSwitchControl = z.infer<typeof engineSwitchControlSchema>;
export type EngineSwitchIdentity = Extract<EngineSwitchControl, { phase: "commit" }>["identity"];
/** Only the authenticated parentPort may carry credentials and resolved paths. */
export interface EngineSwitchLaunch {
  target: EngineSwitchTarget;
  env: NodeJS.ProcessEnv;
  codexProfile?: { id?: string; home?: string; authLink?: string };
}
export interface EngineSwitchResponse {
  type: typeof ENGINE_SWITCH_RESPONSE;
  requestId: string;
  generation: number;
  phase: EngineSwitchControl["phase"];
  ok: boolean;
  reason?: string;
  launch?: EngineSwitchLaunch;
}
