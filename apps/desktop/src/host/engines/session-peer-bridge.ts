import { createSessionPeerTools } from "@anycode/core";
import type { SessionPeersPort, SessionPeerAuthority, ToolContext, ToolResult } from "@anycode/core";
import type { IpcPermissionBroker } from "../permission-broker.js";

/** Native doors approve here; Core uses its dispatcher, never both gates. */
export function createSessionPeerBridge(deps: {
  port: SessionPeersPort;
  authority(): SessionPeerAuthority & { root: boolean };
  broker: Pick<IpcPermissionBroker, "requestPermission">;
  cwd: string;
}) {
  const tools = createSessionPeerTools(deps.authority);
  return {
    tools,
    async call(name: string, raw: unknown, signal: AbortSignal, toolCallId: string): Promise<ToolResult<unknown>> {
      const tool = tools.find(t => t.metadata.name === name);
      const state = deps.authority();
      if (!tool || !state.root || signal.aborted) return { ok: false, error: "Peer operation denied." };
      let parsed = tool.inputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "Invalid peer input." };
      const metadata = tool.resolveMetadata?.(parsed.data) ?? tool.metadata;
      if (!metadata.readOnly) {
        if (state.mode === "plan" && !state.orchestrate) return { ok: false, error: "Peer operation denied in plan mode." };
        if (state.mode !== "yolo" || state.orchestrate) {
          const decision = await deps.broker.requestPermission({ toolName: name, input: parsed.data,
            metadata, mode: state.mode, orchestrate: state.orchestrate, cwd: deps.cwd, toolCallId });
          if (decision.behavior !== "allow") return { ok: false, error: decision.reason };
          parsed = tool.inputSchema.safeParse(decision.updatedInput ?? parsed.data);
          if (!parsed.success) return { ok: false, error: "Invalid approved peer input." };
        }
      }
      const current = deps.authority();
      if (signal.aborted || !current.root || (!metadata.readOnly && current.mode === "plan" && !current.orchestrate))
        return { ok: false, error: "Peer operation denied." };
      return tool.handler(parsed.data, { sessionPeers: deps.port, abortSignal: signal, toolCallId, cwd: deps.cwd } as ToolContext);
    },
  };
}
