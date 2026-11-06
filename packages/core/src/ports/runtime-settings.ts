import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(128);
const common = { version: z.literal(1), model: name, effort: z.string().optional() };
/** Only policy facts and digests cross the persistence boundary; never resolved configuration. */
export const runtimeNativeBaseSchema = z.discriminatedUnion("engine", [
  z.object({ ...common, engine: z.literal("claude"), preset: z.enum(["read-only", "ask", "workspace"]),
    permissionMode: z.enum(["plan", "default", "acceptEdits"]), mcpDigest: digest, tools: z.array(name).max(512) }).strict()
    .refine(base => ({ "read-only": "plan", ask: "default", workspace: "acceptEdits" })[base.preset] === base.permissionMode, "Preset and native mode disagree"),
  z.object({ ...common, engine: z.literal("codex"), preset: z.enum(["read-only", "ask", "approve-for-me", "full-access", "child-ask"]), configDigest: digest }).strict(),
]);
export type RuntimeNativeBase = z.infer<typeof runtimeNativeBaseSchema>;
export const runtimeSettingsSchema = z.object({
  model: name, mode: name, effort: z.string().optional(), fast: z.boolean().optional(),
  orchestration: z.object({ enabled: z.literal(true), baseMode: z.enum(["plan", "build", "edit", "auto", "yolo"]),
    nativeBase: runtimeNativeBaseSchema.optional() }).strict().optional(),
}).strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export function checkedRuntimeSettings(value: RuntimeSettings, engine: string): RuntimeSettings {
  const settings = runtimeSettingsSchema.parse(value);
  if (settings.orchestration?.nativeBase && settings.orchestration.nativeBase.engine !== engine) throw new Error("Native base engine mismatch");
  return settings;
}
