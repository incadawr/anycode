import type { PermissionMode } from "@anycode/core";
import type { SessionEngine } from "./engines/session-engine.js";
import type { ChildSessionPort } from "./child-session-port.js";
import type { RuntimeOrchestrationComposition } from "./orchestration-policy.js";

/** Attach only after the runtime's Agent bridge and role routes are composed. */
export function bindRuntimeOrchestration(engine: SessionEngine, options: {
  ownerSessionId: string;
  port: Pick<ChildSessionPort,"hasRunningChildren" | "cancelAllBackgroundChildren">;
  baseMode(): PermissionMode;
  capture?(mode: PermissionMode): void;
  clear?(): void;
  cleanup?(): void;
}): RuntimeOrchestrationComposition {
  let disposed = false;
  const composition: RuntimeOrchestrationComposition = {
    ownerSessionId:options.ownerSessionId,
    ready:() => !disposed,
    baseMode:options.baseMode,
    hasRunningChildren:() => options.port.hasRunningChildren(),
    capture(mode) { if (disposed) throw new Error("Routing has been disposed"); options.capture?.(mode); },
    clear() { options.clear?.(); },
    cleanup() { if (disposed) return; disposed = true; try { options.port.cancelAllBackgroundChildren(); } finally { options.cleanup?.(); } },
  };
  Object.defineProperty(engine,"orchestrationComposition",{value:composition,configurable:true});
  Object.defineProperty(engine,"orchestrationCompositionReady",{get:composition.ready,configurable:true});
  const dispose = engine.dispose.bind(engine);
  engine.dispose = async reason => { try { composition.cleanup(); } finally { await dispose(reason); } };
  return composition;
}
