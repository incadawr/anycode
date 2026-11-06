import { z } from "zod";
import type { HistoryItem, RuntimeSwitchCommit } from "@anycode/core";
import { engineSwitchTargetSchema, type EngineSwitchTarget } from "./protocol.js";

export const ENGINE_SWITCH_CONTROL = "anycode:engine-switch";
export const ENGINE_SWITCH_RESPONSE = "anycode:engine-switch-response";
const correlation = { requestId: z.string().min(1).max(128), generation: z.number().int().positive() };
const settings = z.object({model:z.string().min(1).max(128),mode:z.string().min(1).max(128),effort:z.string().optional(),fast:z.boolean().optional(),orchestration:z.object({enabled:z.literal(true),baseMode:z.enum(["plan","build","edit","auto","yolo"])}).strict().optional()}).strict();
export const runtimeSwitchCommitSchema: z.ZodType<RuntimeSwitchCommit> = z.object({
  expectedRevision:z.number().int().nonnegative(),sourceSegmentId:z.string().min(1).max(128),
  segment:z.object({id:z.string().min(1).max(128),engine:z.enum(["core","codex","claude"]),connectionId:z.string().optional(),profileId:z.string().optional(),accountScope:z.string(),nativeRef:z.string().optional(),nativeState:z.enum(["fresh","materialized"]),selected:settings,applied:settings,startedAt:z.number(),coverage:z.literal("available_history")}).strict(),
  sourceItems:z.array(z.custom<HistoryItem>(value => {
    if (value === null || typeof value !== "object") return false;
    const item = value as Partial<HistoryItem>;
    return typeof item.id === "string" && typeof item.createdAt === "number" && item.message !== null && typeof item.message === "object";
  })),
  boundary:z.object({id:z.string(),segmentId:z.string(),afterItemId:z.string().optional(),text:z.string(),createdAt:z.number()}).strict(),
  handoff:z.object({id:z.string(),segmentId:z.string(),sourceWatermark:z.string().nullable(),payload:z.string(),digest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(["pending","dispatching","accepted","uncertain"]),turnId:z.string().optional(),originalText:z.string().optional(),injectedText:z.string().optional()}).strict(),
}).strict();
export const engineSwitchControlSchema = z.discriminatedUnion("phase", [
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("prepare"), target: engineSwitchTargetSchema }).strict(),
  z.object({ type: z.literal(ENGINE_SWITCH_CONTROL), ...correlation, phase: z.literal("commit"), identity: z.object({ model: z.string().min(1).max(128), mode: z.string().min(1).max(128), externalSessionRef: z.string().min(1).max(512).optional(), runtime: runtimeSwitchCommitSchema.optional() }).strict() }).strict(),
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
