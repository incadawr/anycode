export { AgentLoop } from "./agent-loop.js";
export type { AgentLoopConfig, ContextInfo, ContextBreakdown } from "./agent-loop.js";
// Referenced by AgentLoopConfig.ceiling (TASK.124 cut-1), so it has to travel
// with it on the public surface.
export type { CeilingConfig, CeilingVerdict } from "./ceiling.js";
