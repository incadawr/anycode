import { z } from "zod";
import type { PermissionMode } from "../types/permissions.js";
import type { AnyToolDefinition } from "../types/tools.js";

const id = z.string().min(1).max(200);
const payload = z.string().min(1).max(32000);
const reply = z.enum(["explicit", "on_turn_end"]);

/** Tool data only. Identity, generation and causal authority belong to main. */
export const sessionPeerRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    requestId: id,
    operation: z.literal("list"),
    input: z.strictObject({
      cursor: id.optional(), limit: z.number().int().min(1).max(50).optional(),
      scope: z.enum(["workspace", "granted"]).optional(), ownMessageId: id.optional(),
    }),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("open"),
    input: z.strictObject({
      workspace: z.string().min(1).max(4096).optional(),
      engine: z.enum(["core", "claude", "codex"]).optional(),
      model: id.optional(), effort: id.optional(), handle: id.optional(),
      firstMessage: payload.optional(), reply: reply.optional(),
    }),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("send"),
    input: z.strictObject({
      sessionId: id.optional(), payload,
      mode: z.enum(["next_turn", "steer"]).optional(),
      idempotencyKey: id.optional(), correlationId: id.optional(), replyTo: id.optional(),
      reply: reply.optional(),
    }).refine(input => input.sessionId !== undefined || input.replyTo !== undefined),
  }),
  z.strictObject({
    requestId: id,
    operation: z.literal("who_edits"),
    input: z.strictObject({ path: z.string().min(1).max(4096) }),
  }),
]);

export type SessionPeerRequest = z.infer<typeof sessionPeerRequestSchema>;

/** Parsing is structural only; it never grants workspace or reply access. */
export function parseSessionPeerRequest(value: unknown): SessionPeerRequest | null {
  const parsed = sessionPeerRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const peerSummary = z.strictObject({
  sessionId: id, tabId: id, workspace: z.string().max(4096),
  engine: z.enum(["core", "claude", "codex"]),
  activity: z.enum(["idle", "running", "waiting_approval", "waiting_network", "closing"]),
  addressable: z.boolean(), title: z.string().max(200).optional(),
  recentPaths: z.array(z.string().min(1).max(4096)).max(5).optional(),
  model: z.string().max(200).optional(), effort: z.string().max(200).optional(),
});
const fileEvidence = z.strictObject({
  sessionId: id, evidence: z.literal("reported_write"),
  toolName: z.enum(["Edit", "Write", "NotebookEdit"]), at: z.number().finite(),
});
const shellCandidate = z.strictObject({
  sessionId: id, evidence: z.literal("observed_during_shell"), confidence: z.literal("candidate"),
  toolName: z.literal("Bash"), at: z.number().finite(),
  interval: z.strictObject({ start: z.number().finite(), end: z.number().finite() }),
});
const sampler = z.strictObject({ coverage: z.enum(["complete", "partial", "unknown"]),
  baselineCoverage: z.enum(["complete", "partial", "unknown"]), freshness: z.enum(["fresh", "stale"]) });
const deliveryReceipt = z.strictObject({ state: z.enum(["queued", "acknowledged", "rejected", "unknown"]), messageId: id.optional() });
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("file_activity"), path: z.string().min(1).max(4096),
    candidates: z.array(shellCandidate).max(20), sampler,
    records: z.array(fileEvidence).max(20), coverage: z.literal("partial"),
    startsAt: z.number().finite(), limitations: z.string().min(1).max(2000),
  }),
  z.strictObject({ status: z.literal("opened"), sessionId: id, tabId: id, label: id.optional(), delivery: deliveryReceipt.optional() }),
  z.strictObject({ status: z.literal("sent"), messageId: id, state: z.enum(["queued", "acknowledged", "rejected", "unknown"]) }),
  z.strictObject({ status: z.literal("ok"), sessions: z.array(peerSummary).max(50) }),
  z.strictObject({ status: z.literal("refused"), reason: z.literal("loop_limited").optional() }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("steer_unsupported").optional(), detail: z.string().min(1).max(2000).optional() }),
  z.strictObject({ status: z.literal("unknown"), sessionId: id.optional(), tabId: id.optional() }),
]);
export type SessionPeerResponse = z.infer<typeof responseSchema>;
export type SessionPeerCall = SessionPeerRequest extends infer R
  ? R extends SessionPeerRequest ? Omit<R, "requestId"> : never : never;
export function parseSessionPeerResponse(value: unknown): SessionPeerResponse {
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "unknown" };
}

export interface SessionPeerAuthority { mode: PermissionMode; orchestrate?: boolean }
const names = ["SessionsList", "SessionOpen", "SessionSend", "WhoEdits"] as const;
/** Shared declarations and handlers for Core and both native engine doors. */
export function createSessionPeerTools(authority: () => SessionPeerAuthority): AnyToolDefinition[] {
  return sessionPeerRequestSchema.options.map((schema, index) => {
    const readOnly = index === 0 || index === 3;
    const metadata = {
      name: names[index]!, description: ["List accessible peer sessions.", "Open a peer root session.",
        "Send a peer message without waiting for its answer.", "Look up exact workspace file activity with evidence and coverage limits. Empty records do not prove no writers."][index]!,
      readOnly, destructive: false, concurrentSafe: readOnly, riskLevel: readOnly ? "low" as const : "high" as const,
      sideEffectScope: readOnly ? "none" as const : "network" as const,
      needsApproval: !readOnly, timeoutMs: 20_000, maxOutputBytes: 100000,
    };
    return {
      metadata, inputSchema: schema.shape.input,
      rawInputJsonSchema: { ...z.toJSONSchema(schema.shape.input), ...(index === 2
        ? { anyOf: [{ required: ["sessionId"] }, { required: ["replyTo"] }] } : {}) },
      resolveMetadata: () => {
        const state = authority();
        return { ...metadata, mandatoryApproval: !readOnly && (state.mode !== "yolo" || state.orchestrate === true) };
      },
      handler: async (input, ctx) => {
        if (!ctx.sessionPeers) return { ok: false, error: "Peer sessions unavailable." };
        const call = parseSessionPeerRequest({ requestId: "tool", operation: schema.shape.operation.value, input });
        if (!call) return { ok: false, error: "Invalid peer input." };
        const { requestId: _, ...data } = call;
        return { ok: true, output: await ctx.sessionPeers.request(data, ctx.abortSignal) };
      },
    } as AnyToolDefinition;
  });
}
