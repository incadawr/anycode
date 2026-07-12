/**
 * Workflow module barrel (Phase 3 slice 3.4). template.ts is a full util
 * (task 3.4.1); engine.ts is filled by task 3.4.2; schema/discovery/prompt-section
 * are filled by task 3.4.3. The WorkflowPort/WorkflowMeta/WorkflowDefinition types
 * live on ports/ and flow through the ports barrel — they are intentionally NOT
 * re-exported here (mirror of skills/index.ts).
 */

export { scanTemplateRefs, renderTemplate } from "./template.js";
export type { TemplateRefs } from "./template.js";
export { createWorkflowRunner, withWorkflows } from "./engine.js";
export { discoverWorkflows } from "./discovery.js";
export type { WorkflowDiscoveryResult, WorkflowRoot } from "./discovery.js";
export { parseWorkflowDefinition } from "./schema.js";
export type { WorkflowParseContext, WorkflowParseResult } from "./schema.js";
export { buildWorkflowsPromptSection } from "./prompt-section.js";
